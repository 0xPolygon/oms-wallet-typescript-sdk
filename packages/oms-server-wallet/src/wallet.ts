import type { Abi, ContractFunctionName } from 'viem';

import type { SwapsConfig } from './internal/swapsBridge.js';
import type { RpcTransport } from './transport.js';
import type {
  ApprovalMode,
  CreateOrRestoreOptions,
  EvmCallInput,
  EvmFacet,
  EvmFacetBase,
  EvmImmediateFacet,
  EvmOperation,
  EvmSignMessageInput,
  EvmSignTypedDataInput,
  EvmTransferInput,
  ExecuteInput,
  GetEvmBalancesOptions,
  GetSolanaBalancesOptions,
  GetTronBalancesOptions,
  ListOperationsOptions,
  ResolveReconciliationInput,
  ServerWalletBase,
  ServerWalletOptions,
  ServerWalletOptionsBase,
  ServerWalletService,
  ServerWalletServiceOptions,
  ServerWalletServiceOptionsBase,
  ServiceIndexerFacet,
  SolanaFacet,
  SolanaFacetBase,
  SolanaImmediateFacet,
  SolanaOperation,
  SolanaSignMessageInput,
  SolanaTransferInput,
  TronContractCallInput,
  TronFacet,
  TronFacetBase,
  TronImmediateFacet,
  TronOperation,
  TronSignMessageInput,
  TronSignTypedDataInput,
  TronTransactionInput,
  WaitForOperationOptions,
  WaitResult,
  WalletIndexerFacet,
  WalletOperation,
  WalletStoreOption
} from './types.js';

import { WalletEngine } from './engine.js';
import { environmentFromKey, resolveAttestationPolicy } from './environment.js';
import { WalletError } from './errors.js';
import { omsFetch } from './http.js';
import { IndexerClient } from './indexer.js';
import { resolveSwapsBinder } from './internal/swapsBridge.js';
import { isStaleExpiryRead } from './settlement.js';
import { computeIdentityNamespace, EncryptedStore, scopeNamespacedStore } from './storage.js';
import { WaasTransport } from './transport.js';

const SETTLED_STATUSES: ReadonlySet<string> = new Set(['executed', 'failed', 'expired', 'signed']);

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

