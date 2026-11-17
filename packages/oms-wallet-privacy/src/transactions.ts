import type { Address, Hex } from 'viem';

import { getAddress, isAddress, isAddressEqual, zeroAddress } from 'viem';

import type {
  FeeOptionSelection,
  FeeOptionSelector,
  FeeOptionWithBalance,
  Network,
  OMSWallet,
  SendTransactionResponse
} from '@polygonlabs/oms-wallet';

import type { createDepositGuard, WalletCall } from './guard.js';
import type {
  DepositOptions,
  NetworkFee,
  PrivacyProgressEvent,
  PrivacyTransaction,
  PrivacyTransactionStep
} from './types.js';

import { OMSWalletPrivacyError } from './errors.js';
import { PolicyViolation } from './guard.js';
import { requireActive } from './session.js';

type DepositGuard = ReturnType<typeof createDepositGuard>;

/**
 * Sends the wallet transactions of one deposit operation through the guard, reports progress, and
 * keeps every transaction ID so a failure can say what was already sent.
 */
export class DepositRun {
  readonly txnIds: string[] = [];
  readonly transactions: PrivacyTransaction[] = [];
  /** The first error this run threw; kept because the privacy backend may replace it. */
  failure: OMSWalletPrivacyError | undefined;

  constructor(
    private readonly oms: OMSWallet,
    private readonly params: {
      operation: string;
      network: Network;
      wallet: Address;
      /** The moved token; `zeroAddress` for native. */
      token: Address;
      /** What must stay available in the moved token besides the network fee. */
      total: bigint;
      guard: DepositGuard;
      options: DepositOptions;
    }
  ) {}

  /** The steps that executed so far. */
  get confirmedSteps(): ReadonlyArray<PrivacyTransactionStep> {
    return this.transactions.map((transaction) => transaction.step);
  }

  emit(event: PrivacyProgressEvent): void {
    try {
      this.params.options.onProgress?.(event);
    } catch {
      // Progress callbacks cannot affect the operation.
    }
  }

  error(
    params: Omit<ConstructorParameters<typeof OMSWalletPrivacyError>[0], 'operation' | 'txnIds'>
  ): OMSWalletPrivacyError {
    const error = new OMSWalletPrivacyError({
      ...params,
      operation: this.params.operation,
      txnIds: this.txnIds
    });
    this.failure ??= error;
    return error;
  }

  /** Sends `call` if the guard allows it and returns its on-chain hash once it executed. */
  async send(call: Omit<WalletCall, 'chainId'>): Promise<Hex> {
    const { network, wallet, guard } = this.params;
    let step: PrivacyTransactionStep;
    try {
      step = guard.authorize({ ...call, chainId: network.id });
    } catch (error) {
      throw this.error({
        code: 'OMS_PRIVACY_UNAUTHORIZED_TRANSACTION',
        message: `A wallet transaction outside this operation was refused: ${
          error instanceof PolicyViolation ? error.message : 'unknown call.'
        }`
      });
    }

    let txnId: string | undefined;
    let networkFee: NetworkFee | undefined;
    let feeFailure: OMSWalletPrivacyError | undefined;
    const selectFeeOption = this.feeSelector(
      step,
      (fee) => (networkFee = fee),
      (error) => (feeFailure = error)
    );

    let response: SendTransactionResponse;
    try {
      requireActive(this.oms, wallet, this.params.operation);
    } catch {
      throw this.error({
        code: 'OMS_PRIVACY_WALLET_CHANGED',
        stage: step,
        message: 'The active wallet changed.'
      });
    }
    try {
      response = await this.oms.wallet.sendTransaction({
        network,
        to: call.to,
        data: call.data,
        value: call.value,
        selectFeeOption,
        waitForStatus: true,
        onPrepared: (id) => {
          txnId = id;
          this.txnIds.push(id);
          this.emit({ step, state: 'prepared', txnId: id });
        }
      });
    } catch (error) {
      if (feeFailure) {
        throw this.error({ code: feeFailure.code, stage: step, message: feeFailure.message });
      }
      if (txnId === undefined) {
        const changed = !isAddressEqual(this.activeAddress() ?? zeroAddress, wallet);
        throw this.error({
          code: changed ? 'OMS_PRIVACY_WALLET_CHANGED' : 'OMS_PRIVACY_WALLET_ERROR',
          stage: step,
          message: changed
            ? 'The active wallet changed.'
            : `The wallet could not send the ${step} transaction; see cause.`,
          cause: error
        });
      }
      guard.record(step);
      throw this.error({
        code: 'OMS_PRIVACY_TRANSACTION_FAILED',
        stage: step,
        message: `The ${step} transaction ${txnId} may not have executed; check its status.`,
        cause: error
      });
    }
    guard.record(step);

    const txnHash = response.txnHash;
    if (response.status !== 'executed' || !txnHash) {
      throw this.error({
        code: 'OMS_PRIVACY_TRANSACTION_FAILED',
        stage: step,
        txnHash: txnHash as Hex | undefined,
        message: `The ${step} transaction ${response.txnId} is ${response.status}.`
      });
    }
    this.transactions.push(
      Object.freeze({ step, response, ...(networkFee ? { networkFee } : {}) })
    );
    this.emit({
      step,
      state: 'confirmed',
      txnId: response.txnId,
      txnHash: txnHash as Hex,
      ...(networkFee ? { networkFee } : {})
    });
    return txnHash as Hex;
  }

