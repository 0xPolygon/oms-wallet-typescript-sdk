import type { Abi, Hex } from 'viem';

import { encodeFunctionData, erc20Abi, getAddress, isAddress, isHex, parseUnits } from 'viem';
import { z } from 'zod';

import type { RecoveryTransaction } from './authorization.js';
import type { CoordinatorGate, LockedEnginePrimitives } from './internal/swapsBridge.js';
import type { FeeOption, NetworkFamily, RemoteWallet } from './protocol.js';
import type {
  State,
  StoredChainOperation,
  StoredEvmOperation,
  StoredOperationRecord
} from './state.js';
import type { ExclusiveExecutor, StateStore } from './storage.js';
import type { RpcTransport } from './transport.js';
import type {
  EvmOperation,
  EvmTransfer,
  EvmTransferInput,
  ListOperationsOptions,
  OperationPage,
  ResolveReconciliationInput,
  SolanaNetwork,
  SolanaOperation,
  SolanaTransfer,
  SolanaTransferInput,
  SubmissionMode,
  TronAbiArg,
  TronContractCallInput,
  TronNetwork,
  TronOperation,
  TronTransactionInput,
  TypedDataInput,
  WalletOperation,
  WalletSnapshot
} from './types.js';

import { requireRecoveryPermit } from './authorization.js';
import { sha256 } from './encoding.js';
import { requireChain } from './environment.js';
import { UpstreamError, WalletError } from './errors.js';
import { base58Decode, isSolanaAddress, isTronAddress } from './internal/protocol/addresses.js';
import { SOLANA_NETWORKS, TRON_CHAIN_IDS, TRON_NETWORKS } from './internal/protocol/networks.js';
import { nextWalletNonce } from './internal/protocol/requestSigning.js';
import { WaasErrorCode } from './internal/protocol/waasErrors.js';
import { canonicalJson } from './json.js';
import {
  authSchema,
  chainQuoteSchema,
  generateCredential,
  isWalletAddress,
  listSchema,
  NETWORK_FAMILIES,
  quoteSchema,
  sameAddress,
  statusSchema,
  walletFamily,
  walletSchema
} from './protocol.js';
import {
  CLAIM_GRACE_MS,
  refreshStatus,
  settleExecuteError,
  TRANSACTION_EXPIRED
} from './settlement.js';
import {
  parseOpenOperationIndex,
  parseOperationIndex,
  parseStoredOperation,
  readState,
  writeState
} from './state.js';
import { validateTronTypedData, validateTypedData } from './typed-data.js';

const MAX_MESSAGE_BYTES = 16_384;
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const isTronSignature = (value: string) => /^0x[0-9a-fA-F]{130}$/.test(value);
const isSolanaSignature = (value: string) => base58Decode(value)?.length === 64;
const isTronTxid = (value: string) => /^[0-9a-f]{64}$/.test(value);
const abiTypeRegex =
  /^(address|bool|string|bytes([1-9]|[12][0-9]|3[0-2])?|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?)(\[[0-9]{0,3}\])*$/;

const evmSignatureSchema = z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]+$/) });
const chainSignatureSchema = z.object({ signature: z.string().min(1).max(512) });
const validSchema = z.object({ isValid: z.boolean() });
const okSchema = z.object({ ok: z.literal(true) });

const transferSchema = z
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

const credentialRejectedCodes: ReadonlySet<number> = new Set([
  WaasErrorCode.KeyNotFound,
  WaasErrorCode.KeyExpired,
  WaasErrorCode.Unauthorized
]);

const OPEN_STATUSES: ReadonlySet<string> = new Set([
  'preparing',
  'quoted',
  'submitting',
  'pending',
  'unknown'
]);

const PUBLIC_EVM_KINDS: ReadonlySet<StoredEvmOperation['kind']> = new Set([
  'transfer',
  'call',
  'sign',
  'signTypedData'
]);

function isInternalEvmOperation(op: StoredEvmOperation): boolean {
  return op.internal === true || op.id.startsWith('swp_') || !PUBLIC_EVM_KINDS.has(op.kind);
}

const PUBLIC_EVM_TX_KINDS: readonly StoredEvmOperation['kind'][] = ['transfer', 'call'];

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

