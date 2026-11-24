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
  TronAbiArg,
  TronContractCallInput,
  TronNetwork,
  TronOperation,
  TronTransactionInput,
  TypedDataInput
} from '../types.js';
import type { EngineCore } from './core.js';
import type { ChainSignRequest } from './signing.js';

import { WalletError } from '../errors.js';
import { TRON_CHAIN_IDS } from '../internal/protocol/networks.js';
import { chainQuoteSchema } from '../protocol.js';
import { refreshStatus, resolveNotBroadcast, settleExecuteError } from '../settlement.js';
import { parseOperationIndex } from '../state.js';
import { validateTronTypedData } from '../typed-data.js';
import { parseWaas } from '../validation.js';
import {
  OPEN_STATUSES,
  assertReviewId,
  isSolanaSignature,
  isTronTxid,
  normalizeSolanaTransfer,
  normalizeTronContractCall,
  normalizeTronTransaction,
  requireMessage,
  requireTronNetwork,
  validateIdempotencyKey,
  validateReviewId,
  validateTxnId
} from './inputs.js';
import {
  projectSolanaOperation,
  projectTronOperation,
  parseListOptions,
  paginate
} from './projection.js';
import {
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

  refreshSolanaOperation(id: string): Promise<SolanaOperation | null> {
    return this.core.config.executor.run(async () => {
      const op = await this.core.readChainOperation(id, 'solana');
      return op ? projectSolanaOperation(await this.refreshChain(op)) : null;
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

  getSolanaTransactionStatus(txnId: string): Promise<TransactionStatusView> {
    return this.transactionStatusByTxnId('solana', txnId);
  }

  listSolanaOperations(options?: ListOperationsOptions): Promise<OperationPage<SolanaOperation>> {
    const { status, limit, offset } = parseListOptions(options);
    return this.core.config.executor.run(async () => {
      const ids =
        status === 'open'
          ? await this.core.openOperationIds()
          : parseOperationIndex(await this.core.config.store.read('operationIndex'));
      const operations: SolanaOperation[] = [];
      for (const id of ids) {
        const op = await this.core.readChainOperation(id, 'solana');
        if (!op) continue;
        if (status === 'open' && !OPEN_STATUSES.has(op.status)) continue;
        operations.push(projectSolanaOperation(op));
      }
      return paginate(operations, offset, limit);
    });
  }

  async prepareTronTransaction(input: TronTransactionInput): Promise<TronOperation> {
    const { idempotencyKey, network, transaction, maxFee } = normalizeTronTransaction(input);
    return this.core.config.executor.run(async () =>
      projectTronOperation(
        await this.prepareTronTransactionInternal(
          idempotencyKey,
          network,
          transaction,
          maxFee,
          'review'
        )
      )
    );
  }

  async sendTronTransaction(input: TronTransactionInput): Promise<TronOperation> {
    const { idempotencyKey, network, transaction, maxFee } = normalizeTronTransaction(input);
    return this.core.config.executor.run(async () => {
      const prepared = await this.prepareTronTransactionInternal(
        idempotencyKey,
        network,
        transaction,
        maxFee,
        'immediate'
      );
      if (prepared.status === 'quoted') {
        const executed = await this.executeChainInternal(
          'tron',
          prepared.id,
          ['transaction'],
          prepared.reviewId!
        );
        return projectTronOperation(executed);
      }
      return projectTronOperation(await this.refreshChain(prepared));
    });
  }

  async prepareTronContractCall(input: TronContractCallInput): Promise<TronOperation> {
    const { idempotencyKey, network, call, maxFee } = normalizeTronContractCall(input);
    return this.core.config.executor.run(async () =>
      projectTronOperation(
        await this.prepareTronCallInternal(idempotencyKey, network, call, maxFee, 'review')
      )
    );
  }

  async sendTronContractCall(input: TronContractCallInput): Promise<TronOperation> {
    const { idempotencyKey, network, call, maxFee } = normalizeTronContractCall(input);
    return this.core.config.executor.run(async () => {
      const prepared = await this.prepareTronCallInternal(
        idempotencyKey,
        network,
        call,
        maxFee,
        'immediate'
      );
      if (prepared.status === 'quoted') {
        const executed = await this.executeChainInternal(
          'tron',
          prepared.id,
          ['contractCall'],
          prepared.reviewId!
        );
        return projectTronOperation(executed);
      }
      return projectTronOperation(await this.refreshChain(prepared));
    });
  }

  async executeTron(idempotencyKey: string, reviewId: string): Promise<TronOperation> {
    const id = validateIdempotencyKey(idempotencyKey);
    const rev = validateReviewId(reviewId);
    return this.core.config.executor.run(async () =>
      projectTronOperation(
        await this.executeChainInternal('tron', id, ['transaction', 'contractCall'], rev)
      )
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
        { network: validNetwork }
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

  refreshTronOperation(id: string): Promise<TronOperation | null> {
    return this.core.config.executor.run(async () => {
      const op = await this.core.readChainOperation(id, 'tron');
      return op ? projectTronOperation(await this.refreshChain(op)) : null;
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

  getTronTransactionStatus(txnId: string): Promise<TransactionStatusView> {
    return this.transactionStatusByTxnId('tron', txnId);
  }

  listTronOperations(options?: ListOperationsOptions): Promise<OperationPage<TronOperation>> {
    const { status, limit, offset } = parseListOptions(options);
    return this.core.config.executor.run(async () => {
      const ids =
        status === 'open'
          ? await this.core.openOperationIds()
          : parseOperationIndex(await this.core.config.store.read('operationIndex'));
      const operations: TronOperation[] = [];
      for (const id of ids) {
        const op = await this.core.readChainOperation(id, 'tron');
        if (!op) continue;
        if (status === 'open' && !OPEN_STATUSES.has(op.status)) continue;
        operations.push(projectTronOperation(op));
      }
      return paginate(operations, offset, limit);
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

  private prepareTronTransactionInternal(
    id: string,
    network: TronNetwork,
    transaction: { to: string; value: string; data?: `0x${string}` },
    maxFee: string | undefined,
    submissionMode: SubmissionMode
  ): Promise<StoredChainOperation> {
    return this.prepareChainLocked(
      id,
      'tron',
      'transaction',
      { network, ...transaction, maxFee },
      { network, transaction, ...(maxFee ? { maxFee } : {}) },
      submissionMode,
      (wallet) => {
        if (transaction.to === wallet.address)
          throw new WalletError('INVALID_ADDRESS', 'The recipient cannot be the sending wallet.');
        return {
          method: 'PrepareTronTransaction',
          params: { network, walletId: wallet.id, ...transaction, mode: 'native' }
        };
      },
      (op) => this.selectTronFee(op)
    );
  }

  private prepareTronCallInternal(
    id: string,
    network: TronNetwork,
    call: { contract: string; method: string; args: TronAbiArg[] },
    maxFee: string | undefined,
    submissionMode: SubmissionMode
  ): Promise<StoredChainOperation> {
    return this.prepareChainLocked(
      id,
      'tron',
      'contractCall',
      { network, ...call, maxFee },
      { network, call, ...(maxFee ? { maxFee } : {}) },
      submissionMode,
      (wallet) => {
        if (call.contract === wallet.address)
          throw new WalletError('INVALID_CALL', 'Calls to the wallet itself are not allowed.');
        return {
          method: 'PrepareTronContractCall',
          params: {
            network,
            walletId: wallet.id,
            contract: call.contract,
            method: call.method,
            args: call.args,
            mode: 'native'
          }
        };
      },
      (op) => this.selectTronFee(op)
    );
  }

  private selectTronFee(op: StoredChainOperation): FeeOption | undefined {
    const quote = op.quote!;
    if (quote.sponsored) return undefined;
    if (!op.maxFee)
      throw new WalletError(
        'SPONSORSHIP_REQUIRED',
        'Delegated resources do not cover this transaction. Delegate energy and bandwidth to the wallet, or set maxFee to pay in TRX.',
        409
      );
    const options = quote.feeOptions.filter(
      (option) => option.token.symbol === 'TRX' && option.token.type.toUpperCase() === 'NATIVE'
    );
    if (options.length !== 1 || options[0].value === '0')
      throw new WalletError('INVALID_RESPONSE', 'WaaS quoted no single TRX fee.', 502);
    if (BigInt(options[0].value) > BigInt(op.maxFee))
      throw new WalletError(
        'FEE_LIMIT_EXCEEDED',
        `The quoted fee of ${options[0].value} sun exceeds maxFee.`,
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
    assertReviewId(op, reviewId);
    if (op.status !== 'quoted') return this.refreshChain(op);
    if (!op.quote.sponsored && !op.fee)
      throw new WalletError('SPONSORSHIP_REQUIRED', 'This transaction is not sponsored.', 409);
    await this.core.expireBeforeSubmit(op);
    const state = await this.core.load();
    await this.core.ensure(state, [family]);
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
    if (!op.quote || !['submitting', 'pending', 'unknown'].includes(op.status)) return op;
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
    stored: Partial<StoredChainOperation> = {}
  ): Promise<StoredChainOperation> {
    const { operation, hash } = await this.core.existingAny(id, kind, input, family, 'review');
    if (operation) return operation as StoredChainOperation;
    const state = await this.core.load();
    await this.core.ensure(state, [family]);
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
