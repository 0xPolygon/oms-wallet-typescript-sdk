import type {
  Abi,
  AbiStateMutability,
  ContractFunctionArgs,
  ContractFunctionName,
  Hex
} from 'viem';

import type { AttestationOptions } from './environment.js';
import type { WalletErrorCode } from './errors.js';
import type {
  ChainBalance,
  ChainBalances,
  EvmBalance,
  EvmBalances,
  SolanaNetwork,
  TronNetwork
} from './indexer.js';
import type { SwapsConfig } from './internal/swapsBridge.js';
import type { ChainQuote, FeeOption, NetworkFamily, Quote, RemoteWallet } from './protocol.js';
import type {
  ExclusiveExecutor,
  ExecutorProvider,
  NamespacedStateStore,
  StateStore
} from './storage.js';
import type { TypedDataInput } from './typed-data.js';

export type {
  AttestationOptions,
  ChainBalance,
  ChainBalances,
  ChainQuote,
  EvmBalance,
  EvmBalances,
  ExclusiveExecutor,
  ExecutorProvider,
  FeeOption,
  NamespacedStateStore,
  NetworkFamily,
  Quote,
  RemoteWallet,
  SolanaNetwork,
  StateStore,
  SwapsConfig,
  TronNetwork,
  TypedDataInput,
  WalletErrorCode
};

/**
 * Approval policy for transaction entrypoints:
 *
 * - `'two-phase'` (default): only `prepare*` and `execute` exist; `send*` shortcuts are omitted at
 *   both type and runtime level.
 * - `'allow-immediate'`: additionally exposes one-shot `send*` methods for pre-authorized flows.
 */
export type ApprovalMode = 'two-phase' | 'allow-immediate';

/** OIDC identity configuration for a single server wallet. */
export interface WalletOidcOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  readonly getIdToken: () => Promise<{ readonly token: string; readonly expiresAt: number }>;
  readonly sessionLifetimeSeconds?: number;
}

/** OIDC configuration for a multi-tenant server wallet service. */
export interface ServiceOidcOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly getIdToken: (
    subject: string
  ) => Promise<{ readonly token: string; readonly expiresAt: number }>;
  readonly sessionLifetimeSeconds?: number;
}

/**
 * Storage configuration for a single server wallet.
 * Choose either `{ adapter, encryptionKey }` (SDK-managed AES-256-GCM bound to this wallet's
 * namespace) or `{ encryptedStore }` (caller-managed authenticated encryption, isolation, and
 * durability).
 */
export type WalletStoreOption =
  | {
      readonly adapter: StateStore;
      readonly encryptionKey: string;
      readonly encryptedStore?: never;
    }
  | {
      readonly encryptedStore: StateStore;
      readonly adapter?: never;
      readonly encryptionKey?: never;
    };

/**
 * Storage configuration for a multi-tenant server wallet service.
 * Choose either `{ adapter, encryptionKey }` (SDK-managed AES-256-GCM bound per computed
 * namespace) or `{ encryptedStore }` (caller-managed authenticated encryption, isolation, and
 * durability).
 */
export type ServiceStorageOption =
  | {
      readonly adapter: NamespacedStateStore;
      readonly encryptionKey: string;
      readonly encryptedStore?: never;
    }
  | {
      readonly encryptedStore: NamespacedStateStore;
      readonly adapter?: never;
      readonly encryptionKey?: never;
    };

/** Base options shared by all `createServerWallet` configurations. */
export interface ServerWalletOptionsBase {
  readonly publishableKey: string;
  /** Application Origin allowed by your OMS project (sent as the HTTP `Origin` header). */
  readonly origin?: string;
  readonly oidc: WalletOidcOptions;
  readonly store: WalletStoreOption;
  /** Required exclusive ownership boundary for this wallet identity. */
  readonly executor: ExclusiveExecutor;
  readonly attestation?: AttestationOptions;
  /** Optional `fetch` override for instrumentation/testing; never bypasses Nitro attestation. */
  readonly fetch?: typeof fetch;
}

/** Options for `createServerWallet`. */
export type ServerWalletOptions<
  TApproval extends ApprovalMode = 'two-phase',
  TSwaps extends SwapsConfig<'wallet', unknown> | undefined = undefined
> = ServerWalletOptionsBase &
  (TApproval extends 'allow-immediate'
    ? { readonly approval: 'allow-immediate' }
    : { readonly approval?: 'two-phase' }) &
  (TSwaps extends SwapsConfig<'wallet', unknown>
    ? { readonly swaps: TSwaps }
    : { readonly swaps?: undefined });

