import type { Abi, ContractFunctionName } from 'viem';

import type { PreparedHook } from './engine/inputs.js';
import type { SwapsConfig } from './internal/swapsBridge.js';
import type { NetworkFamily } from './protocol.js';
import type { RpcTransport } from './transport.js';
import type {
  ApprovalMode,
  CancelInput,
  CreateOrRestoreOptions,
  EphemeralServerWallet,
  EphemeralServerWalletOptions,
  EvmCallInput,
  EvmFacet,
  EvmFacetBase,
  EvmImmediateFacet,
  EvmOperation,
  EvmSignMessageInput,
  EvmSignTypedDataInput,
  EvmTransferInput,
  EvmTypedDataFacet,
  ExecuteInput,
  GetEvmBalancesOptions,
  GetSolanaBalancesOptions,
  GetTronBalancesOptions,
  ListOperationsOptions,
  ResolveReconciliationInput,
  ServerWallet,
  ServerWalletBase,
  ServerWalletOptions,
  ServerWalletService,
  ServerWalletServiceOptions,
  SendHooks,
  ServiceIndexerFacet,
  SigningOptions,
  SolanaFacet,
  SolanaFacetBase,
  SolanaImmediateFacet,
  SolanaOperation,
  SolanaSignMessageInput,
  SolanaTransferInput,
  TronCallInput,
  TronFacet,
  TronFacetBase,
  TronImmediateFacet,
  TronOperation,
  TronSignMessageInput,
  TronSignTypedDataInput,
  TronTransferInput,
  TransactionRef,
  TransactionStatusView,
  TransactionWaitResult,
  TronTypedDataFacet,
  TypedDataSigningRequest,
  WaitForOperationOptions,
  WaitResult,
  WalletIndexerFacet,
  WalletOperation,
  WalletStorageOption
} from './types.js';

import { WalletEngine } from './engine.js';
import { ClosableExecutor, EphemeralLifecycle } from './engine/ephemeral.js';
import { validateTxnId } from './engine/inputs.js';
import { environmentFromKey, resolveAttestationPolicy } from './environment.js';
import { UpstreamError, WalletError } from './errors.js';
import { omsFetch } from './http.js';
import { IndexerClient } from './indexer.js';
import { resolveSwapsBinder } from './internal/swapsBridge.js';
import { CLAIM_GRACE_MS, isStaleExpiryRead } from './settlement.js';
import {
  computeIdentityNamespace,
  EncryptedStore,
  MemoryStateStore,
  scopeNamespacedStore
} from './storage.js';
import { WaasTransport } from './transport.js';

type Overrides = {
  transport?: RpcTransport;
  clock?: () => number;
  indexer?: IndexerClient;
  creationRecheckDelaysMs?: readonly number[];
};

/** Makes any option key the factory does not know a compile-time error (no excess-key check on generics). */
type ExactOptions<TOptions, TKnown> = {
  readonly [K in Exclude<keyof TOptions, keyof TKnown>]: never;
};

type ApprovalFrom<TOptions> = TOptions extends { readonly approval: 'allow-immediate' }
  ? 'allow-immediate'
  : 'two-phase';
type TypedDataFrom<TOptions> = TOptions extends { readonly signing: SigningOptions } ? true : false;

/** The handle `createServerWallet` returns for these options. */
type ServerWalletFrom<TOptions extends ServerWalletOptions> = ServerWallet<
  ApprovalFrom<TOptions>,
  TOptions extends { readonly swaps: infer TSwaps extends SwapsConfig<'wallet', unknown> }
    ? TSwaps
    : undefined,
  TypedDataFrom<TOptions>
>;

/** The service `createServerWalletService` returns for these options. */
type ServerWalletServiceFrom<TOptions extends ServerWalletServiceOptions> = ServerWalletService<
  ApprovalFrom<TOptions>,
  TOptions extends { readonly swaps: infer TSwaps extends SwapsConfig<'service', unknown> }
    ? TSwaps
    : undefined,
  TypedDataFrom<TOptions>
>;

/** Validate `signing` and bind its policy to the options object it came from. */
function resolveSigning(
  signing: SigningOptions | undefined
): ((request: TypedDataSigningRequest) => boolean | Promise<boolean>) | undefined {
  if (signing === undefined) return undefined;
  if (!signing || typeof signing.authorizeTypedData !== 'function')
    throw new WalletError(
      'CONFIGURATION',
      'Configure signing as { authorizeTypedData(request) }, or omit it to disable typed-data signing.',
      503
    );
  return signing.authorizeTypedData.bind(signing);
}

type TerminalOutcome = 'executed' | 'failed' | 'expired' | 'signed' | 'cancelled';
const TERMINAL_OUTCOMES: ReadonlySet<string> = new Set<TerminalOutcome>([
  'executed',
  'failed',
  'expired',
  'signed',
  'cancelled'
]);
/** The operation's terminal status as a wait outcome, or undefined while it is still open. */
const terminalOutcome = (status: string): TerminalOutcome | undefined =>
  TERMINAL_OUTCOMES.has(status) ? (status as TerminalOutcome) : undefined;

