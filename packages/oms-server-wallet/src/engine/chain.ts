import { z } from 'zod';

import type { FeeOption, RemoteWallet } from '../protocol.js';
import type { State, StoredChainOperation } from '../state.js';
import type {
  ListOperationsOptions,
  OperationPage,
  ResolveReconciliationInput,
  SolanaOperation,
  SolanaTransfer,
  SolanaTransferInput,
  SubmissionMode,
  TransactionStatusView,
  TronCallInput,
  TronNetwork,
  TronOperation,
  TronTransfer,
  TronTransferInput,
  TypedDataInput
} from '../types.js';
import type { EngineCore } from './core.js';
import type { NormalizedTronCall } from './inputs.js';
import type { ChainSignRequest } from './signing.js';

import { WalletError } from '../errors.js';
import { tronToHex } from '../internal/protocol/addresses.js';
import { TRON_CHAIN_IDS } from '../internal/protocol/networks.js';
import { chainQuoteSchema } from '../protocol.js';
import { refreshStatus, resolveNotBroadcast, settleExecuteError } from '../settlement.js';
import { validateTronTypedData } from '../typed-data.js';
import { parseWaas } from '../validation.js';
import {
  assertReviewId,
  isSolanaSignature,
  isTronTxid,
  needsRefresh,
  normalizeSolanaTransfer,
  normalizeTronCall,
  normalizeTronTransfer,
  requireMessage,
  requireTronNetwork,
  validateIdempotencyKey,
  validateReviewId,
  validateTxnId
} from './inputs.js';
import { projectSolanaOperation, projectTronOperation, parseListOptions } from './projection.js';
import {
  assertNotSelfVerifying,
  authorizeTypedData,
  requestChainSignature,
  solanaMessageRequest,
  tronMessageRequest,
  tronTypedDataRequest
} from './signing.js';

/** Solana and Tron operations: transfers, transactions, contract calls and signatures. */
export class ChainEngine {
  constructor(private readonly core: EngineCore) {}

  async prepareSolanaTransfer(input: SolanaTransferInput): Promise<SolanaOperation> {
    const { idempotencyKey, transfer } = normalizeSolanaTransfer(input);
    return this.core.config.executor.run(async () =>
      projectSolanaOperation(
        await this.prepareSolanaTransferInternal(idempotencyKey, transfer, 'review')
      )
    );
  }

  async sendSolanaTransfer(input: SolanaTransferInput): Promise<SolanaOperation> {
    const { idempotencyKey, transfer } = normalizeSolanaTransfer(input);
    return this.core.config.executor.run(async () => {
      const prepared = await this.prepareSolanaTransferInternal(
        idempotencyKey,
        transfer,
        'immediate'
      );
      if (prepared.status === 'quoted') {
        const executed = await this.executeChainInternal(
          'solana',
          prepared.id,
          ['transfer'],
          prepared.reviewId!
        );
        return projectSolanaOperation(executed);
      }
      return projectSolanaOperation(await this.refreshChain(prepared));
    });
  }

  async executeSolana(idempotencyKey: string, reviewId: string): Promise<SolanaOperation> {
    const id = validateIdempotencyKey(idempotencyKey);
    const rev = validateReviewId(reviewId);
    return this.core.config.executor.run(async () =>
      projectSolanaOperation(await this.executeChainInternal('solana', id, ['transfer'], rev))
    );
  }

  async signSolanaMessage(idempotencyKey: string, message: string): Promise<SolanaOperation> {
    const id = validateIdempotencyKey(idempotencyKey);
    const text = requireMessage(message, true);
    return this.core.config.executor.run(async () => {
      const op = await this.signChainLocked(
        id,
        'solana',
        'sign',
        { message: text },
        solanaMessageRequest(text)
      );
      return projectSolanaOperation(op);
    });
  }

