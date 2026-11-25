import type { Abi, Hex } from 'viem';

import { encodeFunctionData, getAddress, isAddress, isHex, parseUnits } from 'viem';
import { z } from 'zod';

import type { StoredEvmOperation } from '../state.js';
import type {
  EvmTransfer,
  SolanaNetwork,
  SolanaTransfer,
  TronAbiArg,
  TronNetwork,
  TronTransfer
} from '../types.js';

import { requireChain } from '../environment.js';
import { WalletError } from '../errors.js';
import { base58Decode, isSolanaAddress, isTronAddress } from '../internal/protocol/addresses.js';
import { SOLANA_NETWORKS, TRON_NETWORKS } from '../internal/protocol/networks.js';
import { WaasErrorCode } from '../internal/protocol/waasErrors.js';
import { canonicalJson } from '../json.js';

export const MAX_MESSAGE_BYTES = 16_384;
export const loneSurrogate =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const isTronSignature = (value: string) => /^0x[0-9a-fA-F]{130}$/.test(value);
export const isSolanaSignature = (value: string) => base58Decode(value)?.length === 64;
export const isTronTxid = (value: string) => /^[0-9a-f]{64}$/.test(value);
export const abiTypeRegex =
  /^(address|bool|string|bytes([1-9]|[12][0-9]|3[0-2])?|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?)(\[[0-9]{0,3}\])*$/;

export const evmSignatureSchema = z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]+$/) });
export const chainSignatureSchema = z.object({ signature: z.string().min(1).max(512) });
export const validSchema = z.object({ isValid: z.boolean() });
export const okSchema = z.object({ ok: z.literal(true) });

export const transferSchema = z
  .object({
    chainId: z.number().int(),
    to: z.string(),
    asset: z.string(),
    amount: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .max(78)
  })
  .strict();

export const credentialRejectedCodes: ReadonlySet<number> = new Set([
  WaasErrorCode.KeyNotFound,
  WaasErrorCode.KeyExpired,
  WaasErrorCode.Unauthorized
]);

export const OPEN_STATUSES: ReadonlySet<string> = new Set([
  'preparing',
  'quoted',
  'submitting',
  'pending',
  'unknown'
]);

export const PUBLIC_EVM_KINDS: ReadonlySet<StoredEvmOperation['kind']> = new Set([
  'transfer',
  'call',
  'sign',
  'signTypedData'
]);

export function isInternalEvmOperation(op: StoredEvmOperation): boolean {
  return op.internal === true || op.id.startsWith('swp_') || !PUBLIC_EVM_KINDS.has(op.kind);
}

/**
 * Whether a refresh can still learn something: the operation is in flight, or it executed but its
 * transaction hash has not been reported yet.
 */
export function needsRefresh(op: { readonly status: string; readonly txnHash?: string }): boolean {
  return (
    op.status === 'submitting' ||
    op.status === 'pending' ||
    op.status === 'unknown' ||
    (op.status === 'executed' && !op.txnHash)
  );
}

export const PUBLIC_EVM_TX_KINDS: readonly StoredEvmOperation['kind'][] = ['transfer', 'call'];

/** Convert a human-readable decimal token amount into a positive base-unit decimal string. */
export function parseAmount(value: string, decimals: number): string {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) ||
    (value.split('.')[1]?.length ?? 0) > decimals
  )
    throw new WalletError(
      'INVALID_AMOUNT',
      'Enter a positive amount within the token’s decimal precision.'
    );
  const amount = parseUnits(value, decimals);
  if (amount <= 0n || amount >= 2n ** 256n)
    throw new WalletError('INVALID_AMOUNT', 'Amount is outside the supported range.');
  return amount.toString();
}

export function validateIdempotencyKey(id: unknown, allowSwapsPrefix = false): string {
  if (
    typeof id !== 'string' ||
    !/^[A-Za-z0-9_-]{8,100}$/.test(id) ||
    (!allowSwapsPrefix && id.startsWith('swp_'))
  )
    throw new WalletError(
      'INVALID_IDEMPOTENCY_KEY',
      'An operation ID of 8–100 letters, digits, underscores or hyphens is required (and must not start with "swp_").'
    );
  return id;
}