function normalizeOrigin(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin)
      throw new Error('Invalid origin');
    return parsed.origin;
  } catch {
    throw new WalletError(
      'CONFIGURATION',
      'Configure origin as an exact http(s) origin without a path or trailing slash.',
      503
    );
  }
}

function validateOidcCore(issuer: unknown, audience: unknown, sessionLifetimeSeconds?: number) {
  if (typeof issuer !== 'string' || !issuer.trim())
    throw new WalletError('CONFIGURATION', 'Configure a valid OIDC issuer.', 503);
  if (typeof audience !== 'string' || !audience.trim())
    throw new WalletError('CONFIGURATION', 'Configure a valid OIDC audience.', 503);
  if (
    sessionLifetimeSeconds !== undefined &&
    (!Number.isInteger(sessionLifetimeSeconds) ||
      sessionLifetimeSeconds < 60 ||
      sessionLifetimeSeconds > 86_400)
  )
    throw new WalletError(
      'CONFIGURATION',
      'sessionLifetimeSeconds must be an integer between 60 and 86,400.',
      503
    );
}

function validateApproval(approval: unknown): ApprovalMode {
  if (approval === undefined) return 'two-phase';
  if (approval !== 'two-phase' && approval !== 'allow-immediate')
    throw new WalletError(
      'CONFIGURATION',
      'approval must be "two-phase" or "allow-immediate".',
      503
    );
  return approval;
}

function resolveWalletStore(store: WalletStorageOption, namespace: string) {
  if (!store || typeof store !== 'object')
    throw new WalletError(
      'CONFIGURATION',
      'Configure storage as { adapter, encryptionKey } or { encryptedStore }.',
      503
    );
  const hasAdapter = 'adapter' in store && store.adapter !== undefined;
  const hasEncrypted = 'encryptedStore' in store && store.encryptedStore !== undefined;
  if (hasAdapter === hasEncrypted)
    throw new WalletError(
      'CONFIGURATION',
      'Provide either { adapter, encryptionKey } or { encryptedStore }, not both.',
      503
    );
  if (hasEncrypted) {
    if (
      typeof store.encryptedStore.read !== 'function' ||
      typeof store.encryptedStore.write !== 'function'
    )
      throw new WalletError(
        'CONFIGURATION',
        'encryptedStore must implement read(key) and write(key, value).',
        503
      );
    return store.encryptedStore;
  }
  if (
    typeof store.adapter.read !== 'function' ||
    typeof store.adapter.write !== 'function' ||
    typeof store.encryptionKey !== 'string'
  )
    throw new WalletError(
      'CONFIGURATION',
      'store.adapter must implement read/write and include a 32-byte base64 encryptionKey.',
      503
    );
  return new EncryptedStore(store.adapter, store.encryptionKey, namespace);
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Split a `send*` input into what the engine validates and the caller's `onPrepared`. */
function withoutHook<TInput extends object>(
  input: TInput & { readonly onPrepared?: unknown }
): [TInput, PreparedHook | undefined] {
  if (!input || typeof input !== 'object') return [input, undefined];
  const { onPrepared, ...rest } = input;
  if (onPrepared !== undefined && typeof onPrepared !== 'function')
    throw new WalletError('INVALID_INPUT', 'onPrepared must be a function.');
  return [rest as TInput, onPrepared as PreparedHook | undefined];
}

function waitBounds(
  options: WaitForOperationOptions,
  now: () => number
): { pollMs: number; deadline: number } {
  if (
    !options ||
    typeof options !== 'object' ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 300_000
  )
    throw new WalletError(
      'INVALID_INPUT',
      'Waiting requires timeoutMs as an integer between 1 and 300,000.'
    );
  if (
    options.pollIntervalMs !== undefined &&
    (typeof options.pollIntervalMs !== 'number' || !Number.isFinite(options.pollIntervalMs))
  )
    throw new WalletError(
      'INVALID_INPUT',
      'pollIntervalMs must be a finite number of milliseconds.'
    );
  return {
    pollMs: Math.max(250, Math.min(options.pollIntervalMs ?? 2_000, 30_000)),
    deadline: now() + options.timeoutMs
  };
}

async function waitFor<TOperation extends WalletOperation>(
  id: string,
  getLocal: (id: string) => Promise<TOperation | null>,
  refresh: (id: string, skip: () => boolean) => Promise<TOperation | null>,
  options: WaitForOperationOptions,
  now: () => number = () => Date.now()
): Promise<WaitResult<TOperation>> {
  const { pollMs, deadline } = waitBounds(options, now);
  const signal = options.signal;
  // Set once the wait gives up, so work still queued behind the lock skips its remote refresh.
  let abandoned = false;
  const skip = () => abandoned;

  /**
   * Race one read against the deadline and the abort signal. Work that already started keeps
   * running under the lock and persists its result; its late rejection is observed here.
   */
  const bounded = <V>(
    work: Promise<V>
  ): Promise<
    | { readonly done: true; readonly value: V }
    | { readonly done: false; readonly why: 'timed-out' | 'aborted' }
  > =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (
        result: { done: true; value: V } | { done: false; why: 'timed-out' | 'aborted' }
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (!result.done) abandoned = true;
        resolve(result);
      };
      const onAbort = () => finish({ done: false, why: 'aborted' });
      const timer = setTimeout(
        () => finish({ done: false, why: 'timed-out' }),
        Math.max(0, deadline - now())
      );
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value) => finish({ done: true, value }),
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });

  const finished = (operation: TOperation): WaitResult<TOperation> | undefined => {
    const outcome = terminalOutcome(operation.status);
    if (outcome) return { outcome, operation } as WaitResult<TOperation>;
    if (
      operation.status === 'unknown' &&
      (operation.error === 'RECONCILIATION_REQUIRED' ||
        operation.kind === 'sign' ||
        operation.kind === 'signTypedData')
    )
      return { outcome: 'reconciliation-required', operation } as WaitResult<TOperation>;
    return undefined;
  };

  // Start with a local read so already-settled or reconciliation-required operations never
  // trigger remote WaaS polling.
  const first = await bounded(getLocal(id));
  if (!first.done) return { outcome: first.why };
  if (!first.value) throw new WalletError('NOT_FOUND', 'Operation not found.', 404);
  let last: TOperation = first.value;
  const settledFirst = finished(last);
  if (settledFirst) return settledFirst;

  for (;;) {
    if (signal?.aborted) return { outcome: 'aborted', operation: last };
    if (now() >= deadline) return { outcome: 'timed-out', operation: last };
    let read: Awaited<ReturnType<typeof bounded<TOperation | null>>>;
    try {
      read = await bounded(refresh(id, skip));
    } catch (error) {
      // A stale TransactionExpired read inside the grace window: keep the last view and poll again.
      if (!isStaleExpiryRead(error)) throw error;
      read = { done: true, value: last };
    }
    if (!read.done) return { outcome: read.why, operation: last };
    if (!read.value) throw new WalletError('NOT_FOUND', 'Operation not found.', 404);
    last = read.value;
    const settled = finished(last);
    if (settled) return settled;
    const remaining = deadline - now();
    if (remaining <= 0) return { outcome: 'timed-out', operation: last };
    const waited = await sleepAbortable(Math.min(pollMs, remaining), signal);
    if (!waited) return { outcome: 'aborted', operation: last };
  }
}