  getSolanaOperationLocal(id: string): Promise<SolanaOperation | null> {
    return this.core.config.executor.run(async () => {
      const op = await this.core.readChainOperation(id, 'solana');
      return op ? projectSolanaOperation(op) : null;
    });
  }

  refreshSolanaOperation(id: string, skip?: () => boolean): Promise<SolanaOperation | null> {
    return this.core.config.executor.run(async () => {
      const op = await this.core.readChainOperation(id, 'solana');
      if (!op) return null;
      return projectSolanaOperation(skip?.() ? op : await this.refreshChain(op));
    });
  }

  async resolveSolanaReconciliation(input: ResolveReconciliationInput): Promise<SolanaOperation> {
    const { idempotencyKey, txnId } = this.core.validateResolveInput(input);
    return this.core.config.executor.run(async () =>
      projectSolanaOperation(
        await this.resolveChainReconciliationInternal('solana', idempotencyKey, txnId)
      )
    );
  }

  cancelSolana(idempotencyKey: string): Promise<SolanaOperation> {
    return this.cancelChain('solana', idempotencyKey).then(projectSolanaOperation);
  }

  getSolanaTransactionStatus(txnId: string): Promise<TransactionStatusView> {
    return this.transactionStatusByTxnId('solana', txnId);
  }

  listSolanaOperations(options?: ListOperationsOptions): Promise<OperationPage<SolanaOperation>> {
    const { status, limit, offset } = parseListOptions(options);
    return this.core.config.executor.run(async () => {
      if (status === 'all')
        return this.core.listIndexedOperations('solana', offset, limit, async (id) => {
          const op = await this.core.readChainOperation(id, 'solana');
          return op ? projectSolanaOperation(op) : null;
        });
      return this.core.listOpenOperations(offset, limit, (op) =>
        'family' in op && op.family === 'solana' ? projectSolanaOperation(op) : null
      );
    });
  }

  async prepareTronTransfer(input: TronTransferInput): Promise<TronOperation> {
    const { idempotencyKey, transfer, maxQuotedFee } = normalizeTronTransfer(input);
    return this.core.config.executor.run(async () =>
      projectTronOperation(
        await this.prepareTronTransferInternal(idempotencyKey, transfer, maxQuotedFee, 'review')
      )
    );
  }

  async sendTronTransfer(input: TronTransferInput): Promise<TronOperation> {
    const { idempotencyKey, transfer, maxQuotedFee } = normalizeTronTransfer(input);
    return this.core.config.executor.run(async () =>
      this.sendTronLocked(
        await this.prepareTronTransferInternal(idempotencyKey, transfer, maxQuotedFee, 'immediate')
      )
    );
  }

  async prepareTronCall(input: TronCallInput): Promise<TronOperation> {
    const { idempotencyKey, network, target, maxQuotedFee } = normalizeTronCall(input);
    return this.core.config.executor.run(async () =>
      projectTronOperation(
        await this.prepareTronCallInternal(idempotencyKey, network, target, maxQuotedFee, 'review')
      )
    );
  }

  async sendTronCall(input: TronCallInput): Promise<TronOperation> {
    const { idempotencyKey, network, target, maxQuotedFee } = normalizeTronCall(input);
    return this.core.config.executor.run(async () =>
      this.sendTronLocked(
        await this.prepareTronCallInternal(
          idempotencyKey,
          network,
          target,
          maxQuotedFee,
          'immediate'
        )
      )
    );
  }

  private async sendTronLocked(prepared: StoredChainOperation): Promise<TronOperation> {
    if (prepared.status === 'quoted')
      return projectTronOperation(
        await this.executeChainInternal(
          'tron',
          prepared.id,
          [prepared.kind as 'transfer' | 'call'],
          prepared.reviewId!
        )
      );
    return projectTronOperation(await this.refreshChain(prepared));
  }