function resolveWalletStore(store: WalletStoreOption, namespace: string) {
  if (!store || typeof store !== 'object')
    throw new WalletError(
      'CONFIGURATION',
      'Configure store as { adapter, encryptionKey } or { encryptedStore }.',
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

async function waitFor<TOperation extends WalletOperation>(
  id: string,
  getLocal: (id: string) => Promise<TOperation | null>,
  refresh: (id: string) => Promise<TOperation | null>,
  options: WaitForOperationOptions,
  now: () => number = () => Date.now()
): Promise<WaitResult<TOperation>> {
  if (
    !options ||
    typeof options !== 'object' ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 300_000
  )
    throw new WalletError(
      'INVALID_INPUT',
      'waitForOperation requires timeoutMs as an integer between 1 and 300,000.'
    );
  const pollMs = Math.max(250, Math.min(options.pollIntervalMs ?? 2_000, 30_000));
  const deadline = now() + options.timeoutMs;

  // Start with a local read so already-settled, reconciliation-required, or pre-aborted callers
  // never trigger unnecessary remote WaaS polling.
  let last = await getLocal(id);
  if (!last) throw new WalletError('NOT_FOUND', 'Operation not found.', 404);
  if (SETTLED_STATUSES.has(last.status)) return { outcome: 'settled', operation: last };
  if (
    last.status === 'unknown' &&
    (last.error === 'RECONCILIATION_REQUIRED' ||
      last.kind === 'sign' ||
      last.kind === 'signTypedData')
  )
    return { outcome: 'reconciliation-required', operation: last };
  if (options.signal?.aborted) return { outcome: 'cancelled', operation: last };

  for (;;) {
    if (options.signal?.aborted) return { outcome: 'cancelled', operation: last };
    if (now() >= deadline) return { outcome: 'timed-out', operation: last };
    let current: TOperation | null;
    try {
      current = await refresh(id);
    } catch (error) {
      // A stale TransactionExpired read inside the grace window: keep the last view and poll again.
      if (!isStaleExpiryRead(error)) throw error;
      current = last;
    }
    if (!current) throw new WalletError('NOT_FOUND', 'Operation not found.', 404);
    last = current;
    if (SETTLED_STATUSES.has(current.status)) return { outcome: 'settled', operation: current };
    if (current.status === 'unknown' && current.error === 'RECONCILIATION_REQUIRED')
      return { outcome: 'reconciliation-required', operation: current };
    if (options.signal?.aborted) return { outcome: 'cancelled', operation: current };
    const remaining = deadline - now();
    if (remaining <= 0) return { outcome: 'timed-out', operation: current };
    const waited = await sleepAbortable(Math.min(pollMs, remaining), options.signal);
    if (!waited) return { outcome: 'cancelled', operation: current };
  }
}

function buildWalletFacade<
  TApproval extends ApprovalMode,
  TSwaps extends SwapsConfig<'wallet' | 'service', unknown> | undefined
>(params: {
  engine: WalletEngine;
  indexer: IndexerClient;
  approval: TApproval;
  swapsFacet?: unknown;
  clock?: () => number;
}): ServerWalletBase<TApproval> &
  (TSwaps extends SwapsConfig<'wallet' | 'service', infer TFacet>
    ? { readonly swaps: TFacet }
    : Record<string, never>) {
  const { engine, indexer, approval, swapsFacet, clock } = params;
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
    signTypedData: (input: EvmSignTypedDataInput) =>
      engine.evm.signEvmTypedData(input?.idempotencyKey, input?.chainId, input?.typedData),
    getOperation: (id: string) => engine.evm.getEvmOperationLocal(id),
    refreshOperation: (id: string) => engine.evm.refreshEvmOperation(id),
    waitForOperation: (id: string, options: WaitForOperationOptions) =>
      waitFor<EvmOperation>(
        id,
        (opId) => engine.evm.getEvmOperationLocal(opId),
        (opId) => engine.evm.refreshEvmOperation(opId),
        options,
        clock
      ),
    resolveReconciliation: (input: ResolveReconciliationInput) =>
      engine.evm.resolveEvmReconciliation(input),
    listOperations: (options?: ListOperationsOptions) => engine.evm.listEvmOperations(options)
  };
  const evmImmediate: EvmImmediateFacet = {
    sendTransfer: (input: EvmTransferInput) => engine.evm.sendEvmTransfer(input),
    sendCall: <
      const abi extends Abi | readonly unknown[] = Abi,
      functionName extends ContractFunctionName<abi> = ContractFunctionName<abi>
    >(
      input: EvmCallInput<abi, functionName>
    ) => engine.evm.sendEvmCall(input)
  };
  const evm = Object.freeze(
    allowImmediate ? { ...evmBase, ...evmImmediate } : { ...evmBase }
  ) as EvmFacet<TApproval>;

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
        (opId) => engine.chain.refreshSolanaOperation(opId),
        options,
        clock
      ),
    resolveReconciliation: (input: ResolveReconciliationInput) =>
      engine.chain.resolveSolanaReconciliation(input),
    listOperations: (options?: ListOperationsOptions) => engine.chain.listSolanaOperations(options)
  };
  const solanaImmediate: SolanaImmediateFacet = {
    sendTransfer: (input: SolanaTransferInput) => engine.chain.sendSolanaTransfer(input)
  };
  const solana = Object.freeze(
    allowImmediate ? { ...solanaBase, ...solanaImmediate } : { ...solanaBase }
  ) as SolanaFacet<TApproval>;

  const tronBase: TronFacetBase = {
    prepareTransaction: (input: TronTransactionInput) => engine.chain.prepareTronTransaction(input),
    prepareContractCall: (input: TronContractCallInput) =>
      engine.chain.prepareTronContractCall(input),
    execute: (input: ExecuteInput) =>
      engine.chain.executeTron(input?.idempotencyKey, input?.reviewId),
    signMessage: (input: TronSignMessageInput) =>
      engine.chain.signTronMessage(input?.idempotencyKey, input?.message),
    signTypedData: (input: TronSignTypedDataInput) =>
      engine.chain.signTronTypedData(input?.idempotencyKey, input?.network, input?.typedData),
    getOperation: (id: string) => engine.chain.getTronOperationLocal(id),
    refreshOperation: (id: string) => engine.chain.refreshTronOperation(id),
    waitForOperation: (id: string, options: WaitForOperationOptions) =>
      waitFor<TronOperation>(
        id,
        (opId) => engine.chain.getTronOperationLocal(opId),
        (opId) => engine.chain.refreshTronOperation(opId),
        options,
        clock
      ),
    resolveReconciliation: (input: ResolveReconciliationInput) =>
      engine.chain.resolveTronReconciliation(input),
    listOperations: (options?: ListOperationsOptions) => engine.chain.listTronOperations(options)
  };
  const tronImmediate: TronImmediateFacet = {
    sendTransaction: (input: TronTransactionInput) => engine.chain.sendTronTransaction(input),
    sendContractCall: (input: TronContractCallInput) => engine.chain.sendTronContractCall(input)
  };
  const tron = Object.freeze(
    allowImmediate ? { ...tronBase, ...tronImmediate } : { ...tronBase }
  ) as TronFacet<TApproval>;

  const indexerFacet: WalletIndexerFacet = Object.freeze({
    async getEvmBalances(options?: GetEvmBalancesOptions) {
      const address = await engine.core.snapshotAddress('evm');
      if (!address)
        throw new WalletError(
          'WALLET_NOT_INITIALIZED',
          'EVM wallet has not been created or restored yet.',
          409
        );
      return indexer.getBalances(address, options);
    },
    async getSolanaBalances(options?: GetSolanaBalancesOptions) {
      const address = await engine.core.snapshotAddress('solana');
      if (!address)
        throw new WalletError(
          'WALLET_NOT_INITIALIZED',
          'Solana wallet has not been created or restored yet.',
          409
        );
      return indexer.getSolanaBalances(address, options?.networks);
    },
    async getTronBalances(options?: GetTronBalancesOptions) {
      const address = await engine.core.snapshotAddress('tron');
      if (!address)
        throw new WalletError(
          'WALLET_NOT_INITIALIZED',
          'Tron wallet has not been created or restored yet.',
          409
        );
      return indexer.getTronBalances(address, options?.networks);
    }
  });

  const base: ServerWalletBase<TApproval> = {
    inspect: () => engine.core.inspect(),
    createOrRestore: (options?: CreateOrRestoreOptions) =>
      engine.core.createOrRestore(options?.families),
    rotateCredential: () => engine.core.rotateCredential(),
    disable: () => engine.core.disable(),
    enable: () => engine.core.enable(),
    evm,
    solana,
    tron,
    indexer: indexerFacet
  };

  return Object.freeze(
    swapsFacet !== undefined ? { ...base, swaps: swapsFacet } : base
  ) as ServerWalletBase<TApproval> &
    (TSwaps extends SwapsConfig<'wallet' | 'service', infer TFacet>
      ? { readonly swaps: TFacet }
      : Record<string, never>);
}