/**
 * Wait for a transaction by `txnId`: `executed` and `failed` end the wait; a transaction WaaS
 * still shows as unclaimed (or answers without information, or no longer knows) past the quote's
 * expiry plus the grace window ends it with `reconciliation-required`.
 */
async function waitForTxn(
  transaction: TransactionRef,
  read: (txnId: string) => Promise<TransactionStatusView>,
  options: WaitForOperationOptions,
  now: () => number = () => Date.now()
): Promise<TransactionWaitResult> {
  if (!transaction || typeof transaction !== 'object')
    throw new WalletError('INVALID_INPUT', 'Pass { txnId, expiresAt } from the operation quote.');
  const txnId = validateTxnId(transaction.txnId);
  const expiresAt = Date.parse(transaction.expiresAt);
  if (typeof transaction.expiresAt !== 'string' || !Number.isFinite(expiresAt))
    throw new WalletError('INVALID_INPUT', 'expiresAt must be the quote expiry as an ISO date.');
  const { pollMs, deadline } = waitBounds(options, now);
  const signal = options.signal;
  let last: TransactionStatusView | undefined;
  for (;;) {
    if (signal?.aborted) return { outcome: 'aborted', status: last };
    if (now() >= deadline) return { outcome: 'timed-out', status: last };
    let status: TransactionStatusView | undefined;
    try {
      status = await read(txnId);
    } catch (error) {
      // TransactionExpired / TransactionNotFound: WaaS no longer shows the transaction.
      if (!(error instanceof UpstreamError) || ![7308, 7309].includes(error.upstreamCode))
        throw error;
    }
    if (status) last = status;
    if (status?.status === 'executed' || status?.status === 'failed')
      return { outcome: status.status, status };
    if (status?.status !== 'pending' && now() >= expiresAt + CLAIM_GRACE_MS)
      return { outcome: 'reconciliation-required', status: last };
    const remaining = deadline - now();
    if (remaining <= 0) return { outcome: 'timed-out', status: last };
    if (!(await sleepAbortable(Math.min(pollMs, remaining), signal)))
      return { outcome: 'aborted', status: last };
  }
}

const familyLabel: Record<NetworkFamily, string> = { evm: 'EVM', solana: 'Solana', tron: 'Tron' };

