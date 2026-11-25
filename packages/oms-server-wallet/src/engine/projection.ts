import type { StoredChainOperation, StoredEvmOperation, StoredOperationRecord } from '../state.js';
import type {
  EvmOperation,
  ListOperationsOptions,
  OperationPage,
  SolanaNetwork,
  SolanaOperation,
  TronNetwork,
  TronOperation,
  WalletOperation
} from '../types.js';

import { WalletError } from '../errors.js';
import { operationStateProblem } from '../state.js';

export function computeProvenUnsent(op: StoredOperationRecord): boolean {
  if (op.status === 'preparing' || op.status === 'cancelled') return true;
  if (op.status === 'expired') return op.preSubmitExpired === true;
  if (op.status === 'failed') {
    if (op.kind === 'sign' || op.kind === 'signTypedData') return false;
    // Require affirmative evidence that Execute never claimed or broadcast the transaction.
    return op.preClaimRefused === true || op.submitted === false;
  }
  return false;
}

/** Fail closed if a record breaks its status guarantees before casting it to the public type. */
function assertOperationState(op: StoredOperationRecord): void {
  const problem = operationStateProblem(op);
  if (problem) throw new WalletError('INVALID_STATE', problem, 500);
}

export function projectEvmOperation(op: StoredEvmOperation): EvmOperation {
  assertOperationState(op);
  return {
    id: op.id,
    family: 'evm',
    kind: op.kind as EvmOperation['kind'],
    chainId: op.chainId,
    inputHash: op.inputHash,
    createdAt: op.createdAt,
    status: op.status,
    submissionMode: op.submissionMode,
    provenUnsent: computeProvenUnsent(op),
    ...(op.operatorResolved === true ? { operatorResolved: true as const } : {}),
    ...(op.reviewId ? { reviewId: op.reviewId } : {}),
    ...(op.transfer ? { transfer: { ...op.transfer } } : {}),
    ...(op.transaction ? { transaction: { ...op.transaction } } : {}),
    ...(op.quote ? { quote: { ...op.quote } } : {}),
    ...(op.signature ? { signature: op.signature } : {}),
    ...(op.status === 'signed' && op.verified === true ? { verified: true as const } : {}),
    ...(op.txnHash ? { txnHash: op.txnHash } : {}),
    ...(op.error ? { error: op.error } : {})
  } as EvmOperation;
}

export function projectSolanaOperation(op: StoredChainOperation): SolanaOperation {
  assertOperationState(op);
  return {
    id: op.id,
    family: 'solana',
    kind: op.kind as SolanaOperation['kind'],
    inputHash: op.inputHash,
    createdAt: op.createdAt,
    status: op.status,
    submissionMode: op.submissionMode,
    provenUnsent: computeProvenUnsent(op),
    ...(op.operatorResolved === true ? { operatorResolved: true as const } : {}),
    ...(op.network ? { network: op.network as SolanaNetwork } : {}),
    ...(op.reviewId ? { reviewId: op.reviewId } : {}),
    ...(op.transfer
      ? {
          transfer: {
            network: op.transfer.network as SolanaNetwork,
            to: op.transfer.to,
            asset: op.transfer.asset,
            amount: op.transfer.amount
          }
        }
      : {}),
    ...(op.quote ? { quote: structuredClone(op.quote) } : {}),
    ...(op.signature ? { signature: op.signature } : {}),
    ...(op.status === 'signed' && op.verified === true ? { verified: true as const } : {}),
    ...(op.txnHash ? { txnHash: op.txnHash } : {}),
    ...(op.error ? { error: op.error } : {})
  } as SolanaOperation;
}

export function projectTronOperation(op: StoredChainOperation): TronOperation {
  assertOperationState(op);
  return {
    id: op.id,
    family: 'tron',
    kind: op.kind as TronOperation['kind'],
    inputHash: op.inputHash,
    createdAt: op.createdAt,
    status: op.status,
    submissionMode: op.submissionMode,
    provenUnsent: computeProvenUnsent(op),
    ...(op.operatorResolved === true ? { operatorResolved: true as const } : {}),
    ...(op.network ? { network: op.network as TronNetwork } : {}),
    ...(op.reviewId ? { reviewId: op.reviewId } : {}),
    ...(op.transfer
      ? { transfer: { ...op.transfer, network: op.transfer.network as TronNetwork } }
      : {}),
    ...(op.transaction
      ? {
          transaction: {
            to: op.transaction.to,
            value: op.transaction.value,
            data: op.transaction.data as `0x${string}`
          }
        }
      : {}),
    ...(op.call
      ? {
          call: {
            to: op.call.to,
            method: op.call.method,
            args: structuredClone(op.call.args)
          }
        }
      : {}),
    ...(op.maxQuotedFee ? { maxQuotedFee: op.maxQuotedFee } : {}),
    ...(op.quote ? { quote: structuredClone(op.quote) } : {}),
    ...(op.fee ? { fee: structuredClone(op.fee) } : {}),
    ...(op.signature ? { signature: op.signature } : {}),
    ...(op.status === 'signed' && op.verified === true ? { verified: true as const } : {}),
    ...(op.txnHash ? { txnHash: op.txnHash } : {}),
    ...(op.error ? { error: op.error } : {})
  } as TronOperation;
}

export function parseListOptions(options: ListOperationsOptions = {}): {
  status: 'open' | 'all';
  limit: number;
  offset: number;
} {
  const status = options.status ?? 'all';
  if (status !== 'open' && status !== 'all')
    throw new WalletError('INVALID_PAGE', 'status must be "open" or "all".');
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new WalletError('INVALID_PAGE', 'limit must be an integer between 1 and 200.');
  let offset = 0;
  if (options.cursor !== undefined) {
    if (typeof options.cursor !== 'string' || !/^[0-9]{1,9}$/.test(options.cursor))
      throw new WalletError('INVALID_PAGE', 'Invalid pagination cursor.');
    offset = Number(options.cursor);
  }
  return { status, limit, offset };
}

export function paginate<T extends WalletOperation>(
  items: T[],
  offset: number,
  limit: number
): OperationPage<T> {
  const slice = items.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  return {
    items: slice,
    ...(nextOffset < items.length ? { nextCursor: String(nextOffset) } : {})
  };
}
