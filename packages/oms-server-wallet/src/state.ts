import { z } from 'zod';

import type { Credential, NetworkFamily, RemoteWallet } from './protocol.js';
import type { StateStore } from './storage.js';

import { WalletError } from './errors.js';
import {
  chainQuoteSchema,
  credentialId,
  feeOptionSchema,
  isWalletAddress,
  NETWORK_FAMILIES,
  quoteSchema,
  walletSchema
} from './protocol.js';

/**
 * Persisted under the `wallet` key. Version 2 keeps one wallet per network family; records from
 * 0.2.x (one EVM wallet, no version) are migrated when first loaded.
 */
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
}

const storedWallet = (family: NetworkFamily) =>
  walletSchema.refine((wallet) => isWalletAddress(family, wallet.address));

const credentialSchema = z.object({
  privateJwk: z.looseObject({ kty: z.literal('EC'), crv: z.literal('P-256'), d: z.string() }),
  id: z.string().regex(/^0x04[0-9a-fA-F]{128}$/),
  credentialId: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/)
    .optional(),
  nonce: z.string().regex(/^[0-9]{1,30}$/),
  expiresAt: z.string().optional()
});

/** 0.2.x always wrote both flags, so a record without them is not theirs. */
const legacySchema = z.strictObject({
  wallet: storedWallet('evm').optional(),
  credential: credentialSchema.optional(),
  disabled: z.boolean(),
  creating: z.boolean()
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
  swapsCoordinated: z.boolean().optional()
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
  'expired'
] as const;

const submissionModeSchema = z.enum(['review', 'immediate']);

const storedEvmOperationSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum([
    'transfer',
    'userOperation',
    'call',
    'sign',
    'signTypedData',
    'deployment',
    'recovery'
  ]),
  inputHash: z.string().min(1),
  createdAt: z.string().min(1),
  status: z.enum(operationStatusValues),
  chainId: z.number().int(),
  submissionMode: submissionModeSchema.optional(),
  reviewId: z.string().min(1).optional(),
  submitted: z.boolean().optional(),
  preSubmitExpired: z.boolean().optional(),
  preClaimRefused: z.boolean().optional(),
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
  error: z.string().optional()
});

const storedChainOperationSchema = z.strictObject({
  id: z.string().min(1),
  family: z.enum(['solana', 'tron']),
  kind: z.enum(['transfer', 'transaction', 'contractCall', 'sign', 'signTypedData']),
  network: z.string().optional(),
  inputHash: z.string().min(1),
  createdAt: z.string().min(1),
  status: z.enum(operationStatusValues),
  submissionMode: submissionModeSchema.optional(),
  reviewId: z.string().min(1).optional(),
  submitted: z.boolean().optional(),
  preSubmitExpired: z.boolean().optional(),
  preClaimRefused: z.boolean().optional(),
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
  error: z.string().optional()
});

export type StoredEvmOperation = z.infer<typeof storedEvmOperationSchema>;
export type StoredChainOperation = z.infer<typeof storedChainOperationSchema>;
export type StoredOperationRecord = StoredEvmOperation | StoredChainOperation;

const invalid = (message = 'Stored wallet state is not in a recognised format.') =>
  new WalletError('INVALID_STATE', message, 500);

/** Validate a stored operation record (including 0.2.x records); fail closed on unrecognized data. */
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

/** Validate a stored string-array operation index. */
export function parseOperationIndex(raw: string | null): string[] {
  if (raw === null) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw invalid('Stored operation index is not valid JSON.');
  }
  const parsed = z.array(z.string().min(1)).safeParse(json);
  if (!parsed.success) throw invalid('Stored operation index is not in a recognised format.');
  return parsed.data;
}

/** Validate the stored open-operation index. */
export function parseOpenOperationIndex(
  raw: string | null
): { synced: number; ids: string[] } | null {
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw invalid('Stored open-operation index is not valid JSON.');
  }
  const parsed = z
    .strictObject({ synced: z.number().int().min(0), ids: z.array(z.string().min(1)) })
    .safeParse(json);
  if (!parsed.success) throw invalid('Stored open-operation index is not in a recognised format.');
  return parsed.data;
}

/** Read and validate the state, migrating a 0.2.x record. `migrated` means it must be saved. */
export async function readState(store: StateStore): Promise<{ state: State; migrated: boolean }> {
  const value = await store.read('wallet');
  if (value === null)
    return { state: { version: 2, wallets: {}, disabled: false, creating: [] }, migrated: false };
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    throw invalid();
  }
  let state: State;
  let migrated = false;
  if (json && typeof json === 'object' && 'version' in json) {
    const parsed = stateSchema.safeParse(json);
    if (!parsed.success) throw invalid();
    state = parsed.data as State;
  } else {
    const parsed = legacySchema.safeParse(json);
    if (!parsed.success) throw invalid();
    const { wallet, credential, disabled, creating } = parsed.data;
    state = {
      version: 2,
      wallets: wallet ? { evm: wallet } : {},
      ...(credential ? { credential: credential as Credential } : {}),
      disabled,
      creating: creating && !wallet ? ['evm'] : []
    };
    migrated = true;
  }
  // Upgrade encrypted records created before RPC identifiers were stored separately.
  if (state.credential && !state.credential.credentialId) {
    state.credential.credentialId = await credentialId(state.credential.id);
    migrated = true;
  }
  return { state, migrated };
}

export function writeState(store: StateStore, state: State): Promise<void> {
  return store.write('wallet', JSON.stringify(state));
}