/** Base options shared by all `createServerWalletService` configurations. */
export interface ServerWalletServiceOptionsBase {
  readonly publishableKey: string;
  /** Application Origin allowed by your OMS project (sent as the HTTP `Origin` header). */
  readonly origin?: string;
  readonly oidc: ServiceOidcOptions;
  readonly storage: ServiceStorageOption;
  /** Required per-namespace exclusive ownership provider. */
  readonly executor: ExecutorProvider;
  readonly attestation?: AttestationOptions;
  /** Optional `fetch` override for instrumentation/testing; never bypasses Nitro attestation. */
  readonly fetch?: typeof fetch;
}

/** Options for `createServerWalletService`. */
export type ServerWalletServiceOptions<
  TApproval extends ApprovalMode = 'two-phase',
  TSwaps extends SwapsConfig<'service', unknown> | undefined = undefined
> = ServerWalletServiceOptionsBase &
  (TApproval extends 'allow-immediate'
    ? { readonly approval: 'allow-immediate' }
    : { readonly approval?: 'two-phase' }) &
  (TSwaps extends SwapsConfig<'service', unknown>
    ? { readonly swaps: TSwaps }
    : { readonly swaps?: undefined });

/** Public snapshot of a wallet identity's persisted state. */
export interface WalletSnapshot {
  /** The EVM wallet, when created or restored. */
  readonly wallet?: RemoteWallet;
  /** One wallet per network family that has been created or restored. */
  readonly wallets: Readonly<Partial<Record<NetworkFamily, RemoteWallet>>>;
  readonly disabled: boolean;
  readonly expiresAt?: string;
  readonly credentialId?: string;
  /** True when a `CreateWallet` request for some family has an unknown outcome; restore again to settle it. */
  readonly creationUncertain: boolean;
}

export interface CreateOrRestoreOptions {
  /** Network families to create or restore (defaults to `['evm']`). */
  readonly families?: readonly NetworkFamily[];
}

export type OperationStatus =
  | 'preparing'
  | 'quoted'
  | 'submitting'
  | 'pending'
  | 'executed'
  | 'failed'
  | 'unknown'
  | 'signed'
  | 'expired';

export type SubmissionMode = 'review' | 'immediate';

/** Normalized EVM native or ERC-20 transfer details. */
export interface EvmTransfer {
  readonly chainId: number;
  readonly to: string;
  readonly asset: 'native' | string;
  readonly amount: string;
}

/** Input to `wallet.evm.prepareTransfer` and `wallet.evm.sendTransfer`. */
export interface EvmTransferInput {
  /** Durable idempotency key (8–100 chars: letters, digits, `_`, `-`; must not start with `swp_`). */
  readonly idempotencyKey: string;
  readonly chainId: number;
  readonly to: string;
  readonly asset: 'native' | string;
  /** Positive base-unit decimal string (use `parseAmount`). */
  readonly amount: string;
}

/**
 * Single EVM contract call input: either a typed ABI + function name + arguments (encoded with
 * viem) or pre-encoded hex `data`.
 */
export type EvmCallInput<
  abi extends Abi | readonly unknown[] = Abi,
  functionName extends ContractFunctionName<abi> = ContractFunctionName<abi>,
  args = ContractFunctionArgs<abi, AbiStateMutability, functionName>
> = {
  /** Durable idempotency key (8–100 chars: letters, digits, `_`, `-`; must not start with `swp_`). */
  readonly idempotencyKey: string;
  readonly chainId: number;
  readonly to: string;
  /** Optional native value in base units (decimal string, default `'0'`). */
  readonly value?: string;
} & (
  | ({
      readonly abi: abi;
      readonly functionName: functionName;
      readonly data?: never;
    } & (readonly [] extends args ? { readonly args?: args } : { readonly args: args }))
  | {
      readonly data: Hex;
      readonly abi?: never;
      readonly functionName?: never;
      readonly args?: never;
    }
);

/** Input to `wallet.evm.signMessage`. */
export interface EvmSignMessageInput {
  readonly idempotencyKey: string;
  readonly chainId: number;
  readonly message: string;
}

/** Input to `wallet.evm.signTypedData`. */
export interface EvmSignTypedDataInput {
  readonly idempotencyKey: string;
  readonly chainId: number;
  readonly typedData: TypedDataInput;
}