/** Balance reads for a handle's own wallets; `addressOf` throws when a family is not held. */
function buildIndexerFacet(
  indexer: IndexerClient,
  addressOf: (family: NetworkFamily) => Promise<string>
): WalletIndexerFacet {
  return Object.freeze({
    async getEvmBalances(options?: GetEvmBalancesOptions) {
      return indexer.getBalances(await addressOf('evm'), options);
    },
    async getSolanaBalances(options?: GetSolanaBalancesOptions) {
      return indexer.getSolanaBalances(await addressOf('solana'), options?.networks);
    },
    async getTronBalances(options?: GetTronBalancesOptions) {
      return indexer.getTronBalances(await addressOf('tron'), options?.networks);
    }
  });
}

/** Every facade shape at runtime; the public factories narrow it from their options. */
type AnyServerWallet = ServerWalletBase<ApprovalMode, boolean> & { readonly swaps?: unknown };

function buildWalletFacade(params: {
  engine: WalletEngine;
  indexer: IndexerClient;
  approval: ApprovalMode;
  typedData: boolean;
  swapsFacet?: unknown;
  clock?: () => number;
}): AnyServerWallet {
  const { engine, indexer, approval, typedData, swapsFacet, clock } = params;
  const allowImmediate = approval === 'allow-immediate';

  const evmBase: EvmFacetBase = {
    prepareTransfer: (input: EvmTransferInput) => engine.evm.prepareEvmTransfer(input),
    prepareCall: <
      const abi extends Abi | readonly unknown[] = Abi,
      functionName extends ContractFunctionName<abi> = ContractFunctionName<abi>
    >(
      input: EvmCallInput<abi, functionName>
    ) => engine.evm.prepareEvmCall(input),
    execute: (input: ExecuteInput) => engine.evm.executeEvm(input?.idempotencyKey, input?.reviewId),
    signMessage: (input: EvmSignMessageInput) =>
      engine.evm.signEvmMessage(input?.idempotencyKey, input?.chainId, input?.message),
    getOperation: (id: string) => engine.evm.getEvmOperationLocal(id),
    refreshOperation: (id: string) => engine.evm.refreshEvmOperation(id),
    waitForOperation: (id: string, options: WaitForOperationOptions) =>
      waitFor<EvmOperation>(
        id,
        (opId) => engine.evm.getEvmOperationLocal(opId),
        (opId, skip) => engine.evm.refreshEvmOperation(opId, skip),
        options,
        clock
      ),
    resolveReconciliation: (input: ResolveReconciliationInput) =>
      engine.evm.resolveEvmReconciliation(input),
    listOperations: (options?: ListOperationsOptions) => engine.evm.listEvmOperations(options),
    getTransactionStatus: (txnId: string) => engine.evm.getTransactionStatus(txnId),
    waitForTransaction: (transaction: TransactionRef, options: WaitForOperationOptions) =>
      waitForTxn(transaction, (txnId) => engine.evm.getTransactionStatus(txnId), options, clock),
    cancel: (input: CancelInput) => engine.evm.cancelEvm(input?.idempotencyKey)
  };
  const evmImmediate: EvmImmediateFacet = {
    sendTransfer: async (input: EvmTransferInput & SendHooks<EvmOperation>) =>
      engine.evm.sendEvmTransfer(...withoutHook(input)),
    sendCall: async <
      const abi extends Abi | readonly unknown[] = Abi,
      functionName extends ContractFunctionName<abi> = ContractFunctionName<abi>
    >(
      input: EvmCallInput<abi, functionName> & SendHooks<EvmOperation>
    ) => engine.evm.sendEvmCall(...withoutHook(input))
  };
  const evmTypedData: EvmTypedDataFacet = {
    signTypedData: (input: EvmSignTypedDataInput) =>
      engine.evm.signEvmTypedData(input?.idempotencyKey, input?.chainId, input?.typedData)
  };
  const evm = Object.freeze({
    ...evmBase,
    ...(allowImmediate ? evmImmediate : {}),
    ...(typedData ? evmTypedData : {})
  }) as EvmFacet<ApprovalMode, boolean>;

  const solanaBase: SolanaFacetBase = {
    prepareTransfer: (input: SolanaTransferInput) => engine.chain.prepareSolanaTransfer(input),
    execute: (input: ExecuteInput) =>
      engine.chain.executeSolana(input?.idempotencyKey, input?.reviewId),
    signMessage: (input: SolanaSignMessageInput) =>
      engine.chain.signSolanaMessage(input?.idempotencyKey, input?.message),
    getOperation: (id: string) => engine.chain.getSolanaOperationLocal(id),
    refreshOperation: (id: string) => engine.chain.refreshSolanaOperation(id),
    waitForOperation: (id: string, options: WaitForOperationOptions) =>
      waitFor<SolanaOperation>(
        id,
        (opId) => engine.chain.getSolanaOperationLocal(opId),
        (opId, skip) => engine.chain.refreshSolanaOperation(opId, skip),
        options,
        clock
      ),
    resolveReconciliation: (input: ResolveReconciliationInput) =>
      engine.chain.resolveSolanaReconciliation(input),
    listOperations: (options?: ListOperationsOptions) => engine.chain.listSolanaOperations(options),
    getTransactionStatus: (txnId: string) => engine.chain.getSolanaTransactionStatus(txnId),
    waitForTransaction: (transaction: TransactionRef, options: WaitForOperationOptions) =>
      waitForTxn(
        transaction,
        (txnId) => engine.chain.getSolanaTransactionStatus(txnId),
        options,
        clock
      ),
    cancel: (input: CancelInput) => engine.chain.cancelSolana(input?.idempotencyKey)
  };
  const solanaImmediate: SolanaImmediateFacet = {
    sendTransfer: async (input: SolanaTransferInput & SendHooks<SolanaOperation>) =>
      engine.chain.sendSolanaTransfer(...withoutHook(input))
  };
  const solana = Object.freeze(
    allowImmediate ? { ...solanaBase, ...solanaImmediate } : { ...solanaBase }
  ) as SolanaFacet<ApprovalMode>;

  const tronBase: TronFacetBase = {
    prepareTransfer: (input: TronTransferInput) => engine.chain.prepareTronTransfer(input),
    prepareCall: (input: TronCallInput) => engine.chain.prepareTronCall(input),
    execute: (input: ExecuteInput) =>
      engine.chain.executeTron(input?.idempotencyKey, input?.reviewId),
    signMessage: (input: TronSignMessageInput) =>
      engine.chain.signTronMessage(input?.idempotencyKey, input?.message),
    getOperation: (id: string) => engine.chain.getTronOperationLocal(id),
    refreshOperation: (id: string) => engine.chain.refreshTronOperation(id),
    waitForOperation: (id: string, options: WaitForOperationOptions) =>
      waitFor<TronOperation>(
        id,
        (opId) => engine.chain.getTronOperationLocal(opId),
        (opId, skip) => engine.chain.refreshTronOperation(opId, skip),
        options,
        clock
      ),
    resolveReconciliation: (input: ResolveReconciliationInput) =>
      engine.chain.resolveTronReconciliation(input),
    listOperations: (options?: ListOperationsOptions) => engine.chain.listTronOperations(options),
    getTransactionStatus: (txnId: string) => engine.chain.getTronTransactionStatus(txnId),
    waitForTransaction: (transaction: TransactionRef, options: WaitForOperationOptions) =>
      waitForTxn(
        transaction,
        (txnId) => engine.chain.getTronTransactionStatus(txnId),
        options,
        clock
      ),
    cancel: (input: CancelInput) => engine.chain.cancelTron(input?.idempotencyKey)
  };
  const tronImmediate: TronImmediateFacet = {
    sendTransfer: async (input: TronTransferInput & SendHooks<TronOperation>) =>
      engine.chain.sendTronTransfer(...withoutHook(input)),
    sendCall: async (input: TronCallInput & SendHooks<TronOperation>) =>
      engine.chain.sendTronCall(...withoutHook(input))
  };
  const tronTypedData: TronTypedDataFacet = {
    signTypedData: (input: TronSignTypedDataInput) =>
      engine.chain.signTronTypedData(input?.idempotencyKey, input?.network, input?.typedData)
  };
  const tron = Object.freeze({
    ...tronBase,
    ...(allowImmediate ? tronImmediate : {}),
    ...(typedData ? tronTypedData : {})
  }) as TronFacet<ApprovalMode, boolean>;

  const indexerFacet = buildIndexerFacet(indexer, async (family) => {
    const address = await engine.core.snapshotAddress(family);
    if (!address)
      throw new WalletError(
        'WALLET_NOT_INITIALIZED',
        `${familyLabel[family]} wallet has not been created or restored yet.`,
        409
      );
    return address;
  });

  const base: ServerWalletBase<ApprovalMode, boolean> = {
    inspect: () => engine.core.inspect(),
    createOrRestore: (options?: CreateOrRestoreOptions) =>
      engine.core.createOrRestore(options?.families, options?.wallets),
    listWallets: () => engine.core.listWallets(),
    rotateCredential: () => engine.core.rotateCredential(),
    disable: () => engine.core.disable(),
    enable: () => engine.core.enable(),
    evm,
    solana,
    tron,
    indexer: indexerFacet
  };

  return Object.freeze(swapsFacet !== undefined ? { ...base, swaps: swapsFacet } : base);
}

