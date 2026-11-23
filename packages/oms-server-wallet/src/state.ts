import { z } from 'zod';

import type { Credential, NetworkFamily, RemoteWallet } from './protocol.js';
import type { StateStore } from './storage.js';

import { WalletError } from './errors.js';
import { credentialId, isWalletAddress, NETWORK_FAMILIES, walletSchema } from './protocol.js';

/**
 * Persisted under the `wallet` key. Version 2 keeps one wallet per network family; records from
 * 0.2.x and 0.3.x (one EVM wallet, no version) are migrated when first loaded.
 */
export interface State {
  version: 2;
  wallets: Partial<Record<NetworkFamily, RemoteWallet>>;
  credential?: Credential;
  disabled: boolean;
  /** Families whose create request has an unknown outcome; discovery settles them first. */
  creating: NetworkFamily[];
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
/** 0.2.x and 0.3.x always wrote both flags, so a record without them is not theirs. */
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
  creating: z.array(z.enum(NETWORK_FAMILIES)).max(NETWORK_FAMILIES.length)
});

const invalid = () =>
  new WalletError('INVALID_STATE', 'Stored wallet state is not in a recognised format.', 500);

/** Read and validate the state, migrating a 0.2.x/0.3.x record. `migrated` means it must be saved. */
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
