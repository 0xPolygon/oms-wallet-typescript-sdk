import type { Hex } from 'viem';

import { encodeFunctionData, erc20Abi, getAddress } from 'viem';

import type { RecoveryTransaction } from '../authorization.js';
import type { State, StoredEvmOperation } from '../state.js';
import type {
  EvmOperation,
  EvmTransfer,
  EvmTransferInput,
  ListOperationsOptions,
  OperationPage,
  ResolveReconciliationInput,
  SubmissionMode,
  TransactionStatusView,
  TypedDataInput
} from '../types.js';
import type { EngineCore } from './core.js';

import { requireChain } from '../environment.js';
import { WalletError } from '../errors.js';
import { quoteSchema, statusSchema } from '../protocol.js';
import { refreshStatus, resolveNotBroadcast, settleExecuteError } from '../settlement.js';
import { validateTypedData } from '../typed-data.js';
import { parseWaas } from '../validation.js';
import {
  PUBLIC_EVM_TX_KINDS,
  assertReviewId,
  isInternalEvmOperation,
  needsRefresh,
  normalizeEvmCall,
  normalizeEvmTransfer,
  requireMessage,
  validateIdempotencyKey,
  validateReviewId,
  validateTxnId
} from './inputs.js';
import { projectEvmOperation, parseListOptions } from './projection.js';
import {
  assertNotSelfVerifying,
  assertPublicTypedData,
  requestEvmMessageSignature,
  requestEvmTypedDataSignature
} from './signing.js';

/** EVM operations: transfers, contract calls, signatures, settlement and the swaps debit gate. */
export class EvmEngine {
  constructor(private readonly core: EngineCore) {}

  async prepareEvmTransfer(input: EvmTransferInput): Promise<EvmOperation> {
    const id = validateIdempotencyKey(input?.idempotencyKey);
    const transfer = normalizeEvmTransfer({
      chainId: input.chainId,
      to: input.to,
      asset: input.asset,
      amount: input.amount
    });
    return this.core.config.executor.run(async () =>
      projectEvmOperation(await this.prepareEvmTransferInternal(id, transfer, 'review'))
    );
  }

  async sendEvmTransfer(input: EvmTransferInput): Promise<EvmOperation> {
    const id = validateIdempotencyKey(input?.idempotencyKey);
    const transfer = normalizeEvmTransfer({
      chainId: input.chainId,
      to: input.to,
      asset: input.asset,
      amount: input.amount
    });
    return this.core.config.executor.run(async () => {
      const prepared = await this.prepareEvmTransferInternal(id, transfer, 'immediate');
      if (prepared.status === 'quoted') {
        const executed = await this.executeEvmInternal(
          prepared.id,
          ['transfer'],
          prepared.reviewId
        );
        return projectEvmOperation(executed);
      }
      return projectEvmOperation(await this.refreshEvm(prepared));
    });
  }

  async prepareEvmCall(input: unknown): Promise<EvmOperation> {
    const { idempotencyKey, chainId, transaction } = normalizeEvmCall(input);
    return this.core.config.executor.run(async () =>
      projectEvmOperation(
        await this.prepareEvmCallInternal(idempotencyKey, chainId, transaction, 'review')
      )
    );
  }

  async sendEvmCall(input: unknown): Promise<EvmOperation> {
    const { idempotencyKey, chainId, transaction } = normalizeEvmCall(input);
    return this.core.config.executor.run(async () => {
      const prepared = await this.prepareEvmCallInternal(
        idempotencyKey,
        chainId,
        transaction,
        'immediate'
      );
      if (prepared.status === 'quoted') {
        const executed = await this.executeEvmInternal(prepared.id, ['call'], prepared.reviewId);
        return projectEvmOperation(executed);
      }
      return projectEvmOperation(await this.refreshEvm(prepared));
    });
  }