function instantiateServerWallet(
  options: ServerWalletOptions,
  overrides: Overrides = {}
): AnyServerWallet {
  if (!options || typeof options !== 'object')
    throw new WalletError('CONFIGURATION', 'Configure createServerWallet options.', 503);
  const environment = environmentFromKey(options.publishableKey);
  const origin = normalizeOrigin(options.origin);
  const approval = validateApproval(options.approval);
  const authorizeTypedData = resolveSigning(options.signing);
  validateOidcCore(
    options.oidc?.issuer,
    options.oidc?.audience,
    options.oidc?.sessionLifetimeSeconds
  );
  if (typeof options.oidc?.getIdToken !== 'function')
    throw new WalletError('CONFIGURATION', 'Configure oidc.getIdToken.', 503);
  if (!options.executor || typeof options.executor.run !== 'function')
    throw new WalletError(
      'CONFIGURATION',
      'Configure an ExclusiveExecutor (use createSingleProcessExecutor() for a single process/DO).',
      503
    );

  // Resolve attestation policy eagerly so misconfiguration fails immediately at construction time.
  if (!overrides.transport) resolveAttestationPolicy(environment, options.attestation);

  const namespace = computeIdentityNamespace({
    waasOrigin: environment.origin,
    projectId: environment.projectId,
    issuer: options.oidc.issuer,
    audience: options.oidc.audience,
    subject: options.oidc.subject
  });
  const store = resolveWalletStore(options.storage, namespace);
  const baseFetch = options.fetch ?? fetch;
  const fetcher = origin ? omsFetch(origin, baseFetch) : baseFetch;
  const transport =
    overrides.transport ?? new WaasTransport(options.publishableKey, options.attestation, fetcher);
  const indexer = overrides.indexer ?? new IndexerClient(options.publishableKey, fetcher);

  const swapsBinder =
    options.swaps !== undefined ? resolveSwapsBinder(options.swaps, 'wallet') : undefined;

  const engine = new WalletEngine({
    namespace,
    origin,
    subject: options.oidc.subject,
    issuer: options.oidc.issuer,
    audience: options.oidc.audience,
    getIdToken: options.oidc.getIdToken,
    sessionLifetimeSeconds: options.oidc.sessionLifetimeSeconds,
    store,
    executor: options.executor,
    transport,
    clock: overrides.clock,
    creationRecheckDelaysMs: overrides.creationRecheckDelaysMs,
    authorizeTypedData
  });

  let swapsFacet: unknown;
  if (swapsBinder) {
    const bound = swapsBinder.bind(engine.lockedPrimitives());
    engine.attachGate(bound.gate);
    swapsFacet = bound.facet;
  }

  return buildWalletFacade({
    engine,
    indexer,
    approval,
    typedData: authorizeTypedData !== undefined,
    swapsFacet,
    clock: overrides.clock
  });
}