  async executeTron(idempotencyKey: string, reviewId: string): Promise<TronOperation> {
    const id = validateIdempotencyKey(idempotencyKey);
    const rev = validateReviewId(reviewId);
    return this.core.config.executor.run(async () =>
      projectTronOperation(await this.executeChainInternal('tron', id, ['transfer', 'call'], rev))
    );
  }

  async signTronMessage(idempotencyKey: string, message: string): Promise<TronOperation> {
    const id = validateIdempotencyKey(idempotencyKey);
    const text = requireMessage(message, true);
    return this.core.config.executor.run(async () => {
      const op = await this.signChainLocked(
        id,
        'tron',
        'sign',
        { message: text },
        tronMessageRequest(text)
      );
      return projectTronOperation(op);
    });
  }

  async signTronTypedData(
    idempotencyKey: string,
    network: TronNetwork,
    input: TypedDataInput
  ): Promise<TronOperation> {
    const id = validateIdempotencyKey(idempotencyKey);
    const validNetwork = requireTronNetwork(network);
    const chainId = TRON_CHAIN_IDS[validNetwork];
    const { typedData, digest } = validateTronTypedData(input, chainId);
    return this.core.config.executor.run(async () => {
      const op = await this.signChainLocked(
        id,
        'tron',
        'signTypedData',
        { network: validNetwork, digest },
        tronTypedDataRequest(typedData),
        { network: validNetwork },
        async (wallet) => {
          assertNotSelfVerifying(typedData, tronToHex(wallet.address));
          await authorizeTypedData(this.core, {
            family: 'tron',
            chainId,
            network: validNetwork,
            walletAddress: wallet.address,
            idempotencyKey: id,
            digest,
            typedData
          });
        }
      );
      return projectTronOperation(op);
    });
  }

  getTronOperationLocal(id: string): Promise<TronOperation | null> {
    return this.core.config.executor.run(async () => {
      const op = await this.core.readChainOperation(id, 'tron');
      return op ? projectTronOperation(op) : null;
    });
  }

  refreshTronOperation(id: string, skip?: () => boolean): Promise<TronOperation | null> {
    return this.core.config.executor.run(async () => {
      const op = await this.core.readChainOperation(id, 'tron');
      if (!op) return null;
      return projectTronOperation(skip?.() ? op : await this.refreshChain(op));
    });
  }

  async resolveTronReconciliation(input: ResolveReconciliationInput): Promise<TronOperation> {
    const { idempotencyKey, txnId } = this.core.validateResolveInput(input);
    return this.core.config.executor.run(async () =>
      projectTronOperation(
        await this.resolveChainReconciliationInternal('tron', idempotencyKey, txnId)
      )
    );
  }

  cancelTron(idempotencyKey: string): Promise<TronOperation> {
    return this.cancelChain('tron', idempotencyKey).then(projectTronOperation);
  }

  getTronTransactionStatus(txnId: string): Promise<TransactionStatusView> {
    return this.transactionStatusByTxnId('tron', txnId);
  }

  listTronOperations(options?: ListOperationsOptions): Promise<OperationPage<TronOperation>> {
    const { status, limit, offset } = parseListOptions(options);
    return this.core.config.executor.run(async () => {
      if (status === 'all')
        return this.core.listIndexedOperations('tron', offset, limit, async (id) => {
          const op = await this.core.readChainOperation(id, 'tron');
          return op ? projectTronOperation(op) : null;
        });
      return this.core.listOpenOperations(offset, limit, (op) =>
        'family' in op && op.family === 'tron' ? projectTronOperation(op) : null
      );
    });
  }

  private async resolveChainReconciliationInternal(
    family: 'solana' | 'tron',
    id: string,
    txnId: string
  ): Promise<StoredChainOperation> {
    const op = await this.core.readChainOperation(id, family);
    if (!op) throw new WalletError('NOT_FOUND', 'Operation not found.', 404);
    const state = await this.core.load();
    await resolveNotBroadcast(
      op,
      txnId,
      () => this.chainTransactionStatus(state, op),
      () => this.core.now()
    );
    await this.core.writeOperation(op);
    return op;
  }