function validateIdempotencyKey(id: unknown, allowSwapsPrefix = false): string {
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

function validateReviewId(reviewId: unknown): string {
  if (typeof reviewId !== 'string' || reviewId.length < 8 || reviewId.length > 128)
    throw new WalletError(
      'STALE_REVIEW',
      'A valid reviewId from the prepared operation is required.',
      409
    );
  return reviewId;
}

function normalizeEvmTransfer(input: {
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

const abiCallFields = ['idempotencyKey', 'chainId', 'to', 'value', 'abi', 'functionName', 'args'];
const rawCallFields = ['idempotencyKey', 'chainId', 'to', 'value', 'data'];

function normalizeEvmCall(input: unknown): {
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

function normalizeSolanaTransfer(input: unknown): {
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

function requireTronNetwork(network: unknown): TronNetwork {
  if (!TRON_NETWORKS.includes(network as TronNetwork))
    throw new WalletError('UNSUPPORTED_NETWORK', 'Select tron:mainnet or tron:nile.');
  return network as TronNetwork;
}

const isSun = (value: unknown, allowZero: boolean) =>
  typeof value === 'string' &&
  /^(0|[1-9][0-9]{0,18})$/.test(value) &&
  BigInt(value) < 2n ** 63n &&
  (allowZero || value !== '0');

function requireTronMaxFee(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isSun(value, false))
    throw new WalletError('INVALID_FEE', 'Set maxFee as a positive amount of sun.');
  return value as string;
}

function normalizeTronFields(
  input: unknown,
  allowed: readonly string[],
  code: 'INVALID_TRANSACTION' | 'INVALID_CALL'
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

function normalizeTronTransaction(input: unknown): {
  idempotencyKey: string;
  network: TronNetwork;
  transaction: { to: string; value: string; data?: `0x${string}` };
  maxFee?: string;
} {
  const record = normalizeTronFields(
    input,
    ['idempotencyKey', 'network', 'to', 'value', 'data', 'maxFee'],
    'INVALID_TRANSACTION'
  );
  const idempotencyKey = validateIdempotencyKey(record.idempotencyKey);
  const network = requireTronNetwork(record.network);
  if (!isTronAddress(record.to))
    throw new WalletError('INVALID_ADDRESS', 'Provide a Base58Check Tron address (T…).');
  const value = record.value ?? '0';
  const data = record.data;
  if (data !== undefined && (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)))
    throw new WalletError('INVALID_CALL', 'Calldata must be 0x-prefixed, even-length hex.');
  if (!isSun(value, data !== undefined))
    throw new WalletError(
      'INVALID_AMOUNT',
      data === undefined
        ? 'A TRX transfer needs a positive amount of sun.'
        : 'Provide the call value in sun.'
    );
  return {
    idempotencyKey,
    network,
    transaction: {
      to: record.to as string,
      value: value as string,
      ...(data === undefined ? {} : { data: (data as string).toLowerCase() as `0x${string}` })
    },
    maxFee: requireTronMaxFee(record.maxFee)
  };
}

function normalizeTronContractCall(input: unknown): {
  idempotencyKey: string;
  network: TronNetwork;
  call: { contract: string; method: string; args: TronAbiArg[] };
  maxFee?: string;
} {
  const record = normalizeTronFields(
    input,
    ['idempotencyKey', 'network', 'contract', 'method', 'args', 'maxFee'],
    'INVALID_CALL'
  );
  const idempotencyKey = validateIdempotencyKey(record.idempotencyKey);
  const network = requireTronNetwork(record.network);
  if (!isTronAddress(record.contract))
    throw new WalletError('INVALID_ADDRESS', 'Provide a Base58Check contract address (T…).');
  if (typeof record.method !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(record.method))
    throw new WalletError('INVALID_CALL', 'Provide the function name alone, such as "transfer".');
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
    call: { contract: record.contract as string, method: record.method, args: snapshot },
    maxFee: requireTronMaxFee(record.maxFee)
  };
}

function requireMessage(message: unknown, checkSurrogates: boolean): string {
  if (
    typeof message !== 'string' ||
    !message ||
    (checkSurrogates && loneSurrogate.test(message)) ||
    new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES
  )
    throw new WalletError('INVALID_MESSAGE', 'Messages must contain 1–16,384 UTF-8 bytes.');
  return message;
}

function computeProvenUnsent(op: StoredOperationRecord): boolean {
  if (op.status === 'preparing') return true;
  if (op.status === 'expired') return op.preSubmitExpired === true;
  if (op.status === 'failed') {
    if (op.kind === 'sign' || op.kind === 'signTypedData') return false;
    // Require affirmative evidence that Execute never claimed or broadcast the transaction.
    return op.preClaimRefused === true || op.submitted === false;
  }
  return false;
}

export function projectEvmOperation(op: StoredEvmOperation): EvmOperation {
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
  };
}

export function projectSolanaOperation(op: StoredChainOperation): SolanaOperation {
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
  };
}

export function projectTronOperation(op: StoredChainOperation): TronOperation {
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
    ...(op.transaction
      ? {
          transaction: {
            to: op.transaction.to,
            value: op.transaction.value,
            ...(op.transaction.data !== undefined
              ? { data: op.transaction.data as `0x${string}` }
              : {})
          }
        }
      : {}),
    ...(op.call
      ? {
          call: {
            contract: op.call.contract,
            method: op.call.method,
            ...(op.call.args ? { args: structuredClone(op.call.args) } : {})
          }
        }
      : {}),
    ...(op.maxFee ? { maxFee: op.maxFee } : {}),
    ...(op.quote ? { quote: structuredClone(op.quote) } : {}),
    ...(op.fee ? { fee: structuredClone(op.fee) } : {}),
    ...(op.signature ? { signature: op.signature } : {}),
    ...(op.status === 'signed' && op.verified === true ? { verified: true as const } : {}),
    ...(op.txnHash ? { txnHash: op.txnHash } : {}),
    ...(op.error ? { error: op.error } : {})
  };
}

