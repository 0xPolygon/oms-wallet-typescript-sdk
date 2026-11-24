import { z } from 'zod';

import { bytesToHex, utf8 } from './encoding.js';
import { isSolanaAddress, isTronAddress } from './internal/protocol/addresses.js';
import {
  walletRequestPreimage,
  walletSignatureHeader
} from './internal/protocol/requestSigning.js';

/** Request and response shapes follow WaaS v1.2.0 (`waas.ridl`), checked here with zod. */
export const NETWORK_FAMILIES = ['evm', 'solana', 'tron'] as const;
export type NetworkFamily = (typeof NETWORK_FAMILIES)[number];
const familyByType: Record<string, NetworkFamily> = {
  ethereum: 'evm',
  solana: 'solana',
  tron: 'tron'
};

/** Wallet identity returned by WaaS. */
export interface RemoteWallet {
  readonly id: string;
  readonly address: string;
  readonly reference?: string;
  readonly networkFamily?: string;
  readonly implementation?: string;
  readonly type?: string;
  readonly keyOrigin?: string;
}

/** Addresses are checked per family once the family is known; see `walletFamily`. */
export const walletSchema = z.object({
  id: z.string().min(1),
  address: z.string().min(1).max(64),
  reference: z.string().optional(),
  networkFamily: z.string().optional(),
  implementation: z.string().optional(),
  type: z.string().optional(),
  keyOrigin: z.string().optional()
});

export function isWalletAddress(family: NetworkFamily, address: string): boolean {
  if (family === 'solana') return isSolanaAddress(address);
  if (family === 'tron') return isTronAddress(address);
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}
/** EVM addresses compare case-insensitively; base58 Solana and Tron addresses only exactly. */
export function sameAddress(family: NetworkFamily, a: string, b: string): boolean {
  return family === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
/** The family of a listed wallet, or undefined for a family this SDK does not use. */
export function walletFamily(wallet: RemoteWallet): NetworkFamily | undefined {
  const byFamily = NETWORK_FAMILIES.find((family) => family === wallet.networkFamily);
  const byType = wallet.type === undefined ? undefined : familyByType[wallet.type];
  // A wallet whose two fields disagree is not trusted as either family.
  if (byFamily && byType && byFamily !== byType) return undefined;
  return byFamily ?? byType;
}
export const credentialSchema = z.object({
  credentialId: z.string(),
  expiresAt: z.string().datetime({ offset: true })
});
export const pageSchema = z.object({ cursor: z.string().optional(), limit: z.number().optional() });
export const authSchema = z.object({
  identity: z.object({ type: z.literal('oidc'), iss: z.string(), sub: z.string() }),
  wallets: z.array(walletSchema),
  page: pageSchema.optional(),
  credential: credentialSchema
});
export const listSchema = z.object({ wallets: z.array(walletSchema), page: pageSchema.optional() });
export const statusSchema = z.object({
  status: z.enum(['quoted', 'pending', 'executed', 'failed']),
  txnHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional()
    .or(z.literal('').transform(() => undefined))
});
/** Sponsored EVM transaction quote returned by WaaS. */
export interface Quote {
  readonly txnId: string;
  readonly status: 'quoted';
  readonly sponsored: boolean;
  readonly expiresAt: string;
}

export const quoteSchema = z.object({
  txnId: z.string().min(1),
  status: z.literal('quoted'),
  sponsored: z.boolean(),
  expiresAt: z.string().datetime({ offset: true })
});

/** Single fee option offered by WaaS for a non-sponsored chain transaction. */
export interface FeeOption {
  readonly token: {
    readonly network: string;
    readonly name: string;
    readonly symbol: string;
    readonly type: string;
    readonly decimals?: number;
    readonly contractAddress?: string;
    readonly tokenID?: string;
  };
  readonly value: string;
  readonly displayValue: string;
}

const nullAsMissing = (value: unknown) => (value === null ? undefined : value);

export const feeOptionSchema = z.object({
  token: z.object({
    network: z.string(),
    name: z.string(),
    symbol: z.string().min(1).max(32),
    type: z.string(),
    // WaaS sends null, not an omitted field, for values a token does not have (TRX decimals).
    decimals: z.preprocess(nullAsMissing, z.number().int().min(0).max(255).optional()),
    contractAddress: z.preprocess(nullAsMissing, z.string().optional()),
    tokenID: z.preprocess(nullAsMissing, z.string().optional())
  }),
  value: z.string().regex(/^(0|[1-9][0-9]{0,77})$/),
  displayValue: z.string()
});

/** Solana or Tron transaction quote returned by WaaS. */
export interface ChainQuote extends Quote {
  readonly feeOptions: readonly FeeOption[];
}

/** v1.2.0 adds fee options to every quote. Older servers send `null`, read as none. */
export const chainQuoteSchema = quoteSchema.extend({
  feeOptions: z
    .array(feeOptionSchema)
    .max(16)
    .nullish()
    .transform((options) => options ?? [])
});
export interface Credential {
  privateJwk: JsonWebKey;
  /** Raw uncompressed public key used in the request signature header. */
  id: string;
  /** WaaS RPC identifier: SHA-256 of the key type and compressed public key. */
  credentialId: string;
  nonce: string;
  expiresAt?: string;
}

export async function credentialId(publicKey: string): Promise<string> {
  if (!/^0x04[0-9a-fA-F]{128}$/.test(publicKey)) throw new Error('Invalid P-256 public key');
  const raw = Uint8Array.from(publicKey.slice(2).match(/../g)!, (hex) => parseInt(hex, 16));
  const typedCompressed = new Uint8Array(34);
  typedCompressed[0] = 0; // WaaS KeyType_P256
  typedCompressed[1] = 2 + (raw[64] & 1);
  typedCompressed.set(raw.subarray(1, 33), 2);
  return `0x${bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', typedCompressed)))}`;
}

export async function generateCredential(): Promise<Credential> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify'
  ]);
  const id = `0x${bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))}`;
  return {
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    id,
    credentialId: await credentialId(id),
    nonce: '0'
  };
}
export async function signatureHeader(
  credential: Credential,
  path: string,
  scope: string,
  body: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'jwk',
    credential.privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const preimage = walletRequestPreimage(path, credential.nonce, scope, body);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    utf8(preimage)
  );
  return walletSignatureHeader({
    algorithm: 'ecdsa-p256-sha256',
    scope,
    credential: credential.id,
    nonce: credential.nonce,
    signature: `0x${bytesToHex(new Uint8Array(signature))}`
  });
}