  private prepareSolanaTransferInternal(
    id: string,
    transfer: SolanaTransfer,
    submissionMode: SubmissionMode
  ): Promise<StoredChainOperation> {
    return this.prepareChainLocked(
      id,
      'solana',
      'transfer',
      { ...transfer },
      { network: transfer.network, transfer },
      submissionMode,
      (wallet) => {
        if (transfer.to === wallet.address)
          throw new WalletError('INVALID_ADDRESS', 'The recipient cannot be the sending wallet.');
        return {
          method: 'PrepareSolanaTransfer',
          params: {
            network: transfer.network,
            walletId: wallet.id,
            asset: transfer.asset === 'native' ? 'SOL' : transfer.asset,
            recipient: { address: transfer.to },
            amount: transfer.amount,
            mode: 'relayer'
          }
        };
      },
      (op) => {
        if (op.quote?.sponsored) return undefined;
        throw new WalletError(
          'SPONSORSHIP_REQUIRED',
          'This transfer is not sponsored. Enable the Solana fee payer for this project and network.',
          409
        );
      }
    );
  }

  private prepareTronTransferInternal(
    id: string,
    transfer: TronTransfer,
    maxQuotedFee: string | undefined,
    submissionMode: SubmissionMode
  ): Promise<StoredChainOperation> {
    return this.prepareChainLocked(
      id,
      'tron',
      'transfer',
      { ...transfer, maxQuotedFee },
      { network: transfer.network, transfer, ...(maxQuotedFee ? { maxQuotedFee } : {}) },
      submissionMode,
      (wallet) => {
        if (transfer.to === wallet.address)
          throw new WalletError('INVALID_ADDRESS', 'The recipient cannot be the sending wallet.');
        if (transfer.asset === 'native')
          return {
            method: 'PrepareTronTransaction',
            params: {
              network: transfer.network,
              walletId: wallet.id,
              to: transfer.to,
              value: transfer.amount,
              mode: 'native'
            }
          };
        if (transfer.asset === wallet.address)
          throw new WalletError('INVALID_ADDRESS', 'The token contract cannot be the wallet.');
        return {
          method: 'PrepareTronContractCall',
          params: {
            network: transfer.network,
            walletId: wallet.id,
            contract: transfer.asset,
            method: 'transfer',
            args: [
              { type: 'address', value: transfer.to },
              { type: 'uint256', value: transfer.amount }
            ],
            mode: 'native'
          }
        };
      },
      (op) => this.selectTronFee(op)
    );
  }

  private prepareTronCallInternal(
    id: string,
    network: TronNetwork,
    target: NormalizedTronCall,
    maxQuotedFee: string | undefined,
    submissionMode: SubmissionMode
  ): Promise<StoredChainOperation> {
    const to = target.call ? target.call.to : target.transaction.to;
    return this.prepareChainLocked(
      id,
      'tron',
      'call',
      { network, ...(target.call ?? target.transaction), maxQuotedFee },
      { network, ...target, ...(maxQuotedFee ? { maxQuotedFee } : {}) },
      submissionMode,
      (wallet) => {
        if (to === wallet.address)
          throw new WalletError('INVALID_CALL', 'Calls to the wallet itself are not allowed.');
        return target.call
          ? {
              method: 'PrepareTronContractCall',
              params: {
                network,
                walletId: wallet.id,
                contract: target.call.to,
                method: target.call.method,
                args: target.call.args,
                mode: 'native'
              }
            }
          : {
              method: 'PrepareTronTransaction',
              params: { network, walletId: wallet.id, ...target.transaction, mode: 'native' }
            };
      },
      (op) => this.selectTronFee(op)
    );
  }