/** Input to `execute` on any wallet family. */
export interface ExecuteInput {
  readonly idempotencyKey: string;
  /** Opaque SDK-issued review revision from the prepared operation (`operation.reviewId`). */
  readonly reviewId: string;
}

/**
 * Input to `resolveReconciliation` on any wallet family after an operator has independently
 * verified that an operation in `unknown` / `RECONCILIATION_REQUIRED` was never broadcast.
 */
export interface ResolveReconciliationInput {
  readonly idempotencyKey: string;
  /** Must match the stored operation's WaaS `quote.txnId`. */
  readonly txnId: string;
  readonly resolution: 'not-broadcast';
}

/** Input to `wallet.solana.prepareTransfer` and `wallet.solana.sendTransfer`. */
export interface SolanaTransferInput {
  readonly idempotencyKey: string;
  readonly network: SolanaNetwork;
  readonly to: string;
  /** `'native'` for SOL or an SPL / Token-2022 mint address. */
  readonly asset: 'native' | string;
  /** Positive base-unit decimal string (u64). */
  readonly amount: string;
}

/** Normalized Solana transfer stored on a `SolanaOperation`. */
export interface SolanaTransfer {
  readonly network: SolanaNetwork;
  readonly to: string;
  readonly asset: 'native' | string;
  readonly amount: string;
}

/** Input to `wallet.solana.signMessage`. */
export interface SolanaSignMessageInput {
  readonly idempotencyKey: string;
  readonly message: string;
}

/** Input to `wallet.tron.prepareTransaction` and `wallet.tron.sendTransaction`. */
export interface TronTransactionInput {
  readonly idempotencyKey: string;
  readonly network: TronNetwork;
  /** Base58Check recipient or contract (`T…`). */
  readonly to: string;
  /** Sun as a decimal string (default `'0'`; required positive for TRX transfer). */
  readonly value?: string;
  /** Pre-encoded calldata; omitting sends TRX, providing `data` (even `'0x'`) makes a contract call. */
  readonly data?: `0x${string}`;
  /** Maximum TRX fee in sun when delegated resources do not cover the transaction. Omit to require sponsorship. */
  readonly maxFee?: string;
}

/** Typed ABI argument for `wallet.tron.prepareContractCall` / `sendContractCall`. */
export interface TronAbiArg {
  readonly type: string;
  readonly value: unknown;
}

/** Input to `wallet.tron.prepareContractCall` and `wallet.tron.sendContractCall`. */
export interface TronContractCallInput {
  readonly idempotencyKey: string;
  readonly network: TronNetwork;
  /** Base58Check contract address (`T…`). */
  readonly contract: string;
  /** Function name alone (such as `'transfer'`). */
  readonly method: string;
  readonly args?: readonly TronAbiArg[];
  /** Maximum TRX fee in sun when delegated resources do not cover the call. Omit to require sponsorship. */
  readonly maxFee?: string;
}

/** Input to `wallet.tron.signMessage`. */
export interface TronSignMessageInput {
  readonly idempotencyKey: string;
  readonly message: string;
}

/** Input to `wallet.tron.signTypedData`. */
export interface TronSignTypedDataInput {
  readonly idempotencyKey: string;
  readonly network: TronNetwork;
  readonly typedData: TypedDataInput;
}

/** Shared public fields on every persisted operation across EVM, Solana, and Tron. */
export interface OperationBase {
  readonly id: string;
  readonly inputHash: string;
  readonly createdAt: string;
  readonly status: OperationStatus;
  readonly submissionMode: SubmissionMode;
  /** Opaque revision binding the reviewed quote and normalized terms; required by `execute`. */
  readonly reviewId?: string;
  /** True only when the SDK has durable proof that no broadcast/claim occurred. */
  readonly provenUnsent: boolean;
  /**
   * Set when an operator resolved an unconfirmed submission as not broadcast through
   * `resolveReconciliation`. An operator assertion, not SDK proof, so `provenUnsent` stays false.
   */
  readonly operatorResolved?: true;
  readonly signature?: string;
  readonly verified?: true;
  readonly txnHash?: string;
  readonly error?: WalletErrorCode | string;
}

/** Persisted EVM operation view. */
export interface EvmOperation extends OperationBase {
  readonly family: 'evm';
  readonly kind: 'transfer' | 'call' | 'sign' | 'signTypedData';
  readonly chainId: number;
  readonly transfer?: EvmTransfer;
  readonly transaction?: { readonly to: string; readonly data: string; readonly value: string };
  readonly quote?: Quote;
}