/** Package-private test seam: runs the exact public factory wiring over a custom `RpcTransport` and clock. */
/** Package-private test seam: runs the exact public factory wiring over a custom `RpcTransport` and clock. */
export function createServerWalletInternal<const TOptions extends ServerWalletOptions>(
  options: TOptions & ExactOptions<TOptions, ServerWalletOptions>,
  overrides?: Overrides
): ServerWalletFrom<TOptions> {
  return instantiateServerWallet(options, overrides) as unknown as ServerWalletFrom<TOptions>;
}

/**
 * Create a single-identity attested server wallet (ideal for one Cloudflare Durable Object per
 * wallet, or hosts managing per-identity storage and execution directly). The handle's methods
 * follow the options: `approval: 'allow-immediate'` adds `send*`, `swaps` adds `swaps`, and
 * `signing` adds `signTypedData`.
 */
export function createServerWallet<const TOptions extends ServerWalletOptions>(
  options: TOptions & ExactOptions<TOptions, ServerWalletOptions>
): ServerWalletFrom<TOptions> {
  return instantiateServerWallet(options) as unknown as ServerWalletFrom<TOptions>;
}

function instantiateServerWalletService(
  options: ServerWalletServiceOptions,
  overrides: Overrides = {}
): { forSubject(subject: string): AnyServerWallet; readonly indexer: ServiceIndexerFacet } {
  if (!options || typeof options !== 'object')
    throw new WalletError('CONFIGURATION', 'Configure createServerWalletService options.', 503);
  const environment = environmentFromKey(options.publishableKey);
  const origin = normalizeOrigin(options.origin);
  const approval = validateApproval(options.approval);
  const authorizeTypedData = resolveSigning(options.signing);
  validateOidcCore(
    options.oidc?.issuer,
    options.oidc?.audience,
    options.oidc?.sessionLifetimeSeconds
  );
  if (typeof options.oidc?.getIdToken !== 'function')
    throw new WalletError('CONFIGURATION', 'Configure oidc.getIdToken(subject).', 503);
  if (typeof options.executor !== 'function')
    throw new WalletError(
      'CONFIGURATION',
      'Configure an ExecutorProvider (use createSingleProcessExecutorPool() for a single process).',
      503
    );

  const storage = options.storage;
  if (!storage || typeof storage !== 'object')
    throw new WalletError(
      'CONFIGURATION',
      'Configure storage as { adapter, encryptionKey } or { encryptedStore }.',
      503
    );
  const hasAdapter = 'adapter' in storage && storage.adapter !== undefined;
  const hasEncrypted = 'encryptedStore' in storage && storage.encryptedStore !== undefined;
  if (hasAdapter === hasEncrypted)
    throw new WalletError(
      'CONFIGURATION',
      'Provide either { adapter, encryptionKey } or { encryptedStore }, not both.',
      503
    );
  if (hasEncrypted) {
    if (
      typeof storage.encryptedStore.read !== 'function' ||
      typeof storage.encryptedStore.write !== 'function'
    )
      throw new WalletError(
        'CONFIGURATION',
        'encryptedStore must implement read(namespace, key) and write(namespace, key, value).',
        503
      );
  } else {
    if (
      typeof storage.adapter.read !== 'function' ||
      typeof storage.adapter.write !== 'function' ||
      typeof storage.encryptionKey !== 'string'
    )
      throw new WalletError(
        'CONFIGURATION',
        'storage.adapter must implement read/write and include a 32-byte base64 encryptionKey.',
        503
      );
    // Validate the base64 encryption key eagerly at service construction.
    new EncryptedStore(
      { read: async () => null, write: async () => undefined },
      storage.encryptionKey,
      'validate'
    );
  }

  const baseFetch = options.fetch ?? fetch;
  const fetcher = origin ? omsFetch(origin, baseFetch) : baseFetch;
  const transport =
    overrides.transport ?? new WaasTransport(options.publishableKey, options.attestation, fetcher);
  const indexer = overrides.indexer ?? new IndexerClient(options.publishableKey, fetcher);
  const swapsBinder =
    options.swaps !== undefined ? resolveSwapsBinder(options.swaps, 'service') : undefined;

  const serviceIndexer: ServiceIndexerFacet = Object.freeze({
    getEvmBalances: (address: string, opts?: GetEvmBalancesOptions) =>
      indexer.getBalances(address, opts),
    getSolanaBalances: (address: string, opts?: GetSolanaBalancesOptions) =>
      indexer.getSolanaBalances(address, opts?.networks),
    getTronBalances: (address: string, opts?: GetTronBalancesOptions) =>
      indexer.getTronBalances(address, opts?.networks)
  });

  return Object.freeze({
    forSubject(subject: string) {
      if (typeof subject !== 'string' || !subject || subject.length > 128)
        throw new WalletError(
          'INVALID_IDENTITY',
          'Wallet identifiers must contain 1–128 characters.'
        );
      const namespace = computeIdentityNamespace({
        waasOrigin: environment.origin,
        projectId: environment.projectId,
        issuer: options.oidc.issuer,
        audience: options.oidc.audience,
        subject
      });
      const store = hasEncrypted
        ? scopeNamespacedStore(storage.encryptedStore, namespace)
        : new EncryptedStore(
            scopeNamespacedStore(storage.adapter, namespace),
            storage.encryptionKey,
            namespace
          );
      const executor = options.executor(namespace);
      if (!executor || typeof executor.run !== 'function')
        throw new WalletError(
          'CONFIGURATION',
          'ExecutorProvider must return an ExclusiveExecutor.',
          503
        );
      const engine = new WalletEngine({
        namespace,
        origin,
        subject,
        issuer: options.oidc.issuer,
        audience: options.oidc.audience,
        getIdToken: () => options.oidc.getIdToken(subject),
        sessionLifetimeSeconds: options.oidc.sessionLifetimeSeconds,
        store,
        executor,
        transport,
        clock: overrides.clock,
        creationRecheckDelaysMs: overrides.creationRecheckDelaysMs,
        authorizeTypedData
      });
      let swapsFacet: unknown;
      if (swapsBinder) {
        const bound = swapsBinder.bind(engine.lockedPrimitives());
        engine.attachGate(bound.gate);
        swapsFacet = bound.facet;
      }
      return buildWalletFacade({
        engine,
        indexer,
        approval,
        typedData: authorizeTypedData !== undefined,
        swapsFacet,
        clock: overrides.clock
      });
    },
    indexer: serviceIndexer
  });
}