function instantiateServerWallet(
  options: ServerWalletOptionsBase & {
    readonly approval?: ApprovalMode;
    readonly swaps?: SwapsConfig<'wallet', unknown>;
  },
  overrides: { transport?: RpcTransport; clock?: () => number; indexer?: IndexerClient } = {}
): ServerWalletBase<ApprovalMode> & { readonly swaps?: unknown } {
  if (!options || typeof options !== 'object')
    throw new WalletError('CONFIGURATION', 'Configure createServerWallet options.', 503);
  const environment = environmentFromKey(options.publishableKey);
  const origin = normalizeOrigin(options.origin);
  const approval = validateApproval(options.approval);
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
  const store = resolveWalletStore(options.store, namespace);
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
    clock: overrides.clock
  });

  let swapsFacet: unknown;
  if (swapsBinder) {
    const bound = swapsBinder.bind(engine.lockedPrimitives());
    engine.attachGate(bound.gate);
    swapsFacet = bound.facet;
  }

  return buildWalletFacade<ApprovalMode, SwapsConfig<'wallet', unknown> | undefined>({
    engine,
    indexer,
    approval,
    swapsFacet,
    clock: overrides.clock
  }) as unknown as ServerWalletBase<ApprovalMode> & { readonly swaps?: unknown };
}