/** A WaaS transaction ID as returned in `quote.txnId`: 1–256 printable ASCII characters. */
export function validateTxnId(txnId: unknown): string {
  if (typeof txnId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(txnId))
    throw new WalletError('INVALID_INPUT', 'Provide the txnId from an operation quote.');
  return txnId;
}

export function validateReviewId(reviewId: unknown): string {
  if (typeof reviewId !== 'string' || reviewId.length < 8 || reviewId.length > 128)
    throw new WalletError(
      'STALE_REVIEW',
      'A valid reviewId from the prepared operation is required.',
      409
    );
  return reviewId;
}

/** Require the caller's `reviewId` to match the one bound to the prepared operation. */
export function assertReviewId(op: { readonly reviewId?: string }, reviewId: string | undefined) {
  if (!op.reviewId || op.reviewId !== reviewId)
    throw new WalletError(
      'STALE_REVIEW',
      'Review ID does not match this prepared operation. Review the current terms before executing.',
      409
    );
}

export function normalizeEvmTransfer(input: {
  chainId: unknown;
  to: unknown;
  asset: unknown;
  amount: unknown;
}): EvmTransfer {
  const parsed = transferSchema.safeParse(input);
  if (!parsed.success)
    throw new WalletError(
      'INVALID_TRANSFER',
      'Provide a chain, recipient, asset, and positive base-unit amount.'
    );
  const transfer = parsed.data;
  requireChain(transfer.chainId);
  if (!isAddress(transfer.to) || (transfer.asset !== 'native' && !isAddress(transfer.asset)))
    throw new WalletError('INVALID_ADDRESS', 'Provide valid EVM recipient and token addresses.');
  const to = getAddress(transfer.to);
  const asset = transfer.asset === 'native' ? 'native' : getAddress(transfer.asset);
  if (BigInt(transfer.amount) >= 2n ** 256n)
    throw new WalletError('INVALID_AMOUNT', 'Amount exceeds uint256.');
  return { chainId: transfer.chainId, to, asset, amount: transfer.amount };
}

export const abiCallFields = [
  'idempotencyKey',
  'chainId',
  'to',
  'value',
  'abi',
  'functionName',
  'args'
];
export const rawCallFields = ['idempotencyKey', 'chainId', 'to', 'value', 'data'];

export function normalizeEvmCall(input: unknown): {
  idempotencyKey: string;
  chainId: number;
  transaction: { to: string; value: string; data: Hex };
} {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new WalletError('INVALID_CALL', 'Provide a chain and the call to make.');
  const fields = Object.fromEntries(
    Object.entries(input).filter(([, item]) => item !== undefined)
  ) as Record<string, unknown>;
  const idempotencyKey = validateIdempotencyKey(fields.idempotencyKey);
  if (typeof fields.chainId !== 'number' || !Number.isInteger(fields.chainId))
    throw new WalletError('INVALID_CALL', 'Provide a chain and the call to make.');
  requireChain(fields.chainId);
  const raw = 'data' in fields;
  if (raw && ['abi', 'functionName', 'args'].some((key) => key in fields))
    throw new WalletError('INVALID_CALL', 'Provide either an ABI call or hex calldata, not both.');
  const unexpected = Object.keys(fields).find(
    (key) => !(raw ? rawCallFields : abiCallFields).includes(key)
  );
  if (unexpected) throw new WalletError('INVALID_CALL', `Unexpected call field "${unexpected}".`);
  if (typeof fields.to !== 'string' || !isAddress(fields.to))
    throw new WalletError('INVALID_ADDRESS', 'Provide a valid EVM contract address.');
  const value = 'value' in fields ? fields.value : '0';
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,77})$/.test(value) ||
    BigInt(value) >= 2n ** 256n
  )
    throw new WalletError(
      'INVALID_AMOUNT',
      'Provide the call value as a base-unit decimal string.'
    );
  let data: unknown;
  if (raw) data = fields.data;
  else {
    const { abi, functionName, args } = fields;
    if (
      !Array.isArray(abi) ||
      typeof functionName !== 'string' ||
      !(args === undefined || Array.isArray(args))
    )
      throw new WalletError(
        'INVALID_CALL',
        'Provide an ABI, the name of a function in it and its arguments.'
      );
    if (
      !abi.some(
        (item: unknown) =>
          !!item &&
          typeof item === 'object' &&
          (item as { type?: unknown }).type === 'function' &&
          (item as { name?: unknown }).name === functionName
      )
    )
      throw new WalletError('INVALID_CALL', `The ABI has no function named "${functionName}".`);
    try {
      data = encodeFunctionData({
        abi: abi as Abi,
        functionName,
        args: args as readonly unknown[]
      });
    } catch {
      throw new WalletError(
        'INVALID_CALL',
        'The ABI, function name and arguments do not encode a valid call.'
      );
    }
  }
  if (typeof data !== 'string' || !isHex(data, { strict: true }) || data.length % 2)
    throw new WalletError('INVALID_CALL', 'Calldata must be 0x-prefixed, even-length hex.');
  return {
    idempotencyKey,
    chainId: fields.chainId,
    transaction: { to: getAddress(fields.to), value, data: data.toLowerCase() as Hex }
  };
}