/** Package-private test seam for `createServerWalletService`. */
export function createServerWalletServiceInternal<
  const TOptions extends ServerWalletServiceOptions
>(
  options: TOptions & ExactOptions<TOptions, ServerWalletServiceOptions>,
  overrides?: Overrides
): ServerWalletServiceFrom<TOptions> {
  return instantiateServerWalletService(
    options,
    overrides
  ) as unknown as ServerWalletServiceFrom<TOptions>;
}

/**
 * Create a multi-tenant server wallet service for backends operating many identities.
 * Computes canonical identity namespaces from the routed WaaS origin, project, issuer, audience,
 * and subject. Handles from `forSubject` follow the options like `createServerWallet`.
 */
export function createServerWalletService<const TOptions extends ServerWalletServiceOptions>(
  options: TOptions & ExactOptions<TOptions, ServerWalletServiceOptions>
): ServerWalletServiceFrom<TOptions> {
  return instantiateServerWalletService(options) as unknown as ServerWalletServiceFrom<TOptions>;
}

type AnyEphemeralWallet = EphemeralServerWallet<ApprovalMode, undefined, boolean> & {
  readonly swaps?: unknown;
};

function instantiateEphemeralServerWallet(
  options: EphemeralServerWalletOptions,
  overrides: Overrides = {}
): AnyEphemeralWallet {
  if (!options || typeof options !== 'object')
    throw new WalletError('CONFIGURATION', 'Configure createEphemeralServerWallet options.', 503);
  for (const key of ['store', 'storage', 'executor'])
    if ((options as unknown as Record<string, unknown>)[key] !== undefined)
      throw new WalletError(
        'CONFIGURATION',
        `createEphemeralServerWallet does not take "${key}": its credential and records live in memory and it queues its own calls. Use createServerWallet to keep them in storage.`,
        503
      );
  const environment = environmentFromKey(options.publishableKey);
  const origin = normalizeOrigin(options.origin);
  const approval = validateApproval(options.approval);
  const authorizeTypedData = resolveSigning(options.signing);
  validateOidcCore(
    options.oidc?.issuer,
    options.oidc?.audience,
    options.oidc?.sessionLifetimeSeconds
  );
  if (typeof options.oidc?.getIdToken !== 'function')
    throw new WalletError('CONFIGURATION', 'Configure oidc.getIdToken.', 503);
  if (!overrides.transport) resolveAttestationPolicy(environment, options.attestation);

  const namespace = computeIdentityNamespace({
    waasOrigin: environment.origin,
    projectId: environment.projectId,
    issuer: options.oidc.issuer,
    audience: options.oidc.audience,
    subject: options.oidc.subject
  });
  const baseFetch = options.fetch ?? fetch;
  const fetcher = origin ? omsFetch(origin, baseFetch) : baseFetch;
  const transport =
    overrides.transport ?? new WaasTransport(options.publishableKey, options.attestation, fetcher);
  const indexer = overrides.indexer ?? new IndexerClient(options.publishableKey, fetcher);
  const swapsBinder =
    options.swaps !== undefined ? resolveSwapsBinder(options.swaps, 'wallet') : undefined;

  const executor = new ClosableExecutor();
  const engine = new WalletEngine({
    namespace,
    origin,
    subject: options.oidc.subject,
    issuer: options.oidc.issuer,
    audience: options.oidc.audience,
    getIdToken: options.oidc.getIdToken,
    sessionLifetimeSeconds: options.oidc.sessionLifetimeSeconds ?? 3600,
    store: new MemoryStateStore(),
    executor,
    transport,
    clock: overrides.clock,
    creationRecheckDelaysMs: overrides.creationRecheckDelaysMs,
    createWallets: false,
    authorizeTypedData
  });
  let swapsFacet: unknown;
  if (swapsBinder) {
    const bound = swapsBinder.bind(engine.lockedPrimitives());
    engine.attachGate(bound.gate);
    swapsFacet = bound.facet;
  }
  const facade = buildWalletFacade({
    engine,
    indexer,
    approval,
    typedData: authorizeTypedData !== undefined,
    swapsFacet,
    clock: overrides.clock
  });
  const lifecycle = new EphemeralLifecycle(engine.core, executor);
  return Object.freeze({
    restore: (restoreOptions?: CreateOrRestoreOptions) =>
      lifecycle.restore(restoreOptions?.families, restoreOptions?.wallets),
    create: (createOptions?: CreateOrRestoreOptions) =>
      lifecycle.create(createOptions?.families, createOptions?.wallets),
    listWallets: () => lifecycle.listWallets(),
    inspect: () => lifecycle.inspect(),
    rotateCredential: () => lifecycle.rotateCredential(),
    close: () => lifecycle.close(),
    evm: facade.evm,
    solana: facade.solana,
    tron: facade.tron,
    indexer: facade.indexer,
    ...(swapsFacet !== undefined ? { swaps: swapsFacet } : {})
  });
}