  private selectTronFee(op: StoredChainOperation): FeeOption | undefined {
    const quote = op.quote!;
    if (quote.sponsored) return undefined;
    if (!op.maxQuotedFee)
      throw new WalletError(
        'SPONSORSHIP_REQUIRED',
        'Delegated resources do not cover this transaction. Delegate energy and bandwidth to the wallet, or set maxQuotedFee to pay in TRX.',
        409
      );
    const options = quote.feeOptions.filter(
      (option) => option.token.symbol === 'TRX' && option.token.type.toUpperCase() === 'NATIVE'
    );
    if (options.length !== 1 || options[0].value === '0')
      throw new WalletError('INVALID_RESPONSE', 'WaaS quoted no single TRX fee.', 502);
    if (BigInt(options[0].value) > BigInt(op.maxQuotedFee))
      throw new WalletError(
        'FEE_LIMIT_EXCEEDED',
        `The quoted fee of ${options[0].value} sun exceeds maxQuotedFee.`,
        409
      );
    return options[0];
  }

  private async prepareChainLocked(
    id: string,
    family: 'solana' | 'tron',
    kind: StoredChainOperation['kind'],
    input: Record<string, unknown>,
    stored: Partial<StoredChainOperation>,
    submissionMode: SubmissionMode,
    request: (wallet: RemoteWallet) => { method: string; params: Record<string, unknown> },
    selectFee: (op: StoredChainOperation) => FeeOption | undefined
  ): Promise<StoredChainOperation> {
    const { operation, hash } = await this.core.existingAny(
      id,
      kind,
      input,
      family,
      submissionMode
    );
    if (operation) return operation as StoredChainOperation;
    const state = await this.core.load();
    await this.core.ensure(state, [family]);
    const wallet = state.wallets[family]!;
    const { method, params } = request(wallet);
    const op: StoredChainOperation = {
      id,
      family,
      kind,
      inputHash: hash,
      createdAt: new Date(this.core.now()).toISOString(),
      status: 'preparing',
      submissionMode,
      submitted: false,
      ...stored
    };
    await this.core.writeOperation(op);
    try {
      op.quote = parseWaas(
        chainQuoteSchema,
        await this.core.activeCall(state, method, params, [family])
      );
      const fee = selectFee(op);
      if (fee) {
        op.fee = fee;
        op.feeIndex = op.quote.feeOptions.indexOf(fee);
      }
      op.reviewId = await this.core.computeReviewId({
        walletId: wallet.id,
        walletAddress: wallet.address,
        family,
        network: op.network,
        kind,
        inputHash: op.inputHash,
        txnId: op.quote.txnId,
        sponsored: op.quote.sponsored,
        fee: op.fee ?? null,
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

  private async executeChainInternal(
    family: 'solana' | 'tron',
    id: string,
    kinds: readonly StoredChainOperation['kind'][],
    reviewId: string
  ): Promise<StoredChainOperation> {
    const op = await this.core.readChainOperation(id, family);
    if (!op || !kinds.includes(op.kind) || !op.quote)
      throw new WalletError('NOT_FOUND', 'Prepared transaction not found.', 404);
    this.core.assertNotCancelled(op);
    assertReviewId(op, reviewId);
    if (op.status !== 'quoted') return this.refreshChain(op);
    if (!op.quote.sponsored && !op.fee)
      throw new WalletError('SPONSORSHIP_REQUIRED', 'This transaction is not sponsored.', 409);
    await this.core.expireBeforeSubmit(op);
    const state = await this.core.load();
    await this.core.ensure(state, [family]);
    // Re-check expiry after re-auth I/O so a short-lived quote is never sent to Execute.
    await this.core.expireBeforeSubmit(op);
    op.status = 'submitting';
    op.submitted = true;
    await this.core.writeOperation(op);
    try {
      const result = parseWaas(
        this.chainStatusSchema(family),
        await this.core.activeCall(
          state,
          'Execute',
          {
            txnId: op.quote.txnId,
            ...(op.fee ? { feeOption: { token: op.fee.token.symbol, index: op.feeIndex } } : {})
          },
          [family]
        )
      );
      op.status = result.status === 'quoted' ? 'unknown' : result.status;
      if (result.txnHash) op.txnHash = result.txnHash;
    } catch (error) {
      await settleExecuteError(op, error, () => this.chainTransactionStatus(state, op));
    }
    await this.core.writeOperation(op);
    return op;
  }

  private async refreshChain(op: StoredChainOperation): Promise<StoredChainOperation> {
    if (await this.core.expireIfStale(op)) return op;
    if (!op.quote || !needsRefresh(op)) return op;
    const state = await this.core.load();
    await refreshStatus(op, () => this.chainTransactionStatus(state, op), this.core.now());
    await this.core.writeOperation(op);
    return op;
  }

  private chainStatusSchema(family: 'solana' | 'tron') {
    const valid = family === 'solana' ? isSolanaSignature : isTronTxid;
    return z.object({
      status: z.enum(['quoted', 'pending', 'executed', 'failed']),
      txnHash: z
        .string()
        .refine(valid)
        .optional()
        .or(z.literal('').transform(() => undefined))
    });
  }

  private async cancelChain(
    family: 'solana' | 'tron',
    idempotencyKey: string
  ): Promise<StoredChainOperation> {
    const id = validateIdempotencyKey(idempotencyKey);
    return this.core.config.executor.run(async () => {
      const op = await this.core.readChainOperation(id, family);
      if (!op || op.kind === 'sign' || op.kind === 'signTypedData')
        throw new WalletError('NOT_FOUND', 'Prepared transaction not found.', 404);
      await this.core.cancelOperation(op);
      return op;
    });
  }

  private async transactionStatusByTxnId(
    family: 'solana' | 'tron',
    txnId: string
  ): Promise<TransactionStatusView> {
    const id = validateTxnId(txnId);
    return this.core.config.executor.run(async () => {
      const state = await this.core.load();
      // Checked first so the authenticated call below can never create a wallet.
      if (!state.wallets[family])
        throw new WalletError(
          'WALLET_NOT_INITIALIZED',
          `${family === 'solana' ? 'Solana' : 'Tron'} wallet has not been created or restored yet.`,
          409
        );
      const result = parseWaas(
        this.chainStatusSchema(family),
        await this.core.activeCall(state, 'TransactionStatus', { txnId: id }, [family])
      );
      return {
        txnId: id,
        status: result.status,
        ...(result.txnHash ? { txnHash: result.txnHash } : {})
      };
    });
  }

  private async chainTransactionStatus(state: State, op: StoredChainOperation) {
    return parseWaas(
      this.chainStatusSchema(op.family),
      await this.core.activeCall(state, 'TransactionStatus', { txnId: op.quote!.txnId }, [
        op.family
      ])
    );
  }

  private async signChainLocked(
    id: string,
    family: 'solana' | 'tron',
    kind: 'sign' | 'signTypedData',
    input: Record<string, unknown>,
    request: ChainSignRequest,
    stored: Partial<StoredChainOperation> = {},
    authorize?: (wallet: RemoteWallet) => Promise<void>
  ): Promise<StoredChainOperation> {
    const { operation, hash } = await this.core.existingAny(id, kind, input, family, 'review');
    if (operation) return operation as StoredChainOperation;
    const state = await this.core.load();
    await this.core.ensure(state, [family]);
    await authorize?.(state.wallets[family]!);
    const op: StoredChainOperation = {
      id,
      family,
      kind,
      inputHash: hash,
      createdAt: new Date(this.core.now()).toISOString(),
      status: 'unknown',
      submissionMode: 'review',
      ...stored
    };
    await this.core.writeOperation(op);
    try {
      op.signature = await requestChainSignature(this.core, state, family, request);
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
