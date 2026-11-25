import type { Abi, ContractFunctionName } from 'viem';

import type { PreparedHook } from './engine/inputs.js';
import type { SwapsConfig } from './internal/swapsBridge.js';
import type { NetworkFamily } from './protocol.js';
import type { RpcTransport } from './transport.js';
import type {
  ApprovalMode,
  CancelInput,
  CreateOrRestoreOptions,
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
  InMemoryServerWallet,
  InMemoryServerWalletService,
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
import { IndexerClient } from './indexer.js';
import { WaasErrorCode } from './internal/protocol/waasErrors.js';
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

type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/** Makes any option key the factory does not know a compile-time error (no excess-key check on generics). */
type ExactOptions<TOptions, TKnown> = {
  readonly [K in Exclude<keyof TOptions, KeysOfUnion<TKnown>>]: never;
};

type ApprovalFrom<TOptions> = TOptions extends { readonly approval: 'allow-immediate' }
  ? 'allow-immediate'
  : 'two-phase';
type TypedDataFrom<TOptions> = TOptions extends { readonly signing: SigningOptions } ? true : false;

/** The handle `createServerWallet` returns for these options. */
type ServerWalletFrom<TOptions extends ServerWalletOptions> = TOptions extends {
  readonly storage: 'memory';
}
  ? InMemoryServerWallet<
      ApprovalFrom<TOptions>,
      TOptions extends { readonly swaps: infer TSwaps extends SwapsConfig<'wallet', unknown> }
        ? TSwaps
        : undefined,
      TypedDataFrom<TOptions>
    >
  : ServerWallet<
      ApprovalFrom<TOptions>,
      TOptions extends { readonly swaps: infer TSwaps extends SwapsConfig<'wallet', unknown> }
        ? TSwaps
        : undefined,
      TypedDataFrom<TOptions>
    >;

/** The service `createServerWalletService` returns for these options. */
type ServerWalletServiceFrom<TOptions extends ServerWalletServiceOptions> = TOptions extends {
  readonly storage: 'memory';
}
  ? InMemoryServerWalletService<
      ApprovalFrom<TOptions>,
      TOptions extends { readonly swaps: infer TSwaps extends SwapsConfig<'service', unknown> }
        ? TSwaps
        : undefined,
      TypedDataFrom<TOptions>
    >
  : ServerWalletService<
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

function resolveWalletStore(store: Exclude<WalletStorageOption, 'memory'>, namespace: string) {
  if (!store || typeof store !== 'object')
    throw new WalletError(
      'CONFIGURATION',
      'Configure storage as "memory", { adapter, encryptionKey }, or { encryptedStore }.',
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

/**
 * Race an async read against the wait deadline and abort signal. Work that already started keeps
 * running under the lock; its late rejection is observed here, and `onAbandon` lets still-queued
 * work skip remote I/O once it reaches the front of the lock.
 */
function createBoundedRunner(
  deadline: number,
  signal: AbortSignal | undefined,
  now: () => number,
  onAbandon: () => void
) {
  return <V>(
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
        if (!result.done) onAbandon();
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
  const bounded = createBoundedRunner(deadline, signal, now, () => {
    abandoned = true;
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
 * never showed as claimed (`pending` or a `txnHash`) past the quote's expiry plus the grace window
 * ends it with `reconciliation-required`. Once claimed, later stale or inconclusive reads keep
 * waiting instead of regressing. Both lock waits and in-flight reads are bounded by `timeoutMs`
 * and `signal`.
 */
async function waitForTxn(
  transaction: TransactionRef,
  read: (txnId: string, skip: () => boolean) => Promise<TransactionStatusView>,
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
  let abandoned = false;
  const skip = () => abandoned;
  const bounded = createBoundedRunner(deadline, signal, now, () => {
    abandoned = true;
  });
  let last: TransactionStatusView | undefined;
  let claimed = false;
  for (;;) {
    if (signal?.aborted) return { outcome: 'aborted', status: last };
    if (now() >= deadline) return { outcome: 'timed-out', status: last };
    let status: TransactionStatusView | undefined;
    try {
      const result = await bounded(read(txnId, skip));
      if (!result.done) return { outcome: result.why, status: last };
      status = result.value;
    } catch (error) {
      const expired =
        error instanceof UpstreamError && error.upstreamCode === WaasErrorCode.TransactionExpired;
      const notFoundAfterExpiry =
        error instanceof UpstreamError &&
        error.upstreamCode === WaasErrorCode.TransactionNotFound &&
        now() >= expiresAt;
      if (!expired && !notFoundAfterExpiry) throw error;
    }
    if (status) {
      last = status;
      if (status.status === 'pending' || status.txnHash) claimed = true;
    }
    if (status?.status === 'executed' || status?.status === 'failed')
      return { outcome: status.status, status };
    if (!claimed && now() >= expiresAt + CLAIM_GRACE_MS)
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
      waitForTxn(
        transaction,
        (txnId, skip) => engine.evm.getTransactionStatus(txnId, skip),
        options,
        clock
      ),
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
        (txnId, skip) => engine.chain.getSolanaTransactionStatus(txnId, skip),
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
        (txnId, skip) => engine.chain.getTronTransactionStatus(txnId, skip),
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

type AnyInMemoryWallet = InMemoryServerWallet<ApprovalMode, undefined, boolean> & {
  readonly swaps?: unknown;
};

/** One in-memory handle for one identity, shared by the single-identity factory and the service. */
function buildInMemoryHandle(params: {
  environment: ReturnType<typeof environmentFromKey>;
  approval: ApprovalMode;
  authorizeTypedData: ReturnType<typeof resolveSigning>;
  subject: string;
  oidc: {
    readonly issuer: string;
    readonly audience: string;
    readonly sessionLifetimeSeconds?: number;
  };
  getIdToken: () => Promise<{ readonly token: string; readonly expiresAt: number }>;
  swapsBinder: ReturnType<typeof resolveSwapsBinder> | undefined;
  transport: RpcTransport;
  indexer: IndexerClient;
  overrides: Overrides;
}): AnyInMemoryWallet {
  const { environment, approval, authorizeTypedData, swapsBinder, transport, indexer, overrides } =
    params;
  const namespace = computeIdentityNamespace({
    waasOrigin: environment.origin,
    projectId: environment.projectId,
    issuer: params.oidc.issuer,
    audience: params.oidc.audience,
    subject: params.subject
  });

  const executor = new ClosableExecutor();
  const engine = new WalletEngine({
    namespace,
    subject: params.subject,
    issuer: params.oidc.issuer,
    audience: params.oidc.audience,
    getIdToken: params.getIdToken,
    sessionLifetimeSeconds: params.oidc.sessionLifetimeSeconds ?? 3600,
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

function instantiateServerWallet(
  options: ServerWalletOptions,
  overrides: Overrides = {}
): AnyServerWallet | AnyInMemoryWallet {
  if (!options || typeof options !== 'object')
    throw new WalletError('CONFIGURATION', 'Configure createServerWallet options.', 503);
  const environment = environmentFromKey(options.publishableKey);
  const approval = validateApproval(options.approval);
  const authorizeTypedData = resolveSigning(options.signing);
  validateOidcCore(
    options.oidc?.issuer,
    options.oidc?.audience,
    options.oidc?.sessionLifetimeSeconds
  );
  if (typeof options.oidc?.getIdToken !== 'function')
    throw new WalletError('CONFIGURATION', 'Configure oidc.getIdToken.', 503);

  // Resolve attestation policy eagerly so misconfiguration fails immediately at construction time.
  if (!overrides.transport) resolveAttestationPolicy(environment, options.attestation);

  const fetcher = options.fetch ?? fetch;
  const transport =
    overrides.transport ?? new WaasTransport(options.publishableKey, options.attestation, fetcher);
  const indexer = overrides.indexer ?? new IndexerClient(options.publishableKey, fetcher);
  const swapsBinder =
    options.swaps !== undefined ? resolveSwapsBinder(options.swaps, 'wallet') : undefined;

  if (options.storage === 'memory') {
    for (const key of ['store', 'executor'])
      if ((options as unknown as Record<string, unknown>)[key] !== undefined)
        throw new WalletError(
          'CONFIGURATION',
          `storage: "memory" does not take "${key}": its credential and records live in memory and it queues its own calls. Pass durable storage to use an executor.`,
          503
        );
    return buildInMemoryHandle({
      environment,
      approval,
      authorizeTypedData,
      subject: options.oidc.subject,
      oidc: options.oidc,
      getIdToken: options.oidc.getIdToken,
      swapsBinder,
      transport,
      indexer,
      overrides
    });
  }

  if (!options.executor || typeof options.executor.run !== 'function')
    throw new WalletError(
      'CONFIGURATION',
      'Configure an ExclusiveExecutor (use createSingleProcessExecutor() for a single process/DO).',
      503
    );

  const namespace = computeIdentityNamespace({
    waasOrigin: environment.origin,
    projectId: environment.projectId,
    issuer: options.oidc.issuer,
    audience: options.oidc.audience,
    subject: options.oidc.subject
  });
  const store = resolveWalletStore(options.storage, namespace);

  const engine = new WalletEngine({
    namespace,
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
export function createServerWalletInternal<const TOptions extends ServerWalletOptions>(
  options: TOptions & ExactOptions<TOptions, ServerWalletOptions>,
  overrides?: Overrides
): ServerWalletFrom<TOptions> {
  return instantiateServerWallet(options, overrides) as unknown as ServerWalletFrom<TOptions>;
}

/**
 * Create a single-identity attested server wallet. Pass durable `storage` (`{ adapter, encryptionKey }`
 * or `{ encryptedStore }`) with an `executor` for persisted state and cross-restart idempotency, or
 * `storage: 'memory'` (no `executor`) for an in-memory handle (`restore`, `create`, `close`). The
 * handle's methods follow the options: `approval: 'allow-immediate'` adds `send*`, `swaps` adds
 * `swaps`, and `signing` adds `signTypedData`.
 */
export function createServerWallet<const TOptions extends ServerWalletOptions>(
  options: TOptions & ExactOptions<TOptions, ServerWalletOptions>
): ServerWalletFrom<TOptions> {
  return instantiateServerWallet(options) as unknown as ServerWalletFrom<TOptions>;
}

function instantiateServerWalletService(
  options: ServerWalletServiceOptions,
  overrides: Overrides = {}
):
  | { forSubject(subject: string): AnyServerWallet; readonly indexer: ServiceIndexerFacet }
  | {
      forSubject(subject: string): Omit<AnyInMemoryWallet, 'close'>;
      evict(subject: string): Promise<void>;
      close(): Promise<void>;
      readonly indexer: ServiceIndexerFacet;
    } {
  if (!options || typeof options !== 'object')
    throw new WalletError('CONFIGURATION', 'Configure createServerWalletService options.', 503);
  const environment = environmentFromKey(options.publishableKey);
  const approval = validateApproval(options.approval);
  const authorizeTypedData = resolveSigning(options.signing);
  validateOidcCore(
    options.oidc?.issuer,
    options.oidc?.audience,
    options.oidc?.sessionLifetimeSeconds
  );
  if (typeof options.oidc?.getIdToken !== 'function')
    throw new WalletError('CONFIGURATION', 'Configure oidc.getIdToken(subject).', 503);
  if (!overrides.transport) resolveAttestationPolicy(environment, options.attestation);

  const fetcher = options.fetch ?? fetch;
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

  if (options.storage === 'memory') {
    for (const key of ['store', 'executor'])
      if ((options as unknown as Record<string, unknown>)[key] !== undefined)
        throw new WalletError(
          'CONFIGURATION',
          `storage: "memory" does not take "${key}": handles keep their credentials and records in memory. Pass durable storage to use an executor.`,
          503
        );
    const maxHandles = options.cache?.maxHandles ?? 1000;
    const idleMs = options.cache?.idleTimeoutMs ?? 600_000;
    if (!Number.isInteger(maxHandles) || maxHandles < 1)
      throw new WalletError('CONFIGURATION', 'cache.maxHandles must be a positive integer.', 503);
    if (!Number.isInteger(idleMs) || idleMs < 1)
      throw new WalletError(
        'CONFIGURATION',
        'cache.idleTimeoutMs must be a positive integer.',
        503
      );
    const now = overrides.clock ?? (() => Date.now());
    // Most recently used last; an evicted handle is dropped, not revoked, so a request still using
    // it finishes, and its credential expires on its own.
    const cache = new Map<string, { handle: AnyInMemoryWallet; usedAt: number }>();
    let closed = false;

    const dropIdle = () => {
      for (const [subject, entry] of cache)
        if (now() - entry.usedAt > idleMs) cache.delete(subject);
    };

    return Object.freeze({
      forSubject(subject: string) {
        if (closed)
          throw new WalletError('WALLET_CLOSED', 'This in-memory wallet service is closed.', 409);
        if (typeof subject !== 'string' || !subject || subject.length > 128)
          throw new WalletError(
            'INVALID_IDENTITY',
            'Wallet identifiers must contain 1–128 characters.'
          );
        dropIdle();
        let entry = cache.get(subject);
        if (entry) cache.delete(subject);
        else
          entry = {
            handle: buildInMemoryHandle({
              environment,
              approval,
              authorizeTypedData,
              subject,
              oidc: options.oidc,
              getIdToken: () => options.oidc.getIdToken(subject),
              swapsBinder,
              transport,
              indexer,
              overrides
            }),
            usedAt: 0
          };
        entry.usedAt = now();
        cache.set(subject, entry);
        while (cache.size > maxHandles) cache.delete(cache.keys().next().value!);
        // The service owns each handle's lifetime: callers use evict(subject) or close().
        const { close: _close, ...handle } = entry.handle;
        void _close;
        return Object.freeze(handle);
      },
      async evict(subject: string) {
        const entry = cache.get(subject);
        cache.delete(subject);
        if (entry) await entry.handle.close();
      },
      async close() {
        closed = true;
        const entries = [...cache.values()];
        cache.clear();
        const failures: unknown[] = [];
        // A few at a time, continuing past failures so one slow revoke never strands the rest.
        for (let i = 0; i < entries.length; i += 8) {
          const results = await Promise.allSettled(
            entries.slice(i, i + 8).map((entry) => entry.handle.close())
          );
          for (const result of results)
            if (result.status === 'rejected') failures.push(result.reason);
        }
        if (failures.length) throw failures[0];
      },
      indexer: serviceIndexer
    });
  }

  if ((options as unknown as Record<string, unknown>).cache !== undefined)
    throw new WalletError(
      'CONFIGURATION',
      'cache is only supported when storage is "memory".',
      503
    );
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
      'Configure storage as "memory", { adapter, encryptionKey }, or { encryptedStore }.',
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
 * Pass durable `storage` (`{ adapter, encryptionKey }` or `{ encryptedStore }`) with an `executor`
 * provider, or `storage: 'memory'` (with optional `cache`, no `executor`) to keep one handle per
 * subject in a bounded cache with `evict(subject)` and `close()`. Handles from `forSubject` follow
 * the options like `createServerWallet`.
 */
export function createServerWalletService<const TOptions extends ServerWalletServiceOptions>(
  options: TOptions & ExactOptions<TOptions, ServerWalletServiceOptions>
): ServerWalletServiceFrom<TOptions> {
  return instantiateServerWalletService(options) as unknown as ServerWalletServiceFrom<TOptions>;
}