/** The handle `createEphemeralServerWallet` returns for these options. */
type EphemeralServerWalletFrom<TOptions extends EphemeralServerWalletOptions> =
  EphemeralServerWallet<
    ApprovalFrom<TOptions>,
    TOptions extends { readonly swaps: infer TSwaps extends SwapsConfig<'wallet', unknown> }
      ? TSwaps
      : undefined,
    TypedDataFrom<TOptions>
  >;

/** Package-private test seam for `createEphemeralServerWallet`. */
export function createEphemeralServerWalletInternal<
  const TOptions extends EphemeralServerWalletOptions
>(
  options: TOptions & ExactOptions<TOptions, EphemeralServerWalletOptions>,
  overrides?: Overrides
): EphemeralServerWalletFrom<TOptions> {
  return instantiateEphemeralServerWallet(
    options,
    overrides
  ) as unknown as EphemeralServerWalletFrom<TOptions>;
}

/**
 * Create an in-memory wallet for one OIDC identity: the full wallet API of `createServerWallet`
 * without storage, an encryption key or a distributed lock. Each handle signs in with its own
 * credential and keeps it, its wallets and its operation records in memory, so handles in
 * different processes run in parallel; calls on one handle run one at a time. `create()` creates
 * an identity's wallets where they are first set up; `restore()` binds them everywhere else.
 * Records and `idempotencyKey` protection last as long as the handle. Call `close()` when done.
 */
export function createEphemeralServerWallet<const TOptions extends EphemeralServerWalletOptions>(
  options: TOptions & ExactOptions<TOptions, EphemeralServerWalletOptions>
): EphemeralServerWalletFrom<TOptions> {
  return instantiateEphemeralServerWallet(
    options
  ) as unknown as EphemeralServerWalletFrom<TOptions>;
}
