import type {
  Abi,
  AbiStateMutability,
  ContractFunctionArgs,
  ContractFunctionName,
  Hex
} from 'viem';

import { encodeFunctionData, getAddress, isAddress, isHex, parseUnits } from 'viem';
import { z } from 'zod';

import type { RecoveryTransaction } from './authorization.js';
import type { ChainFamily, ChainOperation, WalletContext } from './chains.js';
import type { NetworkFamily, RemoteWallet, Quote } from './protocol.js';
import type { State } from './state.js';
import type { ExclusiveExecutor, StateStore } from './storage.js';
import type { RpcTransport } from './transport.js';

import { requireRecoveryPermit } from './authorization.js';
import { sha256 } from './encoding.js';
import { requireChain } from './environment.js';
import { UpstreamError, WalletError } from './errors.js';
import { nextWalletNonce } from './internal/protocol/requestSigning.js';
import { WaasErrorCode } from './internal/protocol/waasErrors.js';
import {
  authSchema,
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
import { SolanaWallet } from './solana.js';
import { readState, writeState } from './state.js';
import { validateTypedData } from './typed-data.js';

export interface WalletSnapshot {
  /** The EVM wallet. */
  wallet?: RemoteWallet;
  /** One wallet per network family that has been created or restored. */
  wallets: Partial<Record<NetworkFamily, RemoteWallet>>;
  disabled: boolean;
  expiresAt?: string;
  credentialId?: string;
  /** A create request for some family has an unknown outcome; restore again to settle it. */
  creationUncertain: boolean;
}
export interface Transfer {
  chainId: number;
  to: string;
  asset: 'native' | string;
  amount: string;
}
export interface Operation {
  id: string;
  kind: 'transfer' | 'userOperation' | 'sign' | 'signTypedData' | 'deployment' | 'recovery';
  inputHash: string;
  createdAt: string;
  status:
    | 'preparing'
    | 'quoted'
    | 'submitting'
    | 'pending'
    | 'executed'
    | 'failed'
    | 'unknown'
    | 'signed';
  chainId: number;
  transfer?: Transfer;
  transaction?: { to: string; data: string; value: string };
  quote?: Quote;
  signature?: string;
  verified?: boolean;
  txnHash?: string;
  error?: string;
}
/**
 * One contract call: either an ABI, the name of a function in it and its arguments, which the SDK
 * encodes, or pre-encoded `data`. `value` is the native amount in base units (decimal string),
 * default `'0'`. With a typed ABI such as viem's `erc20Abi`, the function name and arguments are
 * type-checked as they are by viem's `encodeFunctionData`.
 */
export type Call<
  abi extends Abi | readonly unknown[] = Abi,
  functionName extends ContractFunctionName<abi> = ContractFunctionName<abi>,
  args = ContractFunctionArgs<abi, AbiStateMutability, functionName>
> = { to: string; value?: string } & (
  | ({ abi: abi; functionName: functionName; data?: never } & (readonly [] extends args
      ? { args?: args }
      : { args: args }))
  | { data: Hex; abi?: never; functionName?: never; args?: never }
);
export interface UserOperation<
  abi extends Abi | readonly unknown[] = Abi,
  functionName extends ContractFunctionName<abi> = ContractFunctionName<abi>
> {
  chainId: number;
  /** WaaS executes one call per transaction, so exactly one call is accepted. */
  calls: readonly Call<abi, functionName>[];
}
export interface ServerWalletOptions {
  subject: string;
  issuer: string;
  audience: string;
  tokenProvider: () => Promise<{ token: string; expiresAt: number }>;
  store: StateStore;
  executor: ExclusiveExecutor;
  transport: RpcTransport;
  sessionLifetimeSeconds?: number;
}
const signatureSchema = z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]+$/) });
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