  async executeEvm(idempotencyKey: string, reviewId: string): Promise<EvmOperation> {
    const id = validateIdempotencyKey(idempotencyKey);
    const rev = validateReviewId(reviewId);
    return this.core.config.executor.run(async () =>
      projectEvmOperation(await this.executeEvmInternal(id, PUBLIC_EVM_TX_KINDS, rev))
    );
  }

  async signEvmMessage(
    idempotencyKey: string,
    chainId: number,
    message: string
  ): Promise<EvmOperation> {
    const id = validateIdempotencyKey(idempotencyKey);
    requireChain(chainId);
    const text = requireMessage(message, false);
    return this.core.config.executor.run(async () => {
      const { operation, hash } = await this.core.existingEvm(id, 'sign', {
        chainId,
        message: text
      });
      if (operation) return projectEvmOperation(operation);
      const state = await this.core.load();
      await this.core.ensure(state, ['evm']);
      const op: StoredEvmOperation = {
        id,
        kind: 'sign',
        chainId,
        inputHash: hash,
        createdAt: new Date(this.core.now()).toISOString(),
        status: 'unknown',
        submissionMode: 'review'
      };
      await this.core.writeOperation(op);
      const signed = await this.recordEvmSignature(op, () =>
        requestEvmMessageSignature(this.core, state, chainId, text)
      );
      return projectEvmOperation(signed);
    });
  }

  async signEvmTypedData(
    idempotencyKey: string,
    chainId: number,
    typedData: TypedDataInput
  ): Promise<EvmOperation> {
    const id = validateIdempotencyKey(idempotencyKey);
    // Snapshot synchronously so callers cannot mutate an authorization while it is queued.
    const validated = validateTypedData(typedData, chainId);
    assertPublicTypedData(validated.typedData);
    return this.core.config.executor.run(async () =>
      projectEvmOperation(
        await this.signEvmTypedDataValidated(id, chainId, validated.typedData, validated.digest, {
          rejectSelfVerifyingContract: true
        })
      )
    );
  }

  async resolveEvmReconciliation(input: ResolveReconciliationInput): Promise<EvmOperation> {
    const { idempotencyKey, txnId } = this.core.validateResolveInput(input);
    return this.core.config.executor.run(async () =>
      projectEvmOperation(
        await this.resolveEvmReconciliationInternal(idempotencyKey, txnId, { allowInternal: false })
      )
    );
  }

  getEvmOperationLocal(id: string): Promise<EvmOperation | null> {
    return this.core.config.executor.run(async () => {
      const op = await this.core.readEvmOperation(id);
      return op && !isInternalEvmOperation(op) ? projectEvmOperation(op) : null;
    });
  }

  refreshEvmOperation(id: string): Promise<EvmOperation | null> {
    return this.core.config.executor.run(async () => {
      const op = await this.core.readEvmOperation(id);
      if (!op || isInternalEvmOperation(op)) return null;
      return projectEvmOperation(await this.refreshEvm(op));
    });
  }

  async getTransactionStatus(txnId: string): Promise<TransactionStatusView> {
    const id = validateTxnId(txnId);
    return this.core.config.executor.run(async () => {
      const state = await this.core.load();
      // Checked first so the authenticated call below can never create a wallet.
      if (!state.wallets.evm)
        throw new WalletError(
          'WALLET_NOT_INITIALIZED',
          'EVM wallet has not been created or restored yet.',
          409
        );
      const result = await this.evmTransactionStatus(state, id);
      return {
        txnId: id,
        status: result.status,
        ...(result.txnHash ? { txnHash: result.txnHash } : {})
      };
    });
  }

  listEvmOperations(options?: ListOperationsOptions): Promise<OperationPage<EvmOperation>> {
    const { status, limit, offset } = parseListOptions(options);
    return this.core.config.executor.run(async () => {
      if (status === 'all')
        return this.core.listIndexedOperations('evm', offset, limit, async (id) => {
          const op = await this.core.readEvmOperation(id);
          return op && !isInternalEvmOperation(op) ? projectEvmOperation(op) : null;
        });
      return this.core.listOpenOperations(offset, limit, (op) =>
        'family' in op || isInternalEvmOperation(op) ? null : projectEvmOperation(op)
      );
    });
  }