function parseListOptions(options: ListOperationsOptions = {}): {
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

function paginate<T extends WalletOperation>(
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

export interface WalletEngineConfig {
  readonly namespace: string;
  readonly origin?: string;
  readonly subject: string;
  readonly issuer: string;
  readonly audience: string;
  readonly getIdToken: () => Promise<{ readonly token: string; readonly expiresAt: number }>;
  readonly sessionLifetimeSeconds?: number;
  readonly store: StateStore;
  readonly executor: ExclusiveExecutor;
  readonly transport: RpcTransport;
  readonly clock?: () => number;
}

/**
 * Core internal wallet engine owning identity state, credential nonces, WaaS authentication,
 * reviewId / submissionMode enforcement, and locked primitives shared with the Trails coordinator.
 */
export class WalletEngine {
  private gate?: CoordinatorGate;
  private readonly now: () => number;

  constructor(private readonly config: WalletEngineConfig) {
    if (!config.subject || config.subject.length > 128)
      throw new WalletError(
        'INVALID_IDENTITY',
        'Wallet identifiers must contain 1–128 characters.'
      );
    this.now = config.clock ?? (() => Date.now());
  }

  /** Attach the swaps debit gate once, before exposing any public wallet facade. */
  attachGate(gate: CoordinatorGate): void {
    if (this.gate)
      throw new WalletError('CONFIGURATION', 'Swaps coordinator is already attached.', 503);
    this.gate = gate;
  }

  /** Package-private locked primitives given solely to the bound swaps coordinator. */
  lockedPrimitives(): LockedEnginePrimitives {
    return {
      namespace: this.config.namespace,
      origin: this.config.origin,
      runLocked: (task) => this.config.executor.run(task),
      inspectLocked: async () => {
        const state = await this.load();
        return { wallet: state.wallets.evm, disabled: state.disabled };
      },
      markSwapsCoordinatedLocked: async () => {
        const state = await this.load();
        if (!state.swapsCoordinated) {
          state.swapsCoordinated = true;
          await this.save(state);
        }
      },
      readSwapReservationsLocked: async () => {
        const state = await this.load();
        return { ...(state.swapReservations ?? {}) };
      },
      setSwapReservationLocked: async (swapId, chainId) => {
        const state = await this.load();
        const next: Record<string, number> = { ...(state.swapReservations ?? {}) };
        if (chainId === null) {
          if (!(swapId in next)) return;
          delete next[swapId];
        } else {
          if (next[swapId] === chainId) return;
          next[swapId] = chainId;
        }
        state.swapReservations = Object.keys(next).length > 0 ? next : undefined;
        await this.save(state);
      },
      resolveEvmReconciliationLocked: (id, txnId) =>
        this.resolveEvmReconciliationInternal(id, txnId, { allowInternal: true }),
      readEvmOperationsLocked: async (ids) => {
        const out: StoredEvmOperation[] = [];
        for (const id of new Set(ids)) {
          const op = await this.readEvmOperation(id);
          if (op) out.push(op);
        }
        return out;
      },
      listOpenEvmOperationsLocked: async () => {
        const out: StoredEvmOperation[] = [];
        for (const id of await this.openOperationIds()) {
          const op = await this.readEvmOperation(id);
          if (op && OPEN_STATUSES.has(op.status)) out.push(op);
        }
        return out;
      },
      refreshEvmOperationLocked: async (id) => {
        const op = await this.readEvmOperation(id);
        return op ? this.refreshEvm(op) : null;
      },
      prepareEvmTransferLocked: (id, transfer, options) =>
        this.prepareEvmTransferInternal(id, transfer, 'immediate', options),
      executeEvmOperationLocked: (id, kinds, options) =>
        this.executeEvmInternal(id, kinds, undefined, options),
      prepareDeploymentLocked: (id, chainId) => this.prepareInternalEvm(id, chainId, 'deployment'),
      prepareRecoveryLocked: (id, transaction) => {
        requireRecoveryPermit(transaction);
        return this.prepareInternalEvm(id, transaction.chainId, 'recovery', transaction);
      },
      signEvmTypedDataLocked: (id, chainId, typedData, options) =>
        this.signEvmTypedDataInternal(id, chainId, typedData, options)
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────────────────

  inspect(): Promise<WalletSnapshot> {
    return this.config.executor.run(async () => this.snapshot(await this.load()));
  }

  /** Snapshot one family's initialized address under lock, then release before external I/O. */
  async snapshotAddress(family: NetworkFamily): Promise<string | undefined> {
    return this.config.executor.run(async () => (await this.load()).wallets[family]?.address);
  }

  async createOrRestore(families: readonly NetworkFamily[] = ['evm']): Promise<WalletSnapshot> {
    if (
      !Array.isArray(families) ||
      !families.length ||
      families.some((family) => !NETWORK_FAMILIES.includes(family))
    )
      throw new WalletError('INVALID_FAMILY', 'Request one or more of: evm, solana, tron.');
    return this.config.executor.run(async () => {
      const state = await this.load();
      await this.ensure(state, [...new Set(families)]);
      return this.snapshot(state);
    });
  }

  rotateCredential(): Promise<WalletSnapshot> {
    return this.config.executor.run(async () => {
      const state = await this.load();
      if (state.disabled)
        throw new WalletError('WALLET_DISABLED', 'Enable the wallet before rotating.', 409);
      await this.revoke(state);
      await this.ensure(state, this.held(state));
      return this.snapshot(state);
    });
  }

  disable(): Promise<WalletSnapshot> {
    return this.config.executor.run(async () => {
      const state = await this.load();
      state.disabled = true;
      await this.save(state);
      await this.revoke(state);
      return this.snapshot(state);
    });
  }

  enable(): Promise<WalletSnapshot> {
    return this.config.executor.run(async () => {
      const state = await this.load();
      await this.revoke(state);
      state.disabled = false;
      await this.save(state);
      await this.ensure(state, this.held(state));
      return this.snapshot(state);
    });
  }

  // ── EVM Public Methods ─────────────────────────────────────────────────────────────────────

  async prepareEvmTransfer(input: EvmTransferInput): Promise<EvmOperation> {
    const id = validateIdempotencyKey(input?.idempotencyKey);
    const transfer = normalizeEvmTransfer({
      chainId: input.chainId,
      to: input.to,
      asset: input.asset,
      amount: input.amount
    });
    return this.config.executor.run(async () =>
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
    return this.config.executor.run(async () => {
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
    return this.config.executor.run(async () =>
      projectEvmOperation(
        await this.prepareEvmCallInternal(idempotencyKey, chainId, transaction, 'review')
      )
    );
  }

  async sendEvmCall(input: unknown): Promise<EvmOperation> {
    const { idempotencyKey, chainId, transaction } = normalizeEvmCall(input);
    return this.config.executor.run(async () => {
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
    return this.config.executor.run(async () =>
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
    return this.config.executor.run(async () => {
      const { operation, hash } = await this.existingEvm(id, 'sign', { chainId, message: text });
      if (operation) return projectEvmOperation(operation);
      const state = await this.load();
      await this.ensure(state, ['evm']);
      const op: StoredEvmOperation = {
        id,
        kind: 'sign',
        chainId,
        inputHash: hash,
        createdAt: new Date(this.now()).toISOString(),
        status: 'unknown',
        submissionMode: 'review'
      };
      await this.writeOperation(op);
      const signed = await this.recordEvmSignature(op, async () => {
        const result = evmSignatureSchema.parse(
          await this.activeCall(state, 'SignMessage', {
            network: String(chainId),
            walletId: state.wallets.evm!.id,
            message: text
          })
        );
        const validity = validSchema.parse(
          await this.config.transport.request('IsValidMessageSignature', {
            network: String(chainId),
            networkFamily: 'evm',
            walletAddress: state.wallets.evm!.address,
            message: text,
            signature: result.signature
          })
        );
        return { signature: result.signature, valid: validity.isValid };
      });
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
    if (
      validated.typedData.domain.name === 'Sequence Wallet' &&
      validated.typedData.primaryType === 'Calls'
    )
      throw new WalletError(
        'INVALID_TYPED_DATA',
        'Sequence Wallet Calls authorizations cannot be signed through public signTypedData; use the reviewed recovery workflow.'
      );
    return this.config.executor.run(async () =>
      projectEvmOperation(
        await this.signEvmTypedDataValidated(id, chainId, validated.typedData, validated.digest, {
          rejectSelfVerifyingContract: true
        })
      )
    );
  }

  async resolveEvmReconciliation(input: ResolveReconciliationInput): Promise<EvmOperation> {
    const { idempotencyKey, txnId } = this.validateResolveInput(input);
    return this.config.executor.run(async () =>
      projectEvmOperation(
        await this.resolveEvmReconciliationInternal(idempotencyKey, txnId, { allowInternal: false })
      )
    );
  }

  getEvmOperationLocal(id: string): Promise<EvmOperation | null> {
    return this.config.executor.run(async () => {
      const op = await this.readEvmOperation(id);
      return op && !isInternalEvmOperation(op) ? projectEvmOperation(op) : null;
    });
  }

  refreshEvmOperation(id: string): Promise<EvmOperation | null> {
    return this.config.executor.run(async () => {
      const op = await this.readEvmOperation(id);
      if (!op || isInternalEvmOperation(op)) return null;
      return projectEvmOperation(await this.refreshEvm(op));
    });
  }

  listEvmOperations(options?: ListOperationsOptions): Promise<OperationPage<EvmOperation>> {
    const { status, limit, offset } = parseListOptions(options);
    return this.config.executor.run(async () => {
      const ids =
        status === 'open'
          ? await this.openOperationIds()
          : parseOperationIndex(await this.config.store.read('operationIndex'));
      const operations: EvmOperation[] = [];
      for (const id of ids) {
        const op = await this.readEvmOperation(id);
        if (!op || isInternalEvmOperation(op)) continue;
        if (status === 'open' && !OPEN_STATUSES.has(op.status)) continue;
        operations.push(projectEvmOperation(op));
      }
      return paginate(operations, offset, limit);
    });
  }

  // ── Solana Public Methods ──────────────────────────────────────────────────────────────────

  async prepareSolanaTransfer(input: SolanaTransferInput): Promise<SolanaOperation> {
    const { idempotencyKey, transfer } = normalizeSolanaTransfer(input);
    return this.config.executor.run(async () =>
      projectSolanaOperation(
        await this.prepareSolanaTransferInternal(idempotencyKey, transfer, 'review')
      )
    );
  }

  async sendSolanaTransfer(input: SolanaTransferInput): Promise<SolanaOperation> {
    const { idempotencyKey, transfer } = normalizeSolanaTransfer(input);
    return this.config.executor.run(async () => {
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
    return this.config.executor.run(async () =>
      projectSolanaOperation(await this.executeChainInternal('solana', id, ['transfer'], rev))
    );
  }

  async signSolanaMessage(idempotencyKey: string, message: string): Promise<SolanaOperation> {
    const id = validateIdempotencyKey(idempotencyKey);
    const text = requireMessage(message, true);
    return this.config.executor.run(async () => {
      const op = await this.signChainLocked(
        id,
        'solana',
        'sign',
        { message: text },
        (wallet) => ({
          method: 'SignMessage',
          params: { network: '', walletId: wallet.id, message: text }
        }),
        (wallet, signature) => ({
          valid: isSolanaSignature(signature),
          method: 'IsValidMessageSignature',
          params: {
            networkFamily: 'solana',
            walletAddress: wallet.address,
            message: text,
            signature
          }
        })
      );
      return projectSolanaOperation(op);
    });
  }

  getSolanaOperationLocal(id: string): Promise<SolanaOperation | null> {
    return this.config.executor.run(async () => {
      const op = await this.readChainOperation(id, 'solana');
      return op ? projectSolanaOperation(op) : null;
    });
  }

  refreshSolanaOperation(id: string): Promise<SolanaOperation | null> {
    return this.config.executor.run(async () => {
      const op = await this.readChainOperation(id, 'solana');
      return op ? projectSolanaOperation(await this.refreshChain(op)) : null;
    });
  }

  async resolveSolanaReconciliation(input: ResolveReconciliationInput): Promise<SolanaOperation> {
    const { idempotencyKey, txnId } = this.validateResolveInput(input);
    return this.config.executor.run(async () =>
      projectSolanaOperation(
        await this.resolveChainReconciliationInternal('solana', idempotencyKey, txnId)
      )
    );
  }

  listSolanaOperations(options?: ListOperationsOptions): Promise<OperationPage<SolanaOperation>> {
    const { status, limit, offset } = parseListOptions(options);
    return this.config.executor.run(async () => {
      const ids =
        status === 'open'
          ? await this.openOperationIds()
          : parseOperationIndex(await this.config.store.read('operationIndex'));
      const operations: SolanaOperation[] = [];
      for (const id of ids) {
        const op = await this.readChainOperation(id, 'solana');
        if (!op) continue;
        if (status === 'open' && !OPEN_STATUSES.has(op.status)) continue;
        operations.push(projectSolanaOperation(op));
      }
      return paginate(operations, offset, limit);
    });
  }

  // ── Tron Public Methods ────────────────────────────────────────────────────────────────────

  async prepareTronTransaction(input: TronTransactionInput): Promise<TronOperation> {
    const { idempotencyKey, network, transaction, maxFee } = normalizeTronTransaction(input);
    return this.config.executor.run(async () =>
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
    return this.config.executor.run(async () => {
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
    return this.config.executor.run(async () =>
      projectTronOperation(
        await this.prepareTronCallInternal(idempotencyKey, network, call, maxFee, 'review')
      )
    );
  }

  async sendTronContractCall(input: TronContractCallInput): Promise<TronOperation> {
    const { idempotencyKey, network, call, maxFee } = normalizeTronContractCall(input);
    return this.config.executor.run(async () => {
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
    return this.config.executor.run(async () =>
      projectTronOperation(
        await this.executeChainInternal('tron', id, ['transaction', 'contractCall'], rev)
      )
    );
  }

  async signTronMessage(idempotencyKey: string, message: string): Promise<TronOperation> {
    const id = validateIdempotencyKey(idempotencyKey);
    const text = requireMessage(message, true);
    return this.config.executor.run(async () => {
      const op = await this.signChainLocked(
        id,
        'tron',
        'sign',
        { message: text },
        (wallet) => ({
          method: 'SignMessage',
          params: { network: '', walletId: wallet.id, message: text }
        }),
        (wallet, signature) => ({
          valid: isTronSignature(signature),
          method: 'IsValidMessageSignature',
          params: { networkFamily: 'tron', walletAddress: wallet.address, message: text, signature }
        })
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
    return this.config.executor.run(async () => {
      const op = await this.signChainLocked(
        id,
        'tron',
        'signTypedData',
        { network: validNetwork, digest },
        (wallet) => ({
          method: 'SignTypedData',
          params: { network: '', walletId: wallet.id, typedData }
        }),
        (wallet, signature) => ({
          valid: isTronSignature(signature),
          method: 'IsValidTypedDataSignature',
          params: {
            networkFamily: 'tron',
            walletAddress: wallet.address,
            typedData,
            signature
          }
        }),
        { network: validNetwork }
      );
      return projectTronOperation(op);
    });
  }

  getTronOperationLocal(id: string): Promise<TronOperation | null> {
    return this.config.executor.run(async () => {
      const op = await this.readChainOperation(id, 'tron');
      return op ? projectTronOperation(op) : null;
    });
  }

  refreshTronOperation(id: string): Promise<TronOperation | null> {
    return this.config.executor.run(async () => {
      const op = await this.readChainOperation(id, 'tron');
      return op ? projectTronOperation(await this.refreshChain(op)) : null;
    });
  }

  async resolveTronReconciliation(input: ResolveReconciliationInput): Promise<TronOperation> {
    const { idempotencyKey, txnId } = this.validateResolveInput(input);
    return this.config.executor.run(async () =>
      projectTronOperation(
        await this.resolveChainReconciliationInternal('tron', idempotencyKey, txnId)
      )
    );
  }

  listTronOperations(options?: ListOperationsOptions): Promise<OperationPage<TronOperation>> {
    const { status, limit, offset } = parseListOptions(options);
    return this.config.executor.run(async () => {
      const ids =
        status === 'open'
          ? await this.openOperationIds()
          : parseOperationIndex(await this.config.store.read('operationIndex'));
      const operations: TronOperation[] = [];
      for (const id of ids) {
        const op = await this.readChainOperation(id, 'tron');
        if (!op) continue;
        if (status === 'open' && !OPEN_STATUSES.has(op.status)) continue;
        operations.push(projectTronOperation(op));
      }
      return paginate(operations, offset, limit);
    });
  }

  // ── Internal Locked EVM Helpers ────────────────────────────────────────────────────────────

  private async checkEvmDebitGate(
    state: State,
    chainId: number,
    exceptOperationId?: string,
    skipGate = false
  ): Promise<void> {
    if (skipGate) return;
    if (state.swapsCoordinated && !this.gate)
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
    if (this.gate) await this.gate.assertChainAvailableLocked(chainId, { exceptOperationId });
  }

  private async computeReviewId(params: Record<string, unknown>): Promise<string> {
    return sha256(canonicalJson({ v: 1, ...params }));
  }

  private async prepareEvmTransferInternal(
    id: string,
    transfer: EvmTransfer,
    submissionMode: SubmissionMode,
    options: { allowSwapsPrefix?: boolean; skipGate?: boolean } = {}
  ): Promise<StoredEvmOperation> {
    const { operation, hash } = await this.existingEvm(
      id,
      'transfer',
      transfer,
      submissionMode,
      options.allowSwapsPrefix
    );
    if (operation) return operation;
    let state = await this.load();
    await this.checkEvmDebitGate(state, transfer.chainId, id, options.skipGate);
    // Reload state after the debit gate in case gate refreshes advanced the nonce or rotated credentials.
    state = await this.load();
    await this.ensure(state, ['evm']);
    const op: StoredEvmOperation = {
      id,
      kind: 'transfer',
      inputHash: hash,
      createdAt: new Date(this.now()).toISOString(),
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
    const { operation, hash } = await this.existingEvm(
      id,
      'call',
      { chainId, ...transaction },
      submissionMode,
      false
    );
    if (operation) return operation;
    let state = await this.load();
    await this.checkEvmDebitGate(state, chainId, id, false);
    // Reload state after the debit gate in case gate refreshes advanced the nonce or rotated credentials.
    state = await this.load();
    await this.ensure(state, ['evm']);
    if (transaction.to.toLowerCase() === state.wallets.evm!.address.toLowerCase())
      throw new WalletError('INVALID_CALL', 'Calls to the wallet itself are not allowed.');
    const op: StoredEvmOperation = {
      id,
      kind: 'call',
      inputHash: hash,
      createdAt: new Date(this.now()).toISOString(),
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

  private async prepareInternalEvm(
    id: string,
    chainId: number,
    kind: 'deployment' | 'recovery',
    transaction?: RecoveryTransaction
  ): Promise<StoredEvmOperation> {
    requireChain(chainId);
    const state = await this.load();
    await this.ensure(state, ['evm']);
    if (transaction && transaction.owner !== state.wallets.evm!.address.toLowerCase())
      throw new WalletError('INVALID_RECOVERY', 'Recovery belongs to a different wallet.');
    const call = transaction
      ? { to: transaction.to, data: transaction.data, value: transaction.value }
      : { to: state.wallets.evm!.address, data: '0x', value: '0' };
    const { operation, hash } = await this.existingEvm(
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
      createdAt: new Date(this.now()).toISOString()
    };
    return this.quoteEvm(op, state, call, 'Recovery and deployment require gas sponsorship.');
  }

  private async quoteEvm(
    op: StoredEvmOperation,
    state: State,
    call: { to: string; value: string; data?: string },
    unsponsored: string
  ): Promise<StoredEvmOperation> {
    await this.writeOperation(op);
    try {
      op.quote = quoteSchema.parse(
        await this.activeCall(state, 'PrepareEthereumTransaction', {
          network: String(op.chainId),
          walletId: state.wallets.evm!.id,
          ...call,
          mode: 'relayer'
        })
      );
      if (!op.quote.sponsored) throw new WalletError('SPONSORSHIP_REQUIRED', unsponsored, 409);
      op.reviewId = await this.computeReviewId({
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
      await this.writeOperation(op);
      return op;
    } catch (error) {
      op.status = 'failed';
      op.error = error instanceof WalletError ? error.code : 'PREPARATION_FAILED';
      await this.writeOperation(op);
      throw error;
    }
  }

  private async executeEvmInternal(
    id: string,
    kinds: readonly StoredEvmOperation['kind'][],
    reviewId?: string,
    options: { skipGate?: boolean; bypassReviewId?: boolean } = {}
  ): Promise<StoredEvmOperation> {
    const op = await this.readEvmOperation(id);
    if (!op || !kinds.includes(op.kind))
      throw new WalletError('NOT_FOUND', 'Prepared transaction not found.', 404);
    if (!options.bypassReviewId) {
      if (!op.reviewId || op.reviewId !== reviewId)
        throw new WalletError(
          'STALE_REVIEW',
          'Review ID does not match this prepared operation. Review the current terms before executing.',
          409
        );
    }
    if (op.status !== 'quoted') return this.refreshEvm(op);
    if (!op.quote?.sponsored)
      throw new WalletError('SPONSORSHIP_REQUIRED', 'Transaction requires gas sponsorship.', 409);
    if (Date.parse(op.quote.expiresAt) <= this.now()) {
      op.status = 'expired';
      op.error = 'QUOTE_EXPIRED';
      op.preSubmitExpired = true;
      await this.writeOperation(op);
      throw new WalletError(
        'QUOTE_EXPIRED',
        'The quote expired before submission. Prepare a new operation.',
        409
      );
    }
    let state = await this.load();
    await this.checkEvmDebitGate(state, op.chainId, op.id, options.skipGate);
    // Reload state after the debit gate in case gate refreshes advanced the nonce or rotated credentials.
    state = await this.load();
    await this.ensure(state, ['evm']);
    op.status = 'submitting';
    op.submitted = true;
    await this.writeOperation(op);
    const quote = op.quote;
    try {
      const result = statusSchema.parse(
        await this.activeCall(state, 'Execute', { txnId: quote.txnId })
      );
      op.status = result.status === 'quoted' ? 'unknown' : result.status;
      if (result.txnHash) op.txnHash = result.txnHash;
    } catch (error) {
      await settleExecuteError(op, error, () => this.evmTransactionStatus(state, quote.txnId));
    }
    await this.writeOperation(op);
    return op;
  }

  private async refreshEvm(op: StoredEvmOperation): Promise<StoredEvmOperation> {
    if (
      !['transfer', 'call', 'deployment', 'recovery'].includes(op.kind) ||
      !op.quote ||
      !['submitting', 'pending', 'unknown'].includes(op.status)
    )
      return op;
    const state = await this.load();
    const txnId = op.quote.txnId;
    await refreshStatus(op, () => this.evmTransactionStatus(state, txnId), this.now());
    await this.writeOperation(op);
    return op;
  }

  private validateResolveInput(input: ResolveReconciliationInput): {
    idempotencyKey: string;
    txnId: string;
  } {
    if (!input || typeof input !== 'object')
      throw new WalletError(
        'INVALID_INPUT',
        'Provide idempotencyKey, txnId, and resolution: "not-broadcast".'
      );
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    if (typeof input.txnId !== 'string' || !input.txnId.trim())
      throw new WalletError('INVALID_INPUT', 'Provide the operation quote txnId to resolve.');
    if (input.resolution !== 'not-broadcast')
      throw new WalletError('INVALID_INPUT', 'Only resolution: "not-broadcast" is supported.');
    return { idempotencyKey, txnId: input.txnId };
  }

  private async resolveEvmReconciliationInternal(
    id: string,
    txnId: string,
    options: { allowInternal: boolean }
  ): Promise<StoredEvmOperation> {
    const op = await this.readEvmOperation(id);
    if (!op || (!options.allowInternal && isInternalEvmOperation(op)))
      throw new WalletError('NOT_FOUND', 'Operation not found.', 404);
    if (op.status !== 'unknown' || op.error !== 'RECONCILIATION_REQUIRED' || !op.quote)
      throw new WalletError(
        'INVALID_STATE',
        'Only operations in unknown / RECONCILIATION_REQUIRED can be resolved.',
        409
      );
    if (op.quote.txnId !== txnId)
      throw new WalletError(
        'STALE_REVIEW',
        'Provided txnId does not match the stored operation quote.',
        409
      );
    if (op.txnHash)
      throw new WalletError(
        'INVALID_STATE',
        'Cannot resolve an operation with an observed transaction hash as not-broadcast.',
        409
      );
    const state = await this.load();
    try {
      const result = await this.evmTransactionStatus(state, op.quote.txnId);
      if (result.status !== 'quoted') {
        op.status = result.status;
        op.error = undefined;
        if (result.txnHash) op.txnHash = result.txnHash;
        await this.writeOperation(op);
        return op;
      }
      throw new WalletError(
        'RECONCILIATION_REQUIRED',
        'WaaS still reports this transaction as quoted; cannot resolve as expired yet.',
        409
      );
    } catch (error) {
      if (!(error instanceof UpstreamError) || error.upstreamCode !== TRANSACTION_EXPIRED)
        throw error;
      if (this.now() < Date.parse(op.quote.expiresAt) + CLAIM_GRACE_MS)
        throw new WalletError(
          'RECONCILIATION_REQUIRED',
          'Cannot resolve before the post-expiry grace window has elapsed.',
          409
        );
      op.status = 'expired';
      op.error = 'QUOTE_EXPIRED';
      op.operatorResolved = true;
      await this.writeOperation(op);
      return op;
    }
  }

  private async resolveChainReconciliationInternal(
    family: 'solana' | 'tron',
    id: string,
    txnId: string
  ): Promise<StoredChainOperation> {
    const op = await this.readChainOperation(id, family);
    if (!op) throw new WalletError('NOT_FOUND', 'Operation not found.', 404);
    if (op.status !== 'unknown' || op.error !== 'RECONCILIATION_REQUIRED' || !op.quote)
      throw new WalletError(
        'INVALID_STATE',
        'Only operations in unknown / RECONCILIATION_REQUIRED can be resolved.',
        409
      );
    if (op.quote.txnId !== txnId)
      throw new WalletError(
        'STALE_REVIEW',
        'Provided txnId does not match the stored operation quote.',
        409
      );
    if (op.txnHash)
      throw new WalletError(
        'INVALID_STATE',
        'Cannot resolve an operation with an observed transaction hash as not-broadcast.',
        409
      );
    const state = await this.load();
    try {
      const result = await this.chainTransactionStatus(state, op);
      if (result.status !== 'quoted') {
        op.status = result.status;
        op.error = undefined;
        if (result.txnHash) op.txnHash = result.txnHash;
        await this.writeOperation(op);
        return op;
      }
      throw new WalletError(
        'RECONCILIATION_REQUIRED',
        'WaaS still reports this transaction as quoted; cannot resolve as expired yet.',
        409
      );
    } catch (error) {
      if (!(error instanceof UpstreamError) || error.upstreamCode !== TRANSACTION_EXPIRED)
        throw error;
      if (this.now() < Date.parse(op.quote.expiresAt) + CLAIM_GRACE_MS)
        throw new WalletError(
          'RECONCILIATION_REQUIRED',
          'Cannot resolve before the post-expiry grace window has elapsed.',
          409
        );
      op.status = 'expired';
      op.error = 'QUOTE_EXPIRED';
      op.operatorResolved = true;
      await this.writeOperation(op);
      return op;
    }
  }

  private async evmTransactionStatus(state: State, txnId: string) {
    return statusSchema.parse(await this.activeCall(state, 'TransactionStatus', { txnId }));
  }

  private async signEvmTypedDataInternal(
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
    const { operation, hash } = await this.existingEvm(
      id,
      'signTypedData',
      { chainId, digest },
      'review',
      options.allowSwapsPrefix
    );
    if (operation) return operation;
    const state = await this.load();
    await this.ensure(state, ['evm']);
    if (
      options.rejectSelfVerifyingContract &&
      typedData.domain.verifyingContract.toLowerCase() === state.wallets.evm!.address.toLowerCase()
    )
      throw new WalletError(
        'INVALID_TYPED_DATA',
        'Typed data verifyingContract cannot be the wallet itself.'
      );
    const op: StoredEvmOperation = {
      id,
      kind: 'signTypedData',
      chainId,
      inputHash: hash,
      createdAt: new Date(this.now()).toISOString(),
      status: 'unknown',
      submissionMode: 'review',
      ...(options.allowSwapsPrefix ? { internal: true } : {})
    };
    await this.writeOperation(op);
    return this.recordEvmSignature(op, async () => {
      const { signature } = evmSignatureSchema.parse(
        await this.activeCall(state, 'SignTypedData', {
          network: String(chainId),
          walletId: state.wallets.evm!.id,
          typedData
        })
      );
      const { isValid } = validSchema.parse(
        await this.config.transport.request('IsValidTypedDataSignature', {
          network: String(chainId),
          walletAddress: state.wallets.evm!.address,
          typedData,
          signature
        })
      );
      return { signature, valid: isValid };
    });
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
      await this.writeOperation(op);
      throw error;
    }
    await this.writeOperation(op);
    return op;
  }

  // ── Internal Locked Solana / Tron Helpers ──────────────────────────────────────────────────

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
    const { operation, hash } = await this.existingAny(id, kind, input, family, submissionMode);
    if (operation) return operation as StoredChainOperation;
    const state = await this.load();
    await this.ensure(state, [family]);
    const wallet = state.wallets[family]!;
    const { method, params } = request(wallet);
    const op: StoredChainOperation = {
      id,
      family,
      kind,
      inputHash: hash,
      createdAt: new Date(this.now()).toISOString(),
      status: 'preparing',
      submissionMode,
      submitted: false,
      ...stored
    };
    await this.writeOperation(op);
    try {
      op.quote = chainQuoteSchema.parse(await this.activeCall(state, method, params, [family]));
      const fee = selectFee(op);
      if (fee) {
        op.fee = fee;
        op.feeIndex = op.quote.feeOptions.indexOf(fee);
      }
      op.reviewId = await this.computeReviewId({
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
      await this.writeOperation(op);
      return op;
    } catch (error) {
      op.status = 'failed';
      op.error = error instanceof WalletError ? error.code : 'PREPARATION_FAILED';
      await this.writeOperation(op);
      throw error;
    }
  }

  private async executeChainInternal(
    family: 'solana' | 'tron',
    id: string,
    kinds: readonly StoredChainOperation['kind'][],
    reviewId: string
  ): Promise<StoredChainOperation> {
    const op = await this.readChainOperation(id, family);
    if (!op || !kinds.includes(op.kind) || !op.quote)
      throw new WalletError('NOT_FOUND', 'Prepared transaction not found.', 404);
    if (!op.reviewId || op.reviewId !== reviewId)
      throw new WalletError(
        'STALE_REVIEW',
        'Review ID does not match this prepared operation. Review the current terms before executing.',
        409
      );
    if (op.status !== 'quoted') return this.refreshChain(op);
    if (!op.quote.sponsored && !op.fee)
      throw new WalletError('SPONSORSHIP_REQUIRED', 'This transaction is not sponsored.', 409);
    if (Date.parse(op.quote.expiresAt) <= this.now()) {
      op.status = 'expired';
      op.error = 'QUOTE_EXPIRED';
      op.preSubmitExpired = true;
      await this.writeOperation(op);
      throw new WalletError(
        'QUOTE_EXPIRED',
        'The quote expired before submission; nothing was sent. Prepare a new operation.',
        409
      );
    }
    const state = await this.load();
    await this.ensure(state, [family]);
    op.status = 'submitting';
    op.submitted = true;
    await this.writeOperation(op);
    try {
      const result = this.chainStatusSchema(family).parse(
        await this.activeCall(
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
    await this.writeOperation(op);
    return op;
  }

  private async refreshChain(op: StoredChainOperation): Promise<StoredChainOperation> {
    if (!op.quote || !['submitting', 'pending', 'unknown'].includes(op.status)) return op;
    const state = await this.load();
    await refreshStatus(op, () => this.chainTransactionStatus(state, op), this.now());
    await this.writeOperation(op);
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

  private async chainTransactionStatus(state: State, op: StoredChainOperation) {
    return this.chainStatusSchema(op.family).parse(
      await this.activeCall(state, 'TransactionStatus', { txnId: op.quote!.txnId }, [op.family])
    );
  }

  private async signChainLocked(
    id: string,
    family: 'solana' | 'tron',
    kind: 'sign' | 'signTypedData',
    input: Record<string, unknown>,
    sign: (wallet: RemoteWallet) => { method: string; params: Record<string, unknown> },
    check: (
      wallet: RemoteWallet,
      signature: string
    ) => { valid: boolean; method: string; params: Record<string, unknown> },
    stored: Partial<StoredChainOperation> = {}
  ): Promise<StoredChainOperation> {
    const { operation, hash } = await this.existingAny(id, kind, input, family, 'review');
    if (operation) return operation as StoredChainOperation;
    const state = await this.load();
    await this.ensure(state, [family]);
    const wallet = state.wallets[family]!;
    const op: StoredChainOperation = {
      id,
      family,
      kind,
      inputHash: hash,
      createdAt: new Date(this.now()).toISOString(),
      status: 'unknown',
      submissionMode: 'review',
      ...stored
    };
    await this.writeOperation(op);
    try {
      const request = sign(wallet);
      const { signature } = chainSignatureSchema.parse(
        await this.activeCall(state, request.method, request.params, [family])
      );
      const verification = check(wallet, signature);
      if (!verification.valid)
        throw new WalletError('INVALID_RESPONSE', 'WaaS returned a malformed signature.', 502);
      const { isValid } = validSchema.parse(
        await this.config.transport.request(verification.method, verification.params)
      );
      if (!isValid)
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
      await this.writeOperation(op);
      throw error;
    }
    await this.writeOperation(op);
    return op;
  }

  // ── State, Auth & Indexing ─────────────────────────────────────────────────────────────────

  private load(): Promise<State> {
    return readState(this.config.store);
  }

  private save(state: State) {
    return writeState(this.config.store, state);
  }

  private snapshot(state: State): WalletSnapshot {
    return {
      wallet: state.wallets.evm,
      wallets: { ...state.wallets },
      disabled: state.disabled,
      expiresAt: state.credential?.expiresAt,
      credentialId: state.credential?.credentialId,
      creationUncertain: state.creating.length > 0
    };
  }

  private async call(
    state: State,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    if (!state.credential) throw new WalletError('NO_CREDENTIAL', 'Credential unavailable.');
    state.credential.nonce = nextWalletNonce(BigInt(state.credential.nonce)).toString();
    await this.save(state);
    return this.config.transport.request(method, params, state.credential);
  }

  private async activeCall(
    state: State,
    method: string,
    params: Record<string, unknown>,
    families: readonly NetworkFamily[] = ['evm']
  ): Promise<unknown> {
    await this.ensure(state, families);
    try {
      return await this.call(state, method, params);
    } catch (error) {
      if (!(error instanceof UpstreamError) || !credentialRejectedCodes.has(error.upstreamCode))
        throw error;
      state.credential = undefined;
      await this.save(state);
      try {
        await this.ensure(state, families);
      } catch {
        // Preserve the original pre-claim credential rejection so settlement never treats an
        // unsent Execute as SUBMISSION_UNCERTAIN during an IdP outage.
        throw error;
      }
      return this.call(state, method, params);
    }
  }

  private held(state: State): NetworkFamily[] {
    const families = NETWORK_FAMILIES.filter((family) => state.wallets[family]);
    return families.length ? families : ['evm'];
  }

  private async ensure(state: State, families: readonly NetworkFamily[]): Promise<void> {
    if (state.disabled) throw new WalletError('WALLET_DISABLED', 'This wallet is disabled.', 409);
    let discovered = false;
    if (
      !state.credential?.expiresAt ||
      Date.parse(state.credential.expiresAt) <= this.now() + 60_000 ||
      state.creating.some((family) => !state.wallets[family])
    ) {
      state.credential = await generateCredential();
      await this.save(state);
      const { token, expiresAt } = await this.config.getIdToken();
      const handle = await sha256(token);
      const committed = z.object({ verifier: z.string() }).parse(
        await this.call(state, 'CommitVerifier', {
          identityType: 'oidc',
          authMode: 'id-token',
          handle,
          metadata: {
            iss: this.config.issuer,
            aud: this.config.audience,
            exp: String(expiresAt)
          }
        })
      );
      const authenticated = authSchema.parse(
        await this.call(state, 'CompleteAuth', {
          identityType: 'oidc',
          authMode: 'id-token',
          verifier: committed.verifier,
          answer: token,
          lifetime: this.config.sessionLifetimeSeconds ?? 21_600
        })
      );
      if (
        authenticated.identity.sub !== this.config.subject ||
        authenticated.identity.iss.replace(/\/$/, '') !== this.config.issuer.replace(/\/$/, '') ||
        authenticated.credential.credentialId.toLowerCase() !== state.credential.credentialId
      )
        throw new WalletError(
          'IDENTITY_MISMATCH',
          'WaaS returned a different identity or credential.',
          502
        );
      await this.discover(
        state,
        families,
        authenticated.wallets,
        authenticated.page?.cursor || undefined
      );
      discovered = true;
      state.credential.expiresAt = authenticated.credential.expiresAt;
      await this.save(state);
    }
    for (const family of families) {
      if (state.wallets[family]) continue;
      if (!discovered) {
        await this.discover(state, families, [], '');
        discovered = true;
        await this.save(state);
        if (state.wallets[family]) continue;
      }
      if (state.creating.includes(family))
        throw new WalletError(
          'CREATION_UNCERTAIN',
          'A previous create request has an unknown outcome. Restore again after upstream recovery; no duplicate wallet will be created.',
          409
        );
      state.creating.push(family);
      await this.save(state);
      try {
        const { wallet } = z.object({ wallet: walletSchema }).parse(
          await this.call(state, 'CreateWallet', {
            networkFamily: family,
            reference: this.config.subject
          })
        );
        if (walletFamily(wallet) !== family || !isWalletAddress(family, wallet.address))
          throw new WalletError(
            'INVALID_RESPONSE',
            'WaaS created a different kind of wallet.',
            502
          );
        state.wallets[family] = wallet;
        state.creating = state.creating.filter((entry) => entry !== family);
        await this.save(state);
      } catch (error) {
        state.credential!.expiresAt = undefined;
        await this.save(state);
        throw error;
      }
    }
  }

  private async discover(
    state: State,
    families: readonly NetworkFamily[],
    wallets: RemoteWallet[],
    from: string | undefined
  ): Promise<void> {
    const all = [...wallets];
    const seen = new Set<string>();
    let cursor = from;
    while (cursor !== undefined) {
      if (seen.has(cursor) || seen.size >= 100)
        throw new WalletError('INVALID_RESPONSE', 'Wallet pagination did not terminate.', 502);
      seen.add(cursor);
      const page = listSchema.parse(
        await this.call(state, 'ListWallets', {
          page: cursor ? { cursor, limit: 100 } : { limit: 100 }
        })
      );
      all.push(...page.wallets);
      cursor = page.page?.cursor || undefined;
    }
    for (const family of NETWORK_FAMILIES) {
      const stored = state.wallets[family];
      if (!stored && !families.includes(family) && !state.creating.includes(family)) continue;
      const found = all.filter((wallet) => walletFamily(wallet) === family);
      if (
        found.length > 1 ||
        (stored &&
          !found.some(
            (wallet) =>
              wallet.id === stored.id && sameAddress(family, wallet.address, stored.address)
          ))
      )
        throw new WalletError(
          'WALLET_MISMATCH',
          'Identity does not map to the expected single wallet.',
          409
        );
      if (found.length !== 1) continue;
      const bound = walletSchema.parse(
        z
          .object({ wallet: walletSchema })
          .parse(await this.call(state, 'UseWallet', { walletId: found[0].id })).wallet
      );
      if (
        bound.id !== found[0].id ||
        !sameAddress(family, bound.address, found[0].address) ||
        !isWalletAddress(family, bound.address)
      )
        throw new WalletError(
          'WALLET_MISMATCH',
          'Wallet binding returned a different wallet.',
          502
        );
      state.wallets[family] = bound;
      state.creating = state.creating.filter((entry) => entry !== family);
    }
  }

  private async revoke(state: State): Promise<void> {
    if (state.credential?.expiresAt && Date.parse(state.credential.expiresAt) > this.now()) {
      try {
        okSchema.parse(
          await this.call(state, 'RevokeCredential', {
            credentialId: state.credential.credentialId
          })
        );
      } catch (error) {
        if (!(error instanceof UpstreamError) || !credentialRejectedCodes.has(error.upstreamCode))
          throw error;
      }
    }
    state.credential = undefined;
    await this.save(state);
  }

  private async readOperation(id: string): Promise<StoredOperationRecord | null> {
    const value = await this.config.store.read(`operation:${id}`);
    return value === null ? null : parseStoredOperation(value);
  }

  private async readEvmOperation(id: string): Promise<StoredEvmOperation | null> {
    const op = await this.readOperation(id);
    return op && !('family' in op) ? op : null;
  }

  private async readChainOperation(
    id: string,
    family: 'solana' | 'tron'
  ): Promise<StoredChainOperation | null> {
    const op = await this.readOperation(id);
    return op && 'family' in op && op.family === family ? op : null;
  }

  private async writeOperation(op: StoredOperationRecord) {
    const ids = parseOperationIndex(await this.config.store.read('operationIndex'));
    const added = !ids.includes(op.id);
    if (added) await this.config.store.write('operationIndex', JSON.stringify([...ids, op.id]));
    const open = parseOpenOperationIndex(await this.config.store.read('openOperationIndex'));
    const isOpen = OPEN_STATUSES.has(op.status);
    const next = open && {
      synced: added && open.synced === ids.length ? ids.length + 1 : open.synced,
      ids: isOpen
        ? open.ids.includes(op.id)
          ? open.ids
          : [...open.ids, op.id]
        : open.ids.filter((entry) => entry !== op.id)
    };
    const changed =
      !!open && !!next && (next.synced !== open.synced || next.ids.length !== open.ids.length);
    if (changed && isOpen) await this.writeOpenIndex(next);
    await this.config.store.write(`operation:${op.id}`, JSON.stringify(op));
    if (changed && !isOpen) await this.writeOpenIndex(next);
  }

  private writeOpenIndex(index: { synced: number; ids: string[] }) {
    return this.config.store.write('openOperationIndex', JSON.stringify(index));
  }

  private async openOperationIds(): Promise<string[]> {
    const all = parseOperationIndex(await this.config.store.read('operationIndex'));
    const stored = parseOpenOperationIndex(await this.config.store.read('openOperationIndex'));
    const open =
      stored && stored.synced <= all.length ? stored : { synced: 0, ids: [] as string[] };
    if (open.synced === all.length && stored === open) return open.ids;
    const ids = [...open.ids];
    for (const id of all.slice(open.synced)) {
      const op = await this.readOperation(id);
      if ((!op || OPEN_STATUSES.has(op.status)) && !ids.includes(id)) ids.push(id);
    }
    await this.writeOpenIndex({ synced: all.length, ids });
    return ids;
  }

  private async existingEvm(
    id: string,
    kind: StoredEvmOperation['kind'],
    input: unknown,
    submissionMode: SubmissionMode = 'review',
    allowSwapsPrefix = false,
    acceptedKinds?: readonly StoredEvmOperation['kind'][]
  ): Promise<{ operation: StoredEvmOperation | null; hash: string }> {
    return this.existingAny(
      id,
      kind,
      input,
      'evm',
      submissionMode,
      allowSwapsPrefix,
      acceptedKinds
    ) as Promise<{ operation: StoredEvmOperation | null; hash: string }>;
  }

  private async existingAny(
    id: string,
    kind: string,
    input: unknown,
    family: NetworkFamily,
    submissionMode: SubmissionMode,
    allowSwapsPrefix = false,
    acceptedKinds?: readonly string[]
  ): Promise<{ operation: StoredOperationRecord | null; hash: string }> {
    validateIdempotencyKey(id, allowSwapsPrefix);
    const hash = await sha256(JSON.stringify(input));
    const stored = await this.readOperation(id);
    if (stored) {
      const storedFamily: NetworkFamily = 'family' in stored ? stored.family : 'evm';
      const kindMatches = acceptedKinds
        ? acceptedKinds.includes(stored.kind)
        : stored.kind === kind;
      if (stored.inputHash !== hash || !kindMatches || storedFamily !== family)
        throw new WalletError(
          'IDEMPOTENCY_CONFLICT',
          'This operation ID was already used with different input.',
          409
        );
      // Compare the persisted submission mode before resuming an interrupted prepare or reusing a quote.
      if (stored.submissionMode !== submissionMode) {
        if (submissionMode === 'immediate')
          throw new WalletError(
            'APPROVAL_REQUIRED',
            'This operation was prepared for manual review and cannot be executed via immediate send.',
            409
          );
        throw new WalletError(
          'IDEMPOTENCY_CONFLICT',
          'This operation ID was already created in immediate mode.',
          409
        );
      }
      if (stored.status === 'preparing') return { operation: null, hash };
      return { operation: stored, hash };
    }
    return { operation: null, hash };
  }
}
