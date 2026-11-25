import { z } from 'zod';

import type { WalletErrorCode } from './errors.js';
import type { Credential, NetworkFamily, RemoteWallet } from './protocol.js';
import type { StateStore } from './storage.js';

import { isWalletErrorCode, WalletError } from './errors.js';
import {
  chainQuoteSchema,
  feeOptionSchema,
  isWalletAddress,
  NETWORK_FAMILIES,
  quoteSchema,
  walletSchema
} from './protocol.js';

/** Persisted under the `wallet` key. Holds one wallet per network family and active coordination state. */
export interface State {
  version: 2;
  wallets: Partial<Record<NetworkFamily, RemoteWallet>>;
  credential?: Credential;
  disabled: boolean;
  /** Families whose create request has an unknown outcome; discovery settles them first. */
  creating: NetworkFamily[];
  /**
   * Set once Trails swaps coordination is active for this wallet so a separately constructed plain
   * handle pointing at the same state refuses EVM debits instead of bypassing swap reservations.
   */
  swapsCoordinated?: boolean;
  /**
   * Authoritative active swap/recovery chain reservations (`swapId -> chainId`) persisted inside
   * wallet state under the shared executor so a misconfigured worker with an empty swap store
   * cannot bypass active debit reservations.
   */
  swapReservations?: Record<string, number>;
}

const storedWallet = (family: NetworkFamily) =>
  walletSchema.refine((wallet) => isWalletAddress(family, wallet.address));

const credentialSchema = z.object({
  privateJwk: z.looseObject({ kty: z.literal('EC'), crv: z.literal('P-256'), d: z.string() }),
  id: z.string().regex(/^0x04[0-9a-fA-F]{128}$/),
  credentialId: z.string().regex(/^0x[0-9a-f]{64}$/),
  nonce: z.string().regex(/^[0-9]{1,30}$/),
  expiresAt: z.string().optional()
});

const stateSchema = z.strictObject({
  version: z.literal(2),
  wallets: z.object({
    evm: storedWallet('evm').optional(),
    solana: storedWallet('solana').optional(),
    tron: storedWallet('tron').optional()
  }),
  credential: credentialSchema.optional(),
  disabled: z.boolean(),
  creating: z.array(z.enum(NETWORK_FAMILIES)).max(NETWORK_FAMILIES.length),
  swapsCoordinated: z.boolean().optional(),
  swapReservations: z.record(z.string().min(1), z.number().int().positive()).optional()
});

const operationStatusValues = [
  'preparing',
  'quoted',
  'submitting',
  'pending',
  'executed',
  'failed',
  'unknown',
  'signed',
  'expired',
  'cancelled'
] as const;

const submissionModeSchema = z.enum(['review', 'immediate']);

/**
 * The guarantees an operation's status carries (see `OperationState` in the public types). A
 * stored record that breaks one is unrecognised state and fails closed, so code that reads
 * records (execute, refresh, the swaps coordinator) can rely on them.
 */
export function operationStateProblem(op: {
  readonly status: string;
  readonly quote?: { readonly sponsored?: boolean } | undefined;
  readonly reviewId?: string;
  readonly signature?: string;
  readonly verified?: boolean;
  readonly family?: string;
  readonly fee?: unknown;
  readonly feeIndex?: number;
}): string | undefined {
  const submitted =
    op.status === 'submitting' || op.status === 'pending' || op.status === 'executed';
  if (op.status === 'quoted' && (!op.quote || !op.reviewId))
    return 'A quoted operation must have its quote and reviewId.';
  if (submitted && !op.quote) return 'A submitted operation must have its quote.';
  if (op.status === 'signed' && (!op.signature || op.verified !== true))
    return 'A signed operation must have its verified signature.';
  if (
    op.family !== undefined &&
    op.quote?.sponsored === false &&
    (op.status === 'quoted' || submitted) &&
    (op.fee === undefined || op.feeIndex === undefined)
  )
    return 'An unsponsored quote must have its selected fee and fee index.';
  return undefined;
}