  private async checkEvmDebitGate(
    state: State,
    chainId: number,
    exceptOperationId?: string,
    skipGate = false
  ): Promise<void> {
    if (skipGate) return;
    if (state.swapsCoordinated && !this.core.gate)
      throw new WalletError(
        'SWAPS_COORDINATION_REQUIRED',
        'This wallet has active Trails swaps coordination. Use createServerWallet with swaps: trails(...) so EVM debits coordinate with swap reservations.',
        409
      );
    // Authoritative swap reservations in wallet state protect against a misconfigured worker
    // pointing at an empty or different swap store while sharing wallet state and executor.
    if (state.swapReservations) {
      const blocking = Object.entries(state.swapReservations).find(([, c]) => c === chainId);
      if (blocking)
        throw new WalletError(
          'DEBIT_PENDING',
          `Another debit on chain ${chainId} (swap "${blocking[0]}") must be reconciled first.`,
          409
        );
    }
    if (this.core.gate)
      await this.core.gate.assertChainAvailableLocked(chainId, { exceptOperationId });
  }

  async prepareEvmTransferInternal(
    id: string,
    transfer: EvmTransfer,
    submissionMode: SubmissionMode,
    options: { allowSwapsPrefix?: boolean; skipGate?: boolean } = {}
  ): Promise<StoredEvmOperation> {
    const { operation, hash } = await this.core.existingEvm(
      id,
      'transfer',
      transfer,
      submissionMode,
      options.allowSwapsPrefix
    );
    if (operation) return operation;
    let state = await this.core.load();
    await this.checkEvmDebitGate(state, transfer.chainId, id, options.skipGate);
    // Reload state after the debit gate in case gate refreshes advanced the nonce or rotated credentials.
    state = await this.core.load();
    await this.core.ensure(state, ['evm']);
    const op: StoredEvmOperation = {
      id,
      kind: 'transfer',
      inputHash: hash,
      createdAt: new Date(this.core.now()).toISOString(),
      chainId: transfer.chainId,
      status: 'preparing',
      submissionMode,
      ...(options.allowSwapsPrefix ? { internal: true } : {}),
      submitted: false,
      transfer
    };
    const native = transfer.asset === 'native';
    const call = {
      to: native ? transfer.to : transfer.asset,
      value: native ? transfer.amount : '0',
      ...(native
        ? {}
        : {
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'transfer',
              args: [getAddress(transfer.to), BigInt(transfer.amount)]
            })
          })
    };
    return this.quoteEvm(
      op,
      state,
      call,
      'This transfer is not sponsored. Enable gas sponsorship for this project/network.'
    );
  }

  private async prepareEvmCallInternal(
    id: string,
    chainId: number,
    transaction: { to: string; value: string; data: Hex },
    submissionMode: SubmissionMode
  ): Promise<StoredEvmOperation> {
    const { operation, hash } = await this.core.existingEvm(
      id,
      'call',
      { chainId, ...transaction },
      submissionMode,
      false
    );
    if (operation) return operation;
    let state = await this.core.load();
    await this.checkEvmDebitGate(state, chainId, id, false);
    // Reload state after the debit gate in case gate refreshes advanced the nonce or rotated credentials.
    state = await this.core.load();
    await this.core.ensure(state, ['evm']);
    if (transaction.to.toLowerCase() === state.wallets.evm!.address.toLowerCase())
      throw new WalletError('INVALID_CALL', 'Calls to the wallet itself are not allowed.');
    const op: StoredEvmOperation = {
      id,
      kind: 'call',
      inputHash: hash,
      createdAt: new Date(this.core.now()).toISOString(),
      chainId,
      status: 'preparing',
      submissionMode,
      submitted: false,
      transaction
    };
    return this.quoteEvm(
      op,
      state,
      transaction,
      'This call is not sponsored. Enable gas sponsorship for this project/network.'
    );
  }

  async prepareInternalEvm(
    id: string,
    chainId: number,
    kind: 'deployment' | 'recovery',
    transaction?: RecoveryTransaction
  ): Promise<StoredEvmOperation> {
    requireChain(chainId);
    const state = await this.core.load();
    await this.core.ensure(state, ['evm']);
    if (transaction && transaction.owner !== state.wallets.evm!.address.toLowerCase())
      throw new WalletError('INVALID_RECOVERY', 'Recovery belongs to a different wallet.');
    const call = transaction
      ? { to: transaction.to, data: transaction.data, value: transaction.value }
      : { to: state.wallets.evm!.address, data: '0x', value: '0' };
    const { operation, hash } = await this.core.existingEvm(
      id,
      kind,
      { chainId, ...call },
      'immediate',
      true
    );
    if (operation) return operation;
    const op: StoredEvmOperation = {
      id,
      kind,
      chainId,
      transaction: call,
      inputHash: hash,
      status: 'preparing',
      submissionMode: 'immediate',
      internal: true,
      submitted: false,
      createdAt: new Date(this.core.now()).toISOString()
    };
    return this.quoteEvm(op, state, call, 'Recovery and deployment require gas sponsorship.');
  }

  private async quoteEvm(
    op: StoredEvmOperation,
    state: State,
    call: { to: string; value: string; data?: string },
    unsponsored: string
  ): Promise<StoredEvmOperation> {
    await this.core.writeOperation(op);
    try {
      op.quote = parseWaas(
        quoteSchema,
        await this.core.activeCall(state, 'PrepareEthereumTransaction', {
          network: String(op.chainId),
          walletId: state.wallets.evm!.id,
          ...call,
          mode: 'relayer'
        })
      );
      if (!op.quote.sponsored) throw new WalletError('SPONSORSHIP_REQUIRED', unsponsored, 409);
      op.reviewId = await this.core.computeReviewId({
        walletId: state.wallets.evm!.id,
        walletAddress: state.wallets.evm!.address.toLowerCase(),
        family: 'evm',
        chainId: op.chainId,
        kind: op.kind,
        inputHash: op.inputHash,
        txnId: op.quote.txnId,
        sponsored: op.quote.sponsored,
        expiresAt: op.quote.expiresAt
      });
      op.status = 'quoted';
      await this.core.writeOperation(op);
      return op;
    } catch (error) {
      op.status = 'failed';
      op.error = error instanceof WalletError ? error.code : 'PREPARATION_FAILED';
      await this.core.writeOperation(op);
      throw error;
    }
  }

  async executeEvmInternal(
    id: string,
    kinds: readonly StoredEvmOperation['kind'][],
    reviewId?: string,
    options: { skipGate?: boolean; bypassReviewId?: boolean } = {}
  ): Promise<StoredEvmOperation> {
    const op = await this.core.readEvmOperation(id);
    if (!op || !kinds.includes(op.kind))
      throw new WalletError('NOT_FOUND', 'Prepared transaction not found.', 404);
    if (!options.bypassReviewId) assertReviewId(op, reviewId);
    if (op.status !== 'quoted') return this.refreshEvm(op);
    if (!op.quote?.sponsored)
      throw new WalletError('SPONSORSHIP_REQUIRED', 'Transaction requires gas sponsorship.', 409);
    await this.core.expireBeforeSubmit(op);
    let state = await this.core.load();
    await this.checkEvmDebitGate(state, op.chainId, op.id, options.skipGate);
    // Reload state after the debit gate in case gate refreshes advanced the nonce or rotated credentials.
    state = await this.core.load();
    await this.core.ensure(state, ['evm']);
    // Re-check expiry after debit gate / re-auth I/O so an expired quote is never sent to Execute.
    await this.core.expireBeforeSubmit(op);
    op.status = 'submitting';
    op.submitted = true;
    await this.core.writeOperation(op);
    const quote = op.quote;
    try {
      const result = parseWaas(
        statusSchema,
        await this.core.activeCall(state, 'Execute', { txnId: quote.txnId })
      );
      op.status = result.status === 'quoted' ? 'unknown' : result.status;
      if (result.txnHash) op.txnHash = result.txnHash;
    } catch (error) {
      await settleExecuteError(op, error, () => this.evmTransactionStatus(state, quote.txnId));
    }
    await this.core.writeOperation(op);
    return op;
  }

  async refreshEvm(op: StoredEvmOperation): Promise<StoredEvmOperation> {
    if (
      !['transfer', 'call', 'deployment', 'recovery'].includes(op.kind) ||
      !op.quote ||
      !needsRefresh(op)
    )
      return op;
    const state = await this.core.load();
    const txnId = op.quote.txnId;
    await refreshStatus(op, () => this.evmTransactionStatus(state, txnId), this.core.now());
    await this.core.writeOperation(op);
    return op;
  }

  async resolveEvmReconciliationInternal(
    id: string,
    txnId: string,
    options: { allowInternal: boolean }
  ): Promise<StoredEvmOperation> {
    const op = await this.core.readEvmOperation(id);
    if (!op || (!options.allowInternal && isInternalEvmOperation(op)))
      throw new WalletError('NOT_FOUND', 'Operation not found.', 404);
    const state = await this.core.load();
    await resolveNotBroadcast(
      op,
      txnId,
      () => this.evmTransactionStatus(state, txnId),
      () => this.core.now()
    );
    await this.core.writeOperation(op);
    return op;
  }

  private async evmTransactionStatus(state: State, txnId: string) {
    return parseWaas(
      statusSchema,
      await this.core.activeCall(state, 'TransactionStatus', { txnId })
    );
  }

  async signEvmTypedDataInternal(
    id: string,
    chainId: number,
    input: unknown,
    options: { allowSwapsPrefix?: boolean } = {}
  ): Promise<StoredEvmOperation> {
    const { typedData, digest } = validateTypedData(input, chainId);
    return this.signEvmTypedDataValidated(id, chainId, typedData, digest, options);
  }

  private async signEvmTypedDataValidated(
    id: string,
    chainId: number,
    typedData: ReturnType<typeof validateTypedData>['typedData'],
    digest: `0x${string}`,
    options: { allowSwapsPrefix?: boolean; rejectSelfVerifyingContract?: boolean } = {}
  ): Promise<StoredEvmOperation> {
    const { operation, hash } = await this.core.existingEvm(
      id,
      'signTypedData',
      { chainId, digest },
      'review',
      options.allowSwapsPrefix
    );
    if (operation) return operation;
    const state = await this.core.load();
    await this.core.ensure(state, ['evm']);
    if (options.rejectSelfVerifyingContract)
      assertNotSelfVerifying(typedData, state.wallets.evm!.address);
    const op: StoredEvmOperation = {
      id,
      kind: 'signTypedData',
      chainId,
      inputHash: hash,
      createdAt: new Date(this.core.now()).toISOString(),
      status: 'unknown',
      submissionMode: 'review',
      ...(options.allowSwapsPrefix ? { internal: true } : {})
    };
    await this.core.writeOperation(op);
    return this.recordEvmSignature(op, () =>
      requestEvmTypedDataSignature(this.core, state, chainId, typedData)
    );
  }

  private async recordEvmSignature(
    op: StoredEvmOperation,
    sign: () => Promise<{ signature: string; valid: boolean }>
  ): Promise<StoredEvmOperation> {
    try {
      const { signature, valid } = await sign();
      if (!valid)
        throw new WalletError(
          'SIGNATURE_INVALID',
          'WaaS returned a signature that did not verify.',
          502
        );
      op.signature = signature;
      op.verified = true;
      op.status = 'signed';
    } catch (error) {
      op.status = 'failed';
      op.error = error instanceof WalletError ? error.code : 'SIGNING_FAILED';
      await this.core.writeOperation(op);
      throw error;
    }
    await this.core.writeOperation(op);
    return op;
  }
}