export function normalizeSolanaTransfer(input: unknown): {
  idempotencyKey: string;
  transfer: SolanaTransfer;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new WalletError('INVALID_TRANSFER', 'Provide a network, recipient, asset and amount.');
  const fields = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as Record<string, unknown>;
  const unexpected = Object.keys(fields).find(
    (key) => !['idempotencyKey', 'network', 'to', 'asset', 'amount'].includes(key)
  );
  if (unexpected)
    throw new WalletError('INVALID_TRANSFER', `Unexpected transfer field "${unexpected}".`);
  const idempotencyKey = validateIdempotencyKey(fields.idempotencyKey);
  const { network, to, asset, amount } = fields;
  if (!SOLANA_NETWORKS.includes(network as SolanaNetwork))
    throw new WalletError('UNSUPPORTED_NETWORK', 'Select solana:mainnet or solana:devnet.');
  if (!isSolanaAddress(to) || (asset !== 'native' && !isSolanaAddress(asset)))
    throw new WalletError(
      'INVALID_ADDRESS',
      'Provide a base58 Solana recipient, and "native" or a token mint address.'
    );
  if (
    typeof amount !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(amount) ||
    BigInt(amount) >= 2n ** 64n
  )
    throw new WalletError(
      'INVALID_AMOUNT',
      'Provide a positive base-unit amount that fits in 64 bits.'
    );
  return {
    idempotencyKey,
    transfer: { network: network as SolanaNetwork, to, asset, amount }
  };
}

export function requireTronNetwork(network: unknown): TronNetwork {
  if (!TRON_NETWORKS.includes(network as TronNetwork))
    throw new WalletError('UNSUPPORTED_NETWORK', 'Select tron:mainnet or tron:nile.');
  return network as TronNetwork;
}

export const isSun = (value: unknown, allowZero: boolean) =>
  typeof value === 'string' &&
  /^(0|[1-9][0-9]{0,18})$/.test(value) &&
  BigInt(value) < 2n ** 63n &&
  (allowZero || value !== '0');

export function requireTronMaxQuotedFee(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isSun(value, false))
    throw new WalletError('INVALID_FEE', 'Set maxQuotedFee as a positive amount of sun.');
  return value as string;
}

export function normalizeTronFields(
  input: unknown,
  allowed: readonly string[],
  code: 'INVALID_TRANSFER' | 'INVALID_CALL'
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new WalletError(code, 'Provide the Tron transaction to prepare.');
  const record = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  );
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected) throw new WalletError(code, `Unexpected field "${unexpected}".`);
  return record;
}