/** Persisted Solana operation view. */
export interface SolanaOperation extends OperationBase {
  readonly family: 'solana';
  readonly kind: 'transfer' | 'sign';
  readonly network?: SolanaNetwork;
  readonly transfer?: SolanaTransfer;
  readonly quote?: ChainQuote;
}

/** Persisted Tron operation view. */
export interface TronOperation extends OperationBase {
  readonly family: 'tron';
  readonly kind: 'transaction' | 'contractCall' | 'sign' | 'signTypedData';
  readonly network?: TronNetwork;
  readonly transaction?: {
    readonly to: string;
    readonly value: string;
    readonly data?: `0x${string}`;
  };
  readonly call?: {
    readonly contract: string;
    readonly method: string;
    readonly args?: readonly TronAbiArg[];
  };
  readonly maxFee?: string;
  readonly quote?: ChainQuote;
  readonly fee?: FeeOption;
}

/** Union of all public wallet operation types across families. */
export type WalletOperation = EvmOperation | SolanaOperation | TronOperation;

/** Options for paginated local operation listing. */
export interface ListOperationsOptions {
  /** Filter by `'open'` (unsettled) or `'all'` (default `'all'`). */
  readonly status?: 'open' | 'all';
  /** Maximum items to return (default 50, max 200). */
  readonly limit?: number;
  /** Opaque pagination cursor from a previous page. */
  readonly cursor?: string;
}

/** One page of persisted operations. */
export interface OperationPage<TOperation extends WalletOperation> {
  readonly items: readonly TOperation[];
  readonly nextCursor?: string;
}

/** Options for `waitForOperation`. */
export interface WaitForOperationOptions {
  /** Maximum total wall-clock wait duration in milliseconds (1–300,000). */
  readonly timeoutMs: number;
  /** Delay between remote refresh turns in milliseconds (default 2,000, clamped to 250–30,000). */
  readonly pollIntervalMs?: number;
  /** Stops local waiting only; never cancels an already-submitted transaction. */
  readonly signal?: AbortSignal;
}

/** Outcome of `waitForOperation`, keeping timeout/cancel distinct from transaction failure. */
export type WaitResult<TOperation extends WalletOperation> =
  | { readonly outcome: 'settled'; readonly operation: TOperation }
  | { readonly outcome: 'reconciliation-required'; readonly operation: TOperation }
  | { readonly outcome: 'timed-out'; readonly operation: TOperation }
  | { readonly outcome: 'cancelled'; readonly operation: TOperation };

/** Derived next-action classification returned by `describeOperation`. */
export type OperationNextAction =
  'await-review' | 'poll-original' | 'reconcile-original' | 'safe-to-reprepare' | 'done';

/** Pure derived decision guidance for orchestrators and agents. */
export interface OperationGuidance {
  readonly action: OperationNextAction;
  readonly reason: string;
  readonly operationId: string;
  readonly txnId?: string;
  readonly txnHash?: string;
  readonly reviewId?: string;
}

export interface GetEvmBalancesOptions {
  readonly chainIds?: readonly number[];
  readonly page?: number;
}

export interface GetSolanaBalancesOptions {
  readonly networks?: readonly SolanaNetwork[];
}

export interface GetTronBalancesOptions {
  readonly networks?: readonly TronNetwork[];
}

/** Unattested indexer reads bound to this wallet's initialized addresses. */
export interface WalletIndexerFacet {
  /** EVM balances for this wallet's initialized EVM address (throws `WALLET_NOT_INITIALIZED` if uninitialized). */
  getEvmBalances(options?: GetEvmBalancesOptions): Promise<EvmBalances>;
  /** Solana balances for this wallet's initialized Solana address (throws `WALLET_NOT_INITIALIZED` if uninitialized). */
  getSolanaBalances(options?: GetSolanaBalancesOptions): Promise<ChainBalances>;
  /** Tron balances for this wallet's initialized Tron address (throws `WALLET_NOT_INITIALIZED` if uninitialized). */
  getTronBalances(options?: GetTronBalancesOptions): Promise<ChainBalances>;
}

/** Unattested indexer reads for arbitrary addresses on a wallet service. */
export interface ServiceIndexerFacet {
  getEvmBalances(address: string, options?: GetEvmBalancesOptions): Promise<EvmBalances>;
  getSolanaBalances(address: string, options?: GetSolanaBalancesOptions): Promise<ChainBalances>;
  getTronBalances(address: string, options?: GetTronBalancesOptions): Promise<ChainBalances>;
}

