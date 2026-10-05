import type { Abi, Address, ContractFunctionName, EncodeFunctionDataParameters, Hex } from 'viem';

import type { TokenBalance } from '../clients/indexerClient.js';
import type { Network, SolanaNetwork, TronNetwork } from '../networks.js';
import type {
  AbiArg,
  FeeOption,
  FeeOptionSelection,
  TransactionMode,
  TransactionStatus
} from './waas.js';

export type FeeOptionWithBalance = {
  feeOption: FeeOption;
  selection: FeeOptionSelection;
  balance?: TokenBalance;
  available?: string;
  availableRaw?: string;
  decimals?: number;
};

export interface FeeOptionSelector {
  /**
   * Sponsored transactions pass an empty array. Resolving acknowledges the free fee;
   * throw or reject to stop execution.
   */
  (
    feeOptions: FeeOptionWithBalance[]
  ): FeeOptionSelection | undefined | Promise<FeeOptionSelection | undefined>;
}

// Intentional: merges a `firstAvailable` static onto the FeeOptionSelector function-type name
// (public API). Kept until a non-breaking refactor; see the type+const alternative in review notes.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace FeeOptionSelector {
  export const firstAvailable: FeeOptionSelector = (feeOptions) =>
    feeOptions.find(canPayFeeOption)?.selection;
}

export function feeOptionSelection(feeOption: FeeOption, index?: number): FeeOptionSelection {
  const tokenIdentifier = feeOption.token.tokenID?.trim();
  return {
    token: tokenIdentifier && tokenIdentifier.length > 0 ? tokenIdentifier : feeOption.token.symbol,
    ...(index === undefined ? {} : { index })
  };
}

function canPayFeeOption(option: FeeOptionWithBalance): boolean {
  if (option.availableRaw === undefined) {
    return false;
  }

  try {
    return BigInt(option.availableRaw) >= BigInt(option.feeOption.value);
  } catch {
    return false;
  }
}

export type SendTransactionResponse = {
  txnId: string;
  status: TransactionStatus;
  txnHash?: string;
  statusResolution: 'not-requested' | 'resolved' | 'timed-out';
};

export type TransactionStatusPollingOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  fastIntervalMs?: number;
  fastPollCount?: number;
};

export type SendTransactionBase = {
  network: Network;
  to: Address;
  value?: bigint;
  mode?: TransactionMode;
  selectFeeOption?: FeeOptionSelector;
  waitForStatus?: boolean;
  statusPolling?: TransactionStatusPollingOptions;
};

export type SendNativeTransactionParams = SendTransactionBase & {
  value: bigint;
  data?: never;
  abi?: never;
};

export type SendDataTransactionParams = SendTransactionBase & {
  data: Hex;
  abi?: never;
};

export type SendContractTransactionParams<
  abi extends Abi | readonly unknown[] = Abi,
  functionName extends ContractFunctionName<abi> | undefined = ContractFunctionName<abi>
> = SendTransactionBase &
  EncodeFunctionDataParameters<abi, functionName> & {
    data?: never;
  };

export type SendTransactionParams =
  SendNativeTransactionParams | SendDataTransactionParams | SendContractTransactionParams;

export type SendSolanaTransferParams = {
  network: SolanaNetwork;
  asset: string;
  to: string;
  amount: bigint;
  mode?: TransactionMode;
  selectFeeOption?: FeeOptionSelector;
  waitForStatus?: boolean;
  statusPolling?: TransactionStatusPollingOptions;
};

/**
 * A Tron transaction. Tron wallets are EOAs and always execute in native mode.
 *
 * Omitting `data` sends a plain TRX transfer. Passing `data` (including `'0x'`) makes the
 * transaction a contract call; `'0x'` calls the contract's payable fallback.
 */
export type SendTronTransactionParams = {
  network: TronNetwork;
  /** Base58Check recipient address (`T…`). */
  to: string;
  /** Amount in sun (1 TRX = 1,000,000 sun). Defaults to `0n`. */
  value?: bigint;
  data?: Hex;
  selectFeeOption?: FeeOptionSelector;
  waitForStatus?: boolean;
  statusPolling?: TransactionStatusPollingOptions;
};

/**
 * A Tron contract call, ABI-encoded by the wallet service. Address-typed arguments accept
 * Base58Check (`T…`) addresses.
 */
export type CallTronContractParams = {
  network: TronNetwork;
  /** Base58Check contract address (`T…`). */
  contractAddress: string;
  /** Function signature, e.g. `'transfer(address,uint256)'`. */
  method: string;
  args?: Array<AbiArg>;
  selectFeeOption?: FeeOptionSelector;
  waitForStatus?: boolean;
  statusPolling?: TransactionStatusPollingOptions;
};