/** Package-private test seam: runs the exact public factory wiring over a custom `RpcTransport` and clock. */
export function createServerWalletInternal(
  options: ServerWalletOptionsBase & {
    readonly approval?: 'two-phase';
    readonly swaps?: undefined;
  },
  overrides?: { transport?: RpcTransport; clock?: () => number; indexer?: IndexerClient }
): ServerWalletBase<'two-phase'>;
export function createServerWalletInternal<TFacet>(
  options: ServerWalletOptionsBase & {
    readonly approval?: 'two-phase';
    readonly swaps: SwapsConfig<'wallet', TFacet>;
  },
  overrides?: { transport?: RpcTransport; clock?: () => number; indexer?: IndexerClient }
): ServerWalletBase<'two-phase'> & { readonly swaps: TFacet };
export function createServerWalletInternal(
  options: ServerWalletOptionsBase & {
    readonly approval: 'allow-immediate';
    readonly swaps?: undefined;
  },
  overrides?: { transport?: RpcTransport; clock?: () => number; indexer?: IndexerClient }
): ServerWalletBase<'allow-immediate'>;
export function createServerWalletInternal<TFacet>(
  options: ServerWalletOptionsBase & {
    readonly approval: 'allow-immediate';
    readonly swaps: SwapsConfig<'wallet', TFacet>;
  },
  overrides?: { transport?: RpcTransport; clock?: () => number; indexer?: IndexerClient }
): ServerWalletBase<'allow-immediate'> & { readonly swaps: TFacet };
export function createServerWalletInternal<TApproval extends ApprovalMode = 'two-phase'>(
  options: ServerWalletOptionsBase & {
    readonly approval?: TApproval;
    readonly swaps?: undefined;
  },
  overrides?: { transport?: RpcTransport; clock?: () => number; indexer?: IndexerClient }
): ServerWalletBase<TApproval>;
export function createServerWalletInternal(
  options: ServerWalletOptionsBase & {
    readonly approval?: ApprovalMode;
    readonly swaps?: SwapsConfig<'wallet', unknown>;
  },
  overrides?: { transport?: RpcTransport; clock?: () => number; indexer?: IndexerClient }
): ServerWalletBase<ApprovalMode> & { readonly swaps?: unknown } {
  return instantiateServerWallet(options, overrides);
}

/**
 * Create a single-identity attested server wallet (ideal for one Cloudflare Durable Object per
 * wallet, or hosts managing per-identity storage and execution directly).
 */
export function createServerWallet(
  options: ServerWalletOptionsBase & {
    readonly approval?: 'two-phase';
    readonly swaps?: undefined;
  }
): ServerWalletBase<'two-phase'>;
export function createServerWallet<TFacet>(
  options: ServerWalletOptionsBase & {
    readonly approval?: 'two-phase';
    readonly swaps: SwapsConfig<'wallet', TFacet>;
  }
): ServerWalletBase<'two-phase'> & { readonly swaps: TFacet };
export function createServerWallet(
  options: ServerWalletOptionsBase & {
    readonly approval: 'allow-immediate';
    readonly swaps?: undefined;
  }
): ServerWalletBase<'allow-immediate'>;
export function createServerWallet<TFacet>(
  options: ServerWalletOptionsBase & {
    readonly approval: 'allow-immediate';
    readonly swaps: SwapsConfig<'wallet', TFacet>;
  }
): ServerWalletBase<'allow-immediate'> & { readonly swaps: TFacet };
export function createServerWallet(
  options: ServerWalletOptions<ApprovalMode, SwapsConfig<'wallet', unknown> | undefined>
): ServerWalletBase<ApprovalMode> & { readonly swaps?: unknown } {
  return instantiateServerWallet(
    options as ServerWalletOptionsBase & {
      readonly approval?: ApprovalMode;
      readonly swaps?: SwapsConfig<'wallet', unknown>;
    }
  );
}

function instantiateServerWalletService(
  options: ServerWalletServiceOptionsBase & {
    readonly approval?: ApprovalMode;
    readonly swaps?: SwapsConfig<'service', unknown>;
  },
  overrides: { transport?: RpcTransport; clock?: () => number; indexer?: IndexerClient } = {}
): ServerWalletService<ApprovalMode, SwapsConfig<'service', unknown> | undefined> {
  if (!options || typeof options !== 'object')
    throw new WalletError('CONFIGURATION', 'Configure createServerWalletService options.', 503);
  const environment = environmentFromKey(options.publishableKey);
  const origin = normalizeOrigin(options.origin);
  const approval = validateApproval(options.approval);
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
      if (!subject || subject.length > 128)
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
        clock: overrides.clock
      });
      let swapsFacet: unknown;
      if (swapsBinder) {
        const bound = swapsBinder.bind(engine.lockedPrimitives());
        engine.attachGate(bound.gate);
        swapsFacet = bound.facet;
      }
      return buildWalletFacade<ApprovalMode, SwapsConfig<'service', unknown> | undefined>({
        engine,
        indexer,
        approval,
        swapsFacet,
        clock: overrides.clock
      });
    },
    indexer: serviceIndexer
  }) as unknown as ServerWalletService<ApprovalMode, SwapsConfig<'service', unknown> | undefined>;
}