/** Authentication failures WaaS reports before running a method: a missing, expired or revoked key. */
const credentialRejectedCodes: ReadonlySet<number> = new Set([
  WaasErrorCode.KeyNotFound,
  WaasErrorCode.KeyExpired,
  WaasErrorCode.Unauthorized
]);

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

const abiCallFields = ['to', 'value', 'abi', 'functionName', 'args'];
const rawCallFields = ['to', 'value', 'data'];

function encodeCall(call: unknown): { to: string; value: string; data: Hex } {
  if (!call || typeof call !== 'object' || Array.isArray(call))
    throw new WalletError('INVALID_CALL', 'Provide the call to make.');
  const fields = Object.fromEntries(
    Object.entries(call).filter(([, item]) => item !== undefined)
  ) as Record<string, unknown>;
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
    // viem would otherwise pick the first function when the name is missing, and treat a hex
    // name as a selector without checking the ABI.
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
  // Lowercase so the same call hashes the same under one operation ID, however it was supplied.
  return { to: getAddress(fields.to), value, data: data.toLowerCase() as Hex };
}

/**
 * Validate and encode a user operation once, at the start of a call, so later changes to the
 * caller's object cannot change the chain or call between review, coordination and the quote.
 */
export function normalizeUserOperation(input: unknown): {
  chainId: number;
  transaction: { to: string; value: string; data: Hex };
} {
  if (!input || typeof input !== 'object')
    throw new WalletError('INVALID_CALL', 'Provide a chain and the call to make.');
  const { chainId, calls } = input as { chainId?: unknown; calls?: unknown };
  if (typeof chainId !== 'number' || !Number.isInteger(chainId))
    throw new WalletError('INVALID_CALL', 'Provide a chain and the call to make.');
  requireChain(chainId);
  if (!Array.isArray(calls) || calls.length !== 1)
    throw new WalletError('UNSUPPORTED_BATCH', 'Exactly one call is supported per user operation.');
  return { chainId, transaction: encodeCall(calls[0]) };
}