const storedEvmOperationSchema = z
  .strictObject({
    id: z.string().min(1),
    kind: z.enum(['transfer', 'call', 'sign', 'signTypedData', 'deployment', 'recovery']),
    inputHash: z.string().min(1),
    createdAt: z.string().min(1),
    status: z.enum(operationStatusValues),
    chainId: z.number().int(),
    submissionMode: submissionModeSchema,
    indexed: z.boolean().optional(),
    internal: z.boolean().optional(),
    reviewId: z.string().min(1).optional(),
    submitted: z.boolean().optional(),
    preSubmitExpired: z.boolean().optional(),
    preClaimRefused: z.boolean().optional(),
    operatorResolved: z.boolean().optional(),
    transfer: z
      .object({
        chainId: z.number().int(),
        to: z.string(),
        asset: z.string(),
        amount: z.string()
      })
      .optional(),
    transaction: z
      .object({
        to: z.string(),
        data: z.string(),
        value: z.string()
      })
      .optional(),
    quote: quoteSchema.optional(),
    signature: z.string().optional(),
    verified: z.boolean().optional(),
    txnHash: z.string().optional(),
    // Only SDK error codes are recorded; anything else is unrecognised state and fails closed.
    error: z.custom<WalletErrorCode>(isWalletErrorCode).optional()
  })
  .superRefine((op, ctx) => {
    const problem = operationStateProblem(op);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

const storedChainOperationSchema = z
  .strictObject({
    id: z.string().min(1),
    family: z.enum(['solana', 'tron']),
    kind: z.enum(['transfer', 'transaction', 'contractCall', 'sign', 'signTypedData']),
    network: z.string().optional(),
    inputHash: z.string().min(1),
    createdAt: z.string().min(1),
    status: z.enum(operationStatusValues),
    submissionMode: submissionModeSchema,
    indexed: z.boolean().optional(),
    reviewId: z.string().min(1).optional(),
    submitted: z.boolean().optional(),
    preSubmitExpired: z.boolean().optional(),
    preClaimRefused: z.boolean().optional(),
    operatorResolved: z.boolean().optional(),
    quote: chainQuoteSchema.optional(),
    fee: feeOptionSchema.optional(),
    feeIndex: z.number().int().min(0).optional(),
    transfer: z
      .object({
        network: z.string(),
        to: z.string(),
        asset: z.string(),
        amount: z.string()
      })
      .optional(),
    transaction: z
      .object({
        to: z.string(),
        value: z.string(),
        data: z.string().optional()
      })
      .optional(),
    call: z
      .object({
        contract: z.string(),
        method: z.string(),
        args: z.array(z.object({ type: z.string(), value: z.unknown() })).optional()
      })
      .optional(),
    maxFee: z.string().optional(),
    signature: z.string().optional(),
    verified: z.boolean().optional(),
    txnHash: z.string().optional(),
    // Only SDK error codes are recorded; anything else is unrecognised state and fails closed.
    error: z.custom<WalletErrorCode>(isWalletErrorCode).optional()
  })
  .superRefine((op, ctx) => {
    const problem = operationStateProblem(op);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

export type StoredEvmOperation = z.infer<typeof storedEvmOperationSchema>;
export type StoredChainOperation = z.infer<typeof storedChainOperationSchema>;
export type StoredOperationRecord = StoredEvmOperation | StoredChainOperation;

const invalid = (message = 'Stored wallet state is not in a recognised format.') =>
  new WalletError('INVALID_STATE', message, 500);

/** Validate a stored operation record; fail closed on unrecognized data. */
export function parseStoredOperation(raw: string): StoredOperationRecord {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw invalid('Stored operation record is not valid JSON.');
  }
  if (!json || typeof json !== 'object')
    throw invalid('Stored operation record is not in a recognised format.');
  if ('family' in json) {
    const parsed = storedChainOperationSchema.safeParse(json);
    if (!parsed.success)
      throw invalid('Stored chain operation record is not in a recognised format.');
    return parsed.data;
  }
  const parsed = storedEvmOperationSchema.safeParse(json);
  if (!parsed.success) throw invalid('Stored EVM operation record is not in a recognised format.');
  return parsed.data;
}

export const OPERATION_INDEX_CHUNK_SIZE = 256;
export const OPERATION_INDEX_BUCKETS = ['evm', 'solana', 'tron', 'internal'] as const;
export type OperationIndexBucket = (typeof OPERATION_INDEX_BUCKETS)[number];

export interface OperationIndexMeta {
  v: 1;
  chunks: number;
  total: number;
}

/** Validate a stored per-bucket chunked operation index metadata record. */
export function parseOperationIndexMeta(raw: string | null): OperationIndexMeta {
  if (raw === null) return { v: 1, chunks: 0, total: 0 };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw invalid('Stored operation index metadata is not valid JSON.');
  }
  const parsed = z
    .strictObject({
      v: z.literal(1),
      chunks: z.number().int().min(0),
      total: z.number().int().min(0)
    })
    .safeParse(json);
  if (
    !parsed.success ||
    parsed.data.chunks !== Math.ceil(parsed.data.total / OPERATION_INDEX_CHUNK_SIZE)
  )
    throw invalid('Stored operation index metadata is not in a recognised format.');
  return parsed.data;
}

/** Validate a stored chunk of operation IDs (at most `OPERATION_INDEX_CHUNK_SIZE` entries). */
export function parseOperationIndexChunk(raw: string | null): string[] {
  if (raw === null) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw invalid('Stored operation index chunk is not valid JSON.');
  }
  const parsed = z.array(z.string().min(1)).max(OPERATION_INDEX_CHUNK_SIZE).safeParse(json);
  if (!parsed.success) throw invalid('Stored operation index chunk is not in a recognised format.');
  return parsed.data;
}

/** Validate the stored open-operation index. */
export function parseOpenOperationIndex(raw: string | null): { v: 1; ids: string[] } | null {
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw invalid('Stored open-operation index is not valid JSON.');
  }
  const parsed = z
    .strictObject({
      v: z.literal(1),
      ids: z.array(z.string().min(1))
    })
    .safeParse(json);
  if (!parsed.success) throw invalid('Stored open-operation index is not in a recognised format.');
  return parsed.data;
}

/** Pure read-only load and strict validation of persisted wallet state. */
export async function readState(store: StateStore): Promise<State> {
  const value = await store.read('wallet');
  if (value === null) return { version: 2, wallets: {}, disabled: false, creating: [] };
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    throw invalid();
  }
  const parsed = stateSchema.safeParse(json);
  if (!parsed.success) throw invalid();
  return parsed.data as State;
}

export function writeState(store: StateStore, state: State): Promise<void> {
  return store.write('wallet', JSON.stringify(state));
}