  private activeAddress(): Address | undefined {
    const active = this.oms.wallet.activeWallet;
    return active?.type === 'ethereum' && isAddress(active.address) ? active.address : undefined;
  }

  /**
   * Picks the network fee: the caller's selector, or by default the moved token when the wallet
   * can pay it on top of `total`. Reports what was picked and enforces `maxNetworkFee`.
   */
  private feeSelector(
    step: PrivacyTransactionStep,
    onFee: (fee: NetworkFee) => void,
    onFailure: (error: OMSWalletPrivacyError) => void
  ): FeeOptionSelector {
    const { options, token, total, operation } = this.params;
    const fail = (message: string): never => {
      const error = new OMSWalletPrivacyError({
        code: 'OMS_PRIVACY_NETWORK_FEE',
        operation,
        stage: step,
        message
      });
      onFailure(error);
      throw error;
    };
    const isMovedToken = (option: FeeOptionWithBalance) => {
      const address = feeTokenAddress(option);
      return address !== undefined && isAddressEqual(address, token);
    };

    return async (feeOptions) => {
      if (feeOptions.length === 0) {
        // Sponsored: nothing to pay.
        await options.selectFeeOption?.(feeOptions);
        return undefined;
      }
      let selection: FeeOptionSelection | undefined;
      if (options.selectFeeOption) {
        selection = await options.selectFeeOption(feeOptions);
      } else {
        const option = feeOptions.find(
          (candidate) =>
            isMovedToken(candidate) &&
            candidate.availableRaw !== undefined &&
            BigInt(candidate.availableRaw) >= BigInt(candidate.feeOption.value) + total
        );
        if (!option) {
          fail(
            'The network fee cannot be paid in the token being moved on top of the quoted total. ' +
              'Pass selectFeeOption to pay it in another token.'
          );
        }
        selection = option!.selection;
      }
      if (selection === undefined) return undefined;

      const chosen = feeOptions.find((option) => sameSelection(option.selection, selection));
      const feeToken = chosen && feeTokenAddress(chosen);
      if (chosen && feeToken) {
        const fee = { token: feeToken, amount: BigInt(chosen.feeOption.value) };
        if (
          options.maxNetworkFee !== undefined &&
          isMovedToken(chosen) &&
          fee.amount > options.maxNetworkFee
        ) {
          fail('The network fee is above maxNetworkFee.');
        }
        onFee(Object.freeze(fee));
      }
      return selection;
    };
  }
}

function sameSelection(a: FeeOptionSelection, b: FeeOptionSelection): boolean {
  return a.token === b.token && (b.index === undefined || a.index === b.index);
}

/** The fee token's address, `zeroAddress` for the native token, or undefined if unknown. */
function feeTokenAddress(option: FeeOptionWithBalance): Address | undefined {
  const token = option.feeOption.token;
  if (token.type.toLowerCase() === 'native' || !token.contractAddress) return zeroAddress;
  return isAddress(token.contractAddress) ? getAddress(token.contractAddress) : undefined;
}