/** One instance represents one OIDC identity and one EVM wallet. */
export class ServerWallet {
  /** The identity's Solana wallet, sharing this instance's credential, store and executor. */
  readonly solana: SolanaWallet;
  constructor(private readonly options: ServerWalletOptions) {
    if (!options.subject || options.subject.length > 128)
      throw new WalletError(
        'INVALID_IDENTITY',
        'Wallet identifiers must contain 1–128 characters.'
      );
    this.solana = new SolanaWallet(this.context());
  }
  private context(): WalletContext {
    const chainOperation = (op: Operation | ChainOperation | null) =>
      op && 'family' in op ? op : null;
    return {
      run: (task) => this.options.executor.run(task),
      open: async (family: ChainFamily) => {
        const state = await this.load();
        await this.ensure(state, [family]);
        return { state, wallet: state.wallets[family]! };
      },
      load: () => this.load(),
      call: (state, family, method, params) => this.activeCall(state, method, params, [family]),
      verify: (method, params) => this.options.transport.request(method, params),
      existing: async (id, family, kind, input) => {
        const { operation, hash } = await this.existingAny(id, kind, input, family);
        return { operation: chainOperation(operation), hash };
      },
      read: async (id) => chainOperation(await this.readOperation(id)),
      write: (op) => this.writeOperation(op),
      list: async () => {
        const ids: string[] = JSON.parse((await this.options.store.read('operationIndex')) ?? '[]');
        const operations: ChainOperation[] = [];
        for (const id of ids) {
          const op = chainOperation(await this.readOperation(id));
          if (op) operations.push(op);
        }
        return operations;
      }
    };
  }
  private async load(): Promise<State> {
    const { state, migrated } = await readState(this.options.store);
    if (migrated) await this.save(state);
    return state;
  }
  private save(state: State) {
    return writeState(this.options.store, state);
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
  inspect(): Promise<WalletSnapshot> {
    return this.options.executor.run(async () => this.snapshot(await this.load()));
  }
  /** Creates or restores the wallet of each family requested: the EVM wallet by default. */
  async createOrRestore(
    options: { families?: readonly NetworkFamily[] } = {}
  ): Promise<WalletSnapshot> {
    const families = options.families ?? ['evm'];
    if (
      !Array.isArray(families) ||
      !families.length ||
      families.some((family) => !NETWORK_FAMILIES.includes(family))
    )
      throw new WalletError('INVALID_FAMILY', 'Request one or more of: evm, solana, tron.');
    return this.options.executor.run(async () => {
      const state = await this.load();
      await this.ensure(state, [...new Set(families)]);
      return this.snapshot(state);
    });
  }
  private async call(
    state: State,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    if (!state.credential) throw new WalletError('NO_CREDENTIAL', 'Credential unavailable.');
    state.credential.nonce = nextWalletNonce(BigInt(state.credential.nonce)).toString();
    await this.save(state);
    return this.options.transport.request(method, params, state.credential);
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
      // Verified authentication failures precede execution. Revoked keys return 7207.
      // Retry once with a new credential; a persistent authorization failure still propagates.
      if (!(error instanceof UpstreamError) || !credentialRejectedCodes.has(error.upstreamCode))
        throw error;
      state.credential = undefined;
      await this.save(state);
      await this.ensure(state, families);
      return this.call(state, method, params);
    }
  }
  /** The families to restore when no particular one is asked for. */
  private held(state: State): NetworkFamily[] {
    const families = NETWORK_FAMILIES.filter((family) => state.wallets[family]);
    return families.length ? families : ['evm'];
  }
  /**
   * Make sure the credential is current and each requested family has its one wallet, bound to
   * the credential. Never creates a second wallet for a family that already has one.
   */
  private async ensure(state: State, families: readonly NetworkFamily[]): Promise<void> {
    if (state.disabled) throw new WalletError('WALLET_DISABLED', 'This wallet is disabled.', 409);
    let discovered = false;
    if (
      !state.credential?.expiresAt ||
      Date.parse(state.credential.expiresAt) <= Date.now() + 60_000 ||
      state.creating.some((family) => !state.wallets[family])
    ) {
      state.credential = await generateCredential();
      await this.save(state);
      const { token, expiresAt } = await this.options.tokenProvider();
      const handle = await sha256(token);
      const committed = z.object({ verifier: z.string() }).parse(
        await this.call(state, 'CommitVerifier', {
          identityType: 'oidc',
          authMode: 'id-token',
          handle,
          metadata: {
            iss: this.options.issuer,
            aud: this.options.audience,
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
          lifetime: this.options.sessionLifetimeSeconds ?? 21_600
        })
      );
      if (
        authenticated.identity.sub !== this.options.subject ||
        authenticated.identity.iss.replace(/\/$/, '') !== this.options.issuer.replace(/\/$/, '') ||
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
      // A credential from an earlier call has not listed this family's wallets yet.
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
            reference: this.options.subject
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
        // Force discovery next time, even when the create response was lost.
        state.credential!.expiresAt = undefined;
        await this.save(state);
        throw error;
      }
    }
  }
  /**
   * Match the identity's wallets with the stored ones and bind each to the credential. Pass
   * `cursor: ''` to list from the start; `undefined` means `wallets` is already complete.
   */
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
    // Only families in use are checked, so an unrelated wallet never blocks this one.
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
  rotate(): Promise<WalletSnapshot> {
    return this.options.executor.run(async () => {
      const state = await this.load();
      if (state.disabled)
        throw new WalletError('WALLET_DISABLED', 'Enable the wallet before rotating.', 409);
      await this.revoke(state);
      await this.ensure(state, this.held(state));
      return this.snapshot(state);
    });
  }
  setDisabled(disabled: boolean): Promise<WalletSnapshot> {
    return this.options.executor.run(async () => {
      const state = await this.load();
      // Persist disabling before I/O. Keep it disabled until retained keys are revoked on enable.
      if (disabled) {
        state.disabled = true;
        await this.save(state);
      }
      await this.revoke(state);
      if (!disabled) {
        state.disabled = false;
        await this.save(state);
        await this.ensure(state, this.held(state));
      }
      return this.snapshot(state);
    });
  }
  private async revoke(state: State): Promise<void> {
    if (state.credential?.expiresAt && Date.parse(state.credential.expiresAt) > Date.now()) {
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
  /** EVM operations carry no `family`; Solana and Tron ones share the same store and index. */
  private async readOperation(id: string): Promise<Operation | ChainOperation | null> {
    const value = await this.options.store.read(`operation:${id}`);
    return value ? (JSON.parse(value) as Operation | ChainOperation) : null;
  }
  private async readEvmOperation(id: string): Promise<Operation | null> {
    const op = await this.readOperation(id);
    return op && !('family' in op) ? op : null;
  }
  private async writeOperation(op: Operation | ChainOperation) {
    const ids: string[] = JSON.parse((await this.options.store.read('operationIndex')) ?? '[]');
    if (!ids.includes(op.id))
      await this.options.store.write('operationIndex', JSON.stringify([...ids, op.id]));
    await this.options.store.write(`operation:${op.id}`, JSON.stringify(op));
  }
  /** Includes imported legacy IDs. Reads persisted status without authenticating or polling. */
  listOperations(legacyIds: readonly string[] = []): Promise<Operation[]> {
    return this.options.executor.run(async () => {
      const ids: string[] = JSON.parse((await this.options.store.read('operationIndex')) ?? '[]');
      const operations: Operation[] = [];
      for (const id of new Set([...ids, ...legacyIds])) {
        const op = await this.readEvmOperation(id);
        if (op) operations.push(op);
      }
      return operations;
    });
  }
  private async existing(
    id: string,
    kind: Operation['kind'],
    input: unknown
  ): Promise<{ operation: Operation | null; hash: string }> {
    // A matching family means a matching operation type.
    return this.existingAny(id, kind, input, 'evm') as Promise<{
      operation: Operation | null;
      hash: string;
    }>;
  }
  private async existingAny(
    id: string,
    kind: string,
    input: unknown,
    family: NetworkFamily
  ): Promise<{ operation: Operation | ChainOperation | null; hash: string }> {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(id))
      throw new WalletError(
        'INVALID_IDEMPOTENCY_KEY',
        'An operation ID of 8–100 letters, digits, underscores or hyphens is required.'
      );
    const hash = await sha256(JSON.stringify(input));
    const operation = await this.readOperation(id);
    if (
      operation &&
      (operation.inputHash !== hash ||
        operation.kind !== kind ||
        ('family' in operation ? operation.family : 'evm') !== family)
    )
      throw new WalletError(
        'IDEMPOTENCY_CONFLICT',
        'This operation ID was already used with different input.',
        409
      );
    return { operation, hash };
  }
  prepareTransfer(id: string, input: Transfer): Promise<Operation> {
    return this.options.executor.run(async () => {
      const parsed = transferSchema.safeParse(input);
      if (!parsed.success)
        throw new WalletError(
          'INVALID_TRANSFER',
          'Provide a chain, recipient, asset, and positive base-unit amount.'
        );
      const transfer = parsed.data;
      requireChain(transfer.chainId);
      if (!isAddress(transfer.to) || (transfer.asset !== 'native' && !isAddress(transfer.asset)))
        throw new WalletError(
          'INVALID_ADDRESS',
          'Provide valid EVM recipient and token addresses.'
        );
      transfer.to = getAddress(transfer.to);
      if (transfer.asset !== 'native') transfer.asset = getAddress(transfer.asset);
      if (BigInt(transfer.amount) >= 2n ** 256n)
        throw new WalletError('INVALID_AMOUNT', 'Amount exceeds uint256.');
      const { operation, hash } = await this.existing(id, 'transfer', transfer);
      if (operation) return operation;
      const state = await this.load();
      await this.ensure(state, ['evm']);
      const op: Operation = {
        id,
        kind: 'transfer',
        inputHash: hash,
        createdAt: new Date().toISOString(),
        chainId: transfer.chainId,
        status: 'preparing',
        transfer
      };
      await this.writeOperation(op);
      const native = transfer.asset === 'native';
      const data = native
        ? undefined
        : encodeFunctionData({
            abi: [
              {
                type: 'function',
                name: 'transfer',
                inputs: [{ type: 'address' }, { type: 'uint256' }],
                outputs: [{ type: 'bool' }],
                stateMutability: 'nonpayable'
              }
            ],
            functionName: 'transfer',
            args: [getAddress(transfer.to), BigInt(transfer.amount)]
          });
      try {
        op.quote = quoteSchema.parse(
          await this.activeCall(state, 'PrepareEthereumTransaction', {
            network: String(transfer.chainId),
            walletId: state.wallets.evm!.id,
            to: native ? transfer.to : transfer.asset,
            value: native ? transfer.amount : '0',
            ...(data ? { data } : {}),
            mode: 'relayer'
          })
        );
        if (!op.quote.sponsored)
          throw new WalletError(
            'SPONSORSHIP_REQUIRED',
            'This transfer is not sponsored. Enable gas sponsorship for this project/network.',
            409
          );
        op.status = 'quoted';
        await this.writeOperation(op);
        return op;
      } catch (error) {
        op.status = 'failed';
        op.error = error instanceof WalletError ? error.code : 'PREPARATION_FAILED';
        await this.writeOperation(op);
        throw error;
      }
    });
  }
  /**
   * Validate, encode and quote a sponsored contract call. Review the persisted `transaction`
   * before calling `executeUserOperation`, or use `sendUserOperation` to do both.
   */
  async prepareUserOperation<
    const abi extends Abi | readonly unknown[] = Abi,
    functionName extends ContractFunctionName<abi> = ContractFunctionName<abi>
  >(id: string, input: UserOperation<abi, functionName>): Promise<Operation> {
    const { chainId, transaction } = normalizeUserOperation(input);
    return this.options.executor.run(async () => {
      const { operation, hash } = await this.existing(id, 'userOperation', {
        chainId,
        ...transaction
      });
      if (operation) return operation;
      const state = await this.load();
      await this.ensure(state, ['evm']);
      // A self-call can reconfigure the wallet; deployment uses its own narrow path.
      if (transaction.to.toLowerCase() === state.wallets.evm!.address.toLowerCase())
        throw new WalletError('INVALID_CALL', 'Calls to the wallet itself are not allowed.');
      const op: Operation = {
        id,
        kind: 'userOperation',
        inputHash: hash,
        createdAt: new Date().toISOString(),
        chainId,
        status: 'preparing',
        transaction
      };
      await this.writeOperation(op);
      try {
        op.quote = quoteSchema.parse(
          await this.activeCall(state, 'PrepareEthereumTransaction', {
            network: String(chainId),
            walletId: state.wallets.evm!.id,
            ...transaction,
            mode: 'relayer'
          })
        );
        if (!op.quote.sponsored)
          throw new WalletError(
            'SPONSORSHIP_REQUIRED',
            'This call is not sponsored. Enable gas sponsorship for this project/network.',
            409
          );
        op.status = 'quoted';
        await this.writeOperation(op);
        return op;
      } catch (error) {
        op.status = 'failed';
        op.error = error instanceof WalletError ? error.code : 'PREPARATION_FAILED';
        await this.writeOperation(op);
        throw error;
      }
    });
  }
  executeUserOperation(id: string): Promise<Operation> {
    return this.executePrepared(id, ['userOperation']);
  }
  /**
   * Prepare and submit a sponsored contract call. Retrying with the same ID never submits it
   * again: it returns the persisted operation, polling its status while it is in flight.
   */
  async sendUserOperation<
    const abi extends Abi | readonly unknown[] = Abi,
    functionName extends ContractFunctionName<abi> = ContractFunctionName<abi>
  >(id: string, input: UserOperation<abi, functionName>): Promise<Operation> {
    const prepared = await this.prepareUserOperation(id, input);
    return this.executeUserOperation(prepared.id);
  }
  executeTransfer(id: string): Promise<Operation> {
    return this.executePrepared(id, ['transfer']);
  }
  /** Executes only a previously prepared, persisted and sponsored operation. */
  executeOperation(id: string): Promise<Operation> {
    return this.executePrepared(id, ['transfer', 'userOperation', 'deployment', 'recovery']);
  }
  private executePrepared(id: string, kinds: Operation['kind'][]): Promise<Operation> {
    return this.options.executor.run(async () => {
      const op = await this.readEvmOperation(id);
      if (!op || !kinds.includes(op.kind))
        throw new WalletError('NOT_FOUND', 'Prepared transaction not found.', 404);
      if (op.status !== 'quoted') return this.refresh(op);
      if (!op.quote?.sponsored)
        throw new WalletError('SPONSORSHIP_REQUIRED', 'Transfer requires gas sponsorship.', 409);
      if (Date.parse(op.quote.expiresAt) <= Date.now())
        throw new WalletError('QUOTE_EXPIRED', 'The quote expired. Prepare a new transfer.', 409);
      const state = await this.load();
      await this.ensure(state, ['evm']);
      op.status = 'submitting';
      await this.writeOperation(op);
      try {
        const result = statusSchema.parse(
          await this.activeCall(state, 'Execute', { txnId: op.quote.txnId })
        );
        op.status = result.status === 'quoted' ? 'unknown' : result.status;
        op.txnHash = result.txnHash;
      } catch {
        op.status = 'unknown';
        op.error = 'SUBMISSION_UNCERTAIN';
      }
      await this.writeOperation(op);
      return op;
    });
  }
  private async refresh(op: Operation): Promise<Operation> {
    if (
      !['transfer', 'userOperation', 'deployment', 'recovery'].includes(op.kind) ||
      !op.quote ||
      !['submitting', 'pending', 'unknown'].includes(op.status)
    )
      return op;
    const state = await this.load();
    const result = statusSchema.parse(
      await this.activeCall(state, 'TransactionStatus', { txnId: op.quote.txnId })
    );
    // An ambiguous Execute is never automatically retried, even when status still says quoted.
    op.status = result.status === 'quoted' ? 'unknown' : result.status;
    op.txnHash = result.txnHash;
    await this.writeOperation(op);
    return op;
  }
  /** EVM operations only; see `solana.getOperation` for Solana ones. */
  getOperation(id: string): Promise<Operation | null> {
    return this.options.executor.run(async () => {
      const op = await this.readEvmOperation(id);
      return op ? this.refresh(op) : null;
    });
  }
  /** Narrow self-call used only to deploy this wallet on a recovery chain. */
  prepareDeployment(id: string, chainId: number): Promise<Operation> {
    return this.prepareInternal(id, chainId, 'deployment');
  }
  prepareRecoveryTransaction(id: string, transaction: RecoveryTransaction): Promise<Operation> {
    requireRecoveryPermit(transaction);
    return this.prepareInternal(id, transaction.chainId, 'recovery', transaction);
  }
  private prepareInternal(
    id: string,
    chainId: number,
    kind: 'deployment' | 'recovery',
    transaction?: RecoveryTransaction
  ): Promise<Operation> {
    return this.options.executor.run(async () => {
      requireChain(chainId);
      const state = await this.load();
      await this.ensure(state, ['evm']);
      if (transaction && transaction.owner !== state.wallets.evm!.address.toLowerCase())
        throw new WalletError('INVALID_RECOVERY', 'Recovery belongs to a different wallet.');
      const call = transaction
        ? { to: transaction.to, data: transaction.data, value: transaction.value }
        : { to: state.wallets.evm!.address, data: '0x', value: '0' };
      const { operation, hash } = await this.existing(id, kind, { chainId, ...call });
      if (operation) return operation;
      const op: Operation = {
        id,
        kind,
        chainId,
        transaction: call,
        inputHash: hash,
        status: 'preparing',
        createdAt: new Date().toISOString()
      };
      await this.writeOperation(op);
      try {
        op.quote = quoteSchema.parse(
          await this.activeCall(state, 'PrepareEthereumTransaction', {
            network: String(chainId),
            walletId: state.wallets.evm!.id,
            ...call,
            mode: 'relayer'
          })
        );
        if (!op.quote.sponsored)
          throw new WalletError(
            'SPONSORSHIP_REQUIRED',
            'Recovery and deployment require gas sponsorship.',
            409
          );
        op.status = 'quoted';
        await this.writeOperation(op);
        return op;
      } catch (error) {
        op.status = 'failed';
        op.error = error instanceof WalletError ? error.code : 'PREPARATION_FAILED';
        await this.writeOperation(op);
        throw error;
      }
    });
  }
  signMessage(id: string, chainId: number, message: string): Promise<Operation> {
    return this.options.executor.run(async () => {
      requireChain(chainId);
      if (!message || new TextEncoder().encode(message).length > 16_384)
        throw new WalletError('INVALID_MESSAGE', 'Messages must contain 1–16,384 UTF-8 bytes.');
      const { operation, hash } = await this.existing(id, 'sign', { chainId, message });
      if (operation) return operation;
      const state = await this.load();
      await this.ensure(state, ['evm']);
      const op: Operation = {
        id,
        kind: 'sign',
        chainId,
        inputHash: hash,
        createdAt: new Date().toISOString(),
        status: 'unknown'
      };
      await this.writeOperation(op);
      const result = signatureSchema.parse(
        await this.activeCall(state, 'SignMessage', {
          network: String(chainId),
          walletId: state.wallets.evm!.id,
          message
        })
      );
      const validity = validSchema.parse(
        await this.options.transport.request('IsValidMessageSignature', {
          network: String(chainId),
          networkFamily: 'evm',
          walletAddress: state.wallets.evm!.address,
          message,
          signature: result.signature
        })
      );
      if (!validity.isValid)
        throw new WalletError(
          'SIGNATURE_INVALID',
          'WaaS returned a signature that did not verify.',
          502
        );
      op.signature = result.signature;
      op.verified = true;
      op.status = 'signed';
      await this.writeOperation(op);
      return op;
    });
  }
  /** Backend EIP-712 primitive. Callers must validate the authorization's semantics first. */
  async signTypedData(id: string, chainId: number, input: unknown): Promise<Operation> {
    // Snapshot synchronously so callers cannot mutate an authorization while it is queued.
    const { typedData, digest } = validateTypedData(input, chainId);
    return this.options.executor.run(async () => {
      const { operation, hash } = await this.existing(id, 'signTypedData', { chainId, digest });
      if (operation) return operation;
      const state = await this.load();
      await this.ensure(state, ['evm']);
      const op: Operation = {
        id,
        kind: 'signTypedData',
        chainId,
        inputHash: hash,
        createdAt: new Date().toISOString(),
        status: 'unknown'
      };
      await this.writeOperation(op);
      const { signature } = signatureSchema.parse(
        await this.activeCall(state, 'SignTypedData', {
          network: String(chainId),
          walletId: state.wallets.evm!.id,
          typedData
        })
      );
      const { isValid } = validSchema.parse(
        await this.options.transport.request('IsValidTypedDataSignature', {
          network: String(chainId),
          walletAddress: state.wallets.evm!.address,
          typedData,
          signature
        })
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
      await this.writeOperation(op);
      return op;
    });
  }
}