/** Package-private test seam for `createServerWalletService`. */
export function createServerWalletServiceInternal(
  options: ServerWalletServiceOptionsBase & {
    readonly approval?: 'two-phase';
    readonly swaps?: undefined;
  },
  overrides?: { transport?: RpcTransport; clock?: () => number; indexer?: IndexerClient }
): ServerWalletService<'two-phase', undefined>;
export function createServerWalletServiceInternal<TFacet>(
  options: ServerWalletServiceOptionsBase & {
    readonly approval?: 'two-phase';
    readonly swaps: SwapsConfig<'service', TFacet>;
  },
  overrides?: { transport?: RpcTransport; clock?: () => number; indexer?: IndexerClient }
): ServerWalletService<'two-phase', SwapsConfig<'service', TFacet>>;
export function createServerWalletServiceInternal(
  options: ServerWalletServiceOptionsBase & {
    readonly approval: 'allow-immediate';
    readonly swaps?: undefined;
  },
  overrides?: { transport?: RpcTransport; clock?: () => number; indexer?: IndexerClient }
): ServerWalletService<'allow-immediate', undefined>;
export function createServerWalletServiceInternal<TFacet>(
  options: ServerWalletServiceOptionsBase & {
    readonly approval: 'allow-immediate';
    readonly swaps: SwapsConfig<'service', TFacet>;
  },
  overrides?: { transport?: RpcTransport; clock?: () => number; indexer?: IndexerClient }
): ServerWalletService<'allow-immediate', SwapsConfig<'service', TFacet>>;
export function createServerWalletServiceInternal(
  options: ServerWalletServiceOptionsBase & {
    readonly approval?: ApprovalMode;
    readonly swaps?: SwapsConfig<'service', unknown>;
  },
  overrides?: { transport?: RpcTransport; clock?: () => number; indexer?: IndexerClient }
): ServerWalletService<ApprovalMode, SwapsConfig<'service', unknown> | undefined> {
  return instantiateServerWalletService(options, overrides);
}

/**
 * Create a multi-tenant server wallet service for backends operating many identities.
 * Computes canonical identity namespaces from the routed WaaS origin, project, issuer, audience,
 * and subject.
 */
export function createServerWalletService(
  options: ServerWalletServiceOptionsBase & {
    readonly approval?: 'two-phase';
    readonly swaps?: undefined;
  }
): ServerWalletService<'two-phase', undefined>;
export function createServerWalletService<TFacet>(
  options: ServerWalletServiceOptionsBase & {
    readonly approval?: 'two-phase';
    readonly swaps: SwapsConfig<'service', TFacet>;
  }
): ServerWalletService<'two-phase', SwapsConfig<'service', TFacet>>;
export function createServerWalletService(
  options: ServerWalletServiceOptionsBase & {
    readonly approval: 'allow-immediate';
    readonly swaps?: undefined;
  }
): ServerWalletService<'allow-immediate', undefined>;
export function createServerWalletService<TFacet>(
  options: ServerWalletServiceOptionsBase & {
    readonly approval: 'allow-immediate';
    readonly swaps: SwapsConfig<'service', TFacet>;
  }
): ServerWalletService<'allow-immediate', SwapsConfig<'service', TFacet>>;
export function createServerWalletService(
  options: ServerWalletServiceOptions<ApprovalMode, SwapsConfig<'service', unknown> | undefined>
): ServerWalletService<ApprovalMode, SwapsConfig<'service', unknown> | undefined> {
  return instantiateServerWalletService(
    options as ServerWalletServiceOptionsBase & {
      readonly approval?: ApprovalMode;
      readonly swaps?: SwapsConfig<'service', unknown>;
    }
  );
}