/** Base EVM operations available in both two-phase and immediate approval modes. */
export interface EvmFacetBase {
  prepareTransfer(input: EvmTransferInput): Promise<EvmOperation>;
  prepareCall<
    const abi extends Abi | readonly unknown[] = Abi,
    functionName extends ContractFunctionName<abi> = ContractFunctionName<abi>
  >(
    input: EvmCallInput<abi, functionName>
  ): Promise<EvmOperation>;
  /** Submit a previously prepared transfer or call bound to its exact `reviewId`. */
  execute(input: ExecuteInput): Promise<EvmOperation>;
  signMessage(input: EvmSignMessageInput): Promise<EvmOperation>;
  signTypedData(input: EvmSignTypedDataInput): Promise<EvmOperation>;
  /** Read the persisted EVM operation locally without authenticating or polling WaaS. */
  getOperation(id: string): Promise<EvmOperation | null>;
  /** Poll WaaS status for an unsettled EVM operation and persist the updated record. */
  refreshOperation(id: string): Promise<EvmOperation | null>;
  /** Observe an operation across bounded refresh turns, sleeping outside exclusive ownership. */
  waitForOperation(id: string, options: WaitForOperationOptions): Promise<WaitResult<EvmOperation>>;
  /**
   * Resolve an operation stuck in `unknown` / `RECONCILIATION_REQUIRED` after out-of-band
   * verification. Re-checks WaaS `TransactionStatus` under lock and only transitions to terminal
   * `expired` if WaaS still reports `TransactionExpired` past grace with no claim evidence.
   */
  resolveReconciliation(input: ResolveReconciliationInput): Promise<EvmOperation>;
  /** Bounded local listing of persisted EVM operations. */
  listOperations(options?: ListOperationsOptions): Promise<OperationPage<EvmOperation>>;
}

/** Immediate one-shot EVM shortcuts, present only when `approval: 'allow-immediate'` is enabled. */
export interface EvmImmediateFacet {
  sendTransfer(input: EvmTransferInput): Promise<EvmOperation>;
  sendCall<
    const abi extends Abi | readonly unknown[] = Abi,
    functionName extends ContractFunctionName<abi> = ContractFunctionName<abi>
  >(
    input: EvmCallInput<abi, functionName>
  ): Promise<EvmOperation>;
}

/**
 * EVM operations. `sendTransfer` and `sendCall` exist only with `approval: 'allow-immediate'`.
 * Flattened so declaration emit never needs the internal building-block interfaces.
 */
export type EvmFacet<TApproval extends ApprovalMode = 'two-phase'> = {
  [
    K in keyof (TApproval extends 'allow-immediate'
      ? EvmFacetBase & EvmImmediateFacet
      : EvmFacetBase)
  ]: (TApproval extends 'allow-immediate' ? EvmFacetBase & EvmImmediateFacet : EvmFacetBase)[K];
};

/** Base Solana operations available in both two-phase and immediate approval modes. */
export interface SolanaFacetBase {
  prepareTransfer(input: SolanaTransferInput): Promise<SolanaOperation>;
  execute(input: ExecuteInput): Promise<SolanaOperation>;
  signMessage(input: SolanaSignMessageInput): Promise<SolanaOperation>;
  getOperation(id: string): Promise<SolanaOperation | null>;
  refreshOperation(id: string): Promise<SolanaOperation | null>;
  waitForOperation(
    id: string,
    options: WaitForOperationOptions
  ): Promise<WaitResult<SolanaOperation>>;
  /** Resolve an operation in `unknown` / `RECONCILIATION_REQUIRED` after out-of-band verification. */
  resolveReconciliation(input: ResolveReconciliationInput): Promise<SolanaOperation>;
  listOperations(options?: ListOperationsOptions): Promise<OperationPage<SolanaOperation>>;
}

/** Immediate one-shot Solana shortcut, present only when `approval: 'allow-immediate'` is enabled. */
export interface SolanaImmediateFacet {
  sendTransfer(input: SolanaTransferInput): Promise<SolanaOperation>;
}

/** Solana operations. `sendTransfer` exists only with `approval: 'allow-immediate'`. */
export type SolanaFacet<TApproval extends ApprovalMode = 'two-phase'> = {
  [
    K in keyof (TApproval extends 'allow-immediate'
      ? SolanaFacetBase & SolanaImmediateFacet
      : SolanaFacetBase)
  ]: (TApproval extends 'allow-immediate'
    ? SolanaFacetBase & SolanaImmediateFacet
    : SolanaFacetBase)[K];
};