/** A TRX transfer (below 2^63 sun) or a TRC-20 `transfer(address,uint256)` (uint256 units). */
export function normalizeTronTransfer(input: unknown): {
  idempotencyKey: string;
  transfer: TronTransfer;
  maxQuotedFee?: string;
} {
  const record = normalizeTronFields(
    input,
    ['idempotencyKey', 'network', 'to', 'asset', 'amount', 'maxQuotedFee'],
    'INVALID_TRANSFER'
  );
  const idempotencyKey = validateIdempotencyKey(record.idempotencyKey);
  const network = requireTronNetwork(record.network);
  const { to, asset, amount } = record;
  if (!isTronAddress(to) || (asset !== 'native' && !isTronAddress(asset)))
    throw new WalletError(
      'INVALID_ADDRESS',
      'Provide a Base58Check recipient and "native" or a TRC-20 contract address (T…).'
    );
  if (to === asset)
    throw new WalletError('INVALID_ADDRESS', 'The recipient cannot be the token contract.');
  const valid =
    asset === 'native'
      ? isSun(amount, false)
      : typeof amount === 'string' &&
        /^[1-9][0-9]{0,77}$/.test(amount) &&
        BigInt(amount) < 2n ** 256n;
  if (!valid)
    throw new WalletError(
      'INVALID_AMOUNT',
      asset === 'native'
        ? 'A TRX transfer needs a positive amount of sun below 2^63.'
        : 'A TRC-20 transfer needs a positive base-unit amount below 2^256.'
    );
  return {
    idempotencyKey,
    transfer: { network, to: to as string, asset: asset as string, amount: amount as string },
    maxQuotedFee: requireTronMaxQuotedFee(record.maxQuotedFee)
  };
}

/** Normalized Tron call: ABI form (`call`) or calldata form (`transaction`), never both. */
export type NormalizedTronCall =
  | { call: { to: string; method: string; args: TronAbiArg[] }; transaction?: undefined }
  | { transaction: { to: string; value: string; data: `0x${string}` }; call?: undefined };

export function normalizeTronCall(input: unknown): {
  idempotencyKey: string;
  network: TronNetwork;
  target: NormalizedTronCall;
  maxQuotedFee?: string;
} {
  const record = normalizeTronFields(
    input,
    ['idempotencyKey', 'network', 'to', 'method', 'args', 'data', 'value', 'maxQuotedFee'],
    'INVALID_CALL'
  );
  const idempotencyKey = validateIdempotencyKey(record.idempotencyKey);
  const network = requireTronNetwork(record.network);
  if (!isTronAddress(record.to))
    throw new WalletError('INVALID_ADDRESS', 'Provide a Base58Check contract address (T…).');
  const to = record.to as string;
  const maxQuotedFee = requireTronMaxQuotedFee(record.maxQuotedFee);
  const abiForm = record.method !== undefined || record.args !== undefined;
  if (abiForm === (record.data !== undefined) || (abiForm && record.value !== undefined))
    throw new WalletError(
      'INVALID_CALL',
      'Provide either method (with optional args) or data (with optional value), not both.'
    );
  if (!abiForm) {
    const data = record.data;
    if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data))
      throw new WalletError('INVALID_CALL', 'Calldata must be 0x-prefixed, even-length hex.');
    const value = record.value ?? '0';
    if (!isSun(value, true))
      throw new WalletError('INVALID_AMOUNT', 'Provide the call value in sun.');
    return {
      idempotencyKey,
      network,
      target: {
        transaction: { to, value: value as string, data: data.toLowerCase() as `0x${string}` }
      },
      maxQuotedFee
    };
  }
  if (typeof record.method !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(record.method))
    throw new WalletError('INVALID_CALL', 'Provide the function name alone, such as "approve".');
  const args = record.args ?? [];
  if (
    !Array.isArray(args) ||
    args.length > 32 ||
    args.some(
      (arg) =>
        !arg ||
        typeof arg !== 'object' ||
        Object.keys(arg).some((key) => key !== 'type' && key !== 'value') ||
        typeof (arg as { type?: unknown }).type !== 'string' ||
        !abiTypeRegex.test((arg as { type: string }).type) ||
        !('value' in arg)
    )
  )
    throw new WalletError(
      'INVALID_CALL',
      'Provide up to 32 arguments, each an ABI type and its value.'
    );
  const snapshot = JSON.parse(canonicalJson(args, 65_536)) as TronAbiArg[];
  return {
    idempotencyKey,
    network,
    target: { call: { to, method: record.method, args: snapshot } },
    maxQuotedFee
  };
}

export function requireMessage(message: unknown, checkSurrogates: boolean): string {
  if (
    typeof message !== 'string' ||
    !message ||
    (checkSurrogates && loneSurrogate.test(message)) ||
    new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES
  )
    throw new WalletError('INVALID_MESSAGE', 'Messages must contain 1–16,384 UTF-8 bytes.');
  return message;
}