/** Base Tron operations available in both two-phase and immediate approval modes. */
export interface TronFacetBase {
  prepareTransaction(input: TronTransactionInput): Promise<TronOperation>;
  prepareContractCall(input: TronContractCallInput): Promise<TronOperation>;
  execute(input: ExecuteInput): Promise<TronOperation>;
  signMessage(input: TronSignMessageInput): Promise<TronOperation>;
  signTypedData(input: TronSignTypedDataInput): Promise<TronOperation>;
  getOperation(id: string): Promise<TronOperation | null>;
  refreshOperation(id: string): Promise<TronOperation | null>;
  waitForOperation(
    id: string,
    options: WaitForOperationOptions
  ): Promise<WaitResult<TronOperation>>;
  /** Resolve an operation in `unknown` / `RECONCILIATION_REQUIRED` after out-of-band verification. */
  resolveReconciliation(input: ResolveReconciliationInput): Promise<TronOperation>;
  listOperations(options?: ListOperationsOptions): Promise<OperationPage<TronOperation>>;
}

/** Immediate one-shot Tron shortcuts, present only when `approval: 'allow-immediate'` is enabled. */
export interface TronImmediateFacet {
  sendTransaction(input: TronTransactionInput): Promise<TronOperation>;
  sendContractCall(input: TronContractCallInput): Promise<TronOperation>;
}

/** Tron operations. `sendTransaction` and `sendContractCall` exist only with `approval: 'allow-immediate'`. */
export type TronFacet<TApproval extends ApprovalMode = 'two-phase'> = {
  [
    K in keyof (TApproval extends 'allow-immediate'
      ? TronFacetBase & TronImmediateFacet
      : TronFacetBase)
  ]: (TApproval extends 'allow-immediate' ? TronFacetBase & TronImmediateFacet : TronFacetBase)[K];
};

/** Base handle for a single OIDC identity's attested server wallet. */
export interface ServerWalletBase<TApproval extends ApprovalMode = 'two-phase'> {
  /** Pure local snapshot of persisted state; does not authenticate, poll WaaS, or mutate storage. */
  inspect(): Promise<WalletSnapshot>;
  /** Authenticate if needed and create or restore one wallet per requested family (default EVM). */
  createOrRestore(options?: CreateOrRestoreOptions): Promise<WalletSnapshot>;
  /** Revoke the current credential and authenticate a fresh one. */
  rotateCredential(): Promise<WalletSnapshot>;
  /** Persist disablement before revoking the current credential; blocks further auth until `enable()`. */
  disable(): Promise<WalletSnapshot>;
  /** Re-enable the wallet and authenticate a fresh credential for every held family. */
  enable(): Promise<WalletSnapshot>;
  readonly evm: EvmFacet<TApproval>;
  readonly solana: SolanaFacet<TApproval>;
  readonly tron: TronFacet<TApproval>;
  /** Explicitly unattested indexer reads for this wallet's initialized addresses. */
  readonly indexer: WalletIndexerFacet;
}

/** Single-identity server wallet handle, with `swaps` present only when `swaps: trails(...)` is configured. */
export type ServerWallet<
  TApproval extends ApprovalMode = 'two-phase',
  TSwaps extends SwapsConfig<'wallet', unknown> | undefined = undefined
> =
  TSwaps extends SwapsConfig<'wallet', infer TFacet>
    ? ServerWalletBase<TApproval> & { readonly swaps: TFacet }
    : ServerWalletBase<TApproval>;

/** Multi-tenant server wallet service factory. */
export interface ServerWalletService<
  TApproval extends ApprovalMode = 'two-phase',
  TSwaps extends SwapsConfig<'service', unknown> | undefined = undefined
> {
  /**
   * Obtain the wallet handle for a host-authenticated OIDC subject.
   * This is a lookup, not an authorization check: the host must authenticate the caller first.
   */
  forSubject(
    subject: string
  ): TSwaps extends SwapsConfig<'service', infer TFacet>
    ? ServerWalletBase<TApproval> & { readonly swaps: TFacet }
    : ServerWalletBase<TApproval>;
  /** Unattested indexer reads for arbitrary addresses. */
  readonly indexer: ServiceIndexerFacet;
}
