import type {
  Abi,
  AbiStateMutability,
  ContractFunctionArgs,
  ContractFunctionName,
  Hex
} from 'viem';

import type { AttestationOptions, SupportedEvmChainId } from './environment.js';
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
export type WalletStorageOption =
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

/**
 * What a typed-data signing policy is asked to approve. Built after the SDK has validated the
 * request and before WaaS is called; every field is a frozen copy, so the policy reads exactly
 * what will be signed.
 */
export interface TypedDataSigningRequest {
  readonly family: 'evm' | 'tron';
  /** The EVM chain ID, or the chain ID of the Tron network. */
  readonly chainId: number;
  /** The Tron network, for `family: 'tron'`. */
  readonly network?: TronNetwork;
  /** The OIDC subject of the wallet identity. */
  readonly subject: string;
  /** The signing wallet's address (`0x…` on EVM, `T…` on Tron). */
  readonly walletAddress: string;
  /** The durable operation's idempotency key; absent on the ephemeral signer. */
  readonly idempotencyKey?: string;
  /** The EIP-712 digest that will be signed. */
  readonly digest: `0x${string}`;
  /**
   * The normalized typed data: only the fields its types declare (the signed fields), the domain
   * bound to `chainId`, and on Tron every address in 20-byte hex form, as signed.
   */
  readonly typedData: TypedDataInput;
}

/**
 * Opt-in for `signTypedData`. Typed data can authorize anything a contract accepts (permits,
 * orders, approvals), so `signTypedData` exists only on wallets configured with this policy.
 */
export interface SigningOptions {
  /**
   * Called for every public typed-data signature, while the wallet's executor is held, after SDK
   * validation and before WaaS is called. Only a literal `true` lets the signature proceed; any
   * other result refuses it with `TYPED_DATA_REFUSED` and records nothing. A thrown error passes
   * through unchanged. Keep it fast: other calls for this wallet wait for it.
   */
  authorizeTypedData(request: TypedDataSigningRequest): boolean | Promise<boolean>;
}

/** Options for `createServerWallet`. */
export interface ServerWalletOptions {
  readonly publishableKey: string;
  /** Application Origin allowed by your OMS project (sent as the HTTP `Origin` header). */
  readonly origin?: string;
  readonly oidc: WalletOidcOptions;
  readonly storage: WalletStorageOption;
  /** Required exclusive ownership boundary for this wallet identity. */
  readonly executor: ExclusiveExecutor;
  /** `'allow-immediate'` adds the one-shot `send*` methods. Default `'two-phase'`. */
  readonly approval?: ApprovalMode;
  /** `trails(...)` from `/trails` with `scope: 'wallet'` adds `swaps`. */
  readonly swaps?: SwapsConfig<'wallet', unknown>;
  /** Adds `evm.signTypedData` and `tron.signTypedData`, gated by the policy. */
  readonly signing?: SigningOptions;
  readonly attestation?: AttestationOptions;
  /** Optional `fetch` override for instrumentation/testing; never bypasses Nitro attestation. */
  readonly fetch?: typeof fetch;
}

/** Options for `createServerWalletService`. */
export interface ServerWalletServiceOptions {
  readonly publishableKey: string;
  /** Application Origin allowed by your OMS project (sent as the HTTP `Origin` header). */
  readonly origin?: string;
  readonly oidc: ServiceOidcOptions;
  readonly storage: ServiceStorageOption;
  /** Required per-namespace exclusive ownership provider. */
  readonly executor: ExecutorProvider;
  /** `'allow-immediate'` adds the one-shot `send*` methods. Default `'two-phase'`. */
  readonly approval?: ApprovalMode;
  /** `trails(...)` from `/trails` with `scope: 'service'` adds `swaps`. */
  readonly swaps?: SwapsConfig<'service', unknown>;
  /** Adds `evm.signTypedData` and `tron.signTypedData`, gated by the policy. */
  readonly signing?: SigningOptions;
  readonly attestation?: AttestationOptions;
  /** Optional `fetch` override for instrumentation/testing; never bypasses Nitro attestation. */
  readonly fetch?: typeof fetch;
}

/** Public snapshot of a wallet identity's persisted state. */
export interface WalletSnapshot {
  /** One wallet per network family that has been created or restored. */
  readonly wallets: Readonly<Partial<Record<NetworkFamily, RemoteWallet>>>;
  readonly disabled: boolean;
  readonly expiresAt?: string;
  readonly credentialId?: string;
  /** True when a `CreateWallet` request for some family has an unknown outcome; restore again to settle it. */
  readonly creationUncertain: boolean;
}

/**
 * The wallet to use per family, by address. Needed only when an identity has more than one wallet
 * for a family (for example after two concurrent first-time creates): list them with
 * `listWallets()`, choose one, and pass it here. Once bound, a durable wallet remembers it.
 */
export type WalletSelection = Partial<Readonly<Record<NetworkFamily, string>>>;

/** A wallet WaaS holds for an identity, from `listWallets()`. */
export interface IdentityWallet {
  readonly family: NetworkFamily;
  readonly id: string;
  readonly address: string;
}

export interface CreateOrRestoreOptions {
  /** Network families to create or restore (defaults to `['evm']`). */
  readonly families?: readonly NetworkFamily[];
  /** See `WalletSelection`. */
  readonly wallets?: WalletSelection;
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
  | 'expired'
  /** Cancelled with `cancel` before it was submitted; nothing was sent. */
  | 'cancelled';

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
  readonly chainId: SupportedEvmChainId;
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
  readonly chainId: SupportedEvmChainId;
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
  readonly chainId: SupportedEvmChainId;
  readonly message: string;
}

/** Input to `wallet.evm.signTypedData`. */
export interface EvmSignTypedDataInput {
  readonly idempotencyKey: string;
  readonly chainId: SupportedEvmChainId;
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

/**
 * Highest TRX fee, in sun, a quote may carry when delegated energy and bandwidth do not cover the
 * transaction. The SDK refuses a quote whose TRX fee option is above it and pays that option at
 * Execute; WaaS refuses Execute if the transaction was re-priced above the quote. It is a bound on
 * the quoted fee, not on energy actually burned. Omit it to require full sponsorship
 * (`SPONSORSHIP_REQUIRED` otherwise).
 */
export type TronMaxQuotedFee = string;

/** Input to `wallet.tron.prepareTransfer` and `wallet.tron.sendTransfer`. */
export interface TronTransferInput {
  readonly idempotencyKey: string;
  readonly network: TronNetwork;
  /** Base58Check recipient (`T…`). */
  readonly to: string;
  /** `'native'` for TRX or a TRC-20 token contract (`T…`). */
  readonly asset: 'native' | string;
  /** Positive base-unit decimal string: sun for TRX (below 2^63), token units for TRC-20 (uint256). */
  readonly amount: string;
  /** See `TronMaxQuotedFee`. */
  readonly maxQuotedFee?: TronMaxQuotedFee;
}

/** Normalized Tron transfer stored on a `TronOperation`. */
export interface TronTransfer {
  readonly network: TronNetwork;
  readonly to: string;
  readonly asset: 'native' | string;
  readonly amount: string;
}

/** Typed ABI argument for `wallet.tron.prepareCall` / `sendCall`. */
export interface TronAbiArg {
  readonly type: string;
  readonly value: unknown;
}

/**
 * Input to `wallet.tron.prepareCall` and `wallet.tron.sendCall`: either a function name with typed
 * arguments (encoded by WaaS) or pre-encoded calldata with an optional TRX value.
 */
export type TronCallInput = {
  readonly idempotencyKey: string;
  readonly network: TronNetwork;
  /** Base58Check contract address (`T…`). */
  readonly to: string;
  /** See `TronMaxQuotedFee`. */
  readonly maxQuotedFee?: TronMaxQuotedFee;
} & (
  | {
      /** Function name alone (such as `'approve'`). */
      readonly method: string;
      readonly args?: readonly TronAbiArg[];
      readonly data?: never;
      readonly value?: never;
    }
  | {
      /** 0x-prefixed calldata. */
      readonly data: `0x${string}`;
      /** TRX sent with the call, in sun (default `'0'`). */
      readonly value?: string;
      readonly method?: never;
      readonly args?: never;
    }
);

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
  readonly submissionMode: SubmissionMode;
  /** True only when the SDK has durable proof that no broadcast/claim occurred. */
  readonly provenUnsent: boolean;
  /**
   * Set when an operator resolved an unconfirmed submission as not broadcast through
   * `resolveReconciliation`. An operator assertion, not SDK proof, so `provenUnsent` stays false.
   */
  readonly operatorResolved?: true;
  readonly error?: WalletErrorCode;
}

/**
 * Fields an operation's `status` guarantees. Narrowing on `status` narrows these: a `quoted`
 * operation always has its `quote` and the `reviewId` that `execute` requires; a submitted one
 * (`submitting`, `pending`, `executed`) always has its `quote`; a `signed` one always has its
 * verified `signature`. `reviewId` binds the reviewed terms; `txnHash` is the chain transaction
 * reference (a Solana signature or a Tron transaction ID on those chains), which can arrive after
 * `executed`.
 */
export type OperationState<TQuote> =
  | {
      readonly status: 'preparing';
      readonly quote?: undefined;
      readonly reviewId?: undefined;
      readonly txnHash?: undefined;
      readonly signature?: undefined;
      readonly verified?: undefined;
    }
  | {
      readonly status: 'quoted';
      readonly quote: TQuote;
      readonly reviewId: string;
      readonly txnHash?: undefined;
      readonly signature?: undefined;
      readonly verified?: undefined;
    }
  | {
      readonly status: 'submitting' | 'pending' | 'executed';
      readonly quote: TQuote;
      readonly reviewId?: string;
      readonly txnHash?: string;
      readonly signature?: undefined;
      readonly verified?: undefined;
    }
  | {
      readonly status: 'unknown' | 'failed' | 'expired' | 'cancelled';
      readonly quote?: TQuote;
      readonly reviewId?: string;
      readonly txnHash?: string;
      readonly signature?: undefined;
      readonly verified?: undefined;
    }
  | {
      readonly status: 'signed';
      readonly signature: string;
      readonly verified: true;
      readonly quote?: undefined;
      readonly reviewId?: undefined;
      readonly txnHash?: undefined;
    };

/** Persisted EVM operation view. */
export type EvmOperation = OperationBase & {
  readonly family: 'evm';
  readonly kind: 'transfer' | 'call' | 'sign' | 'signTypedData';
  readonly chainId: number;
  readonly transfer?: EvmTransfer;
  readonly transaction?: { readonly to: string; readonly data: string; readonly value: string };
} & OperationState<Quote>;

/** Persisted Solana operation view. */
export type SolanaOperation = OperationBase & {
  readonly family: 'solana';
  readonly kind: 'transfer' | 'sign';
  readonly network?: SolanaNetwork;
  readonly transfer?: SolanaTransfer;
} & OperationState<ChainQuote>;

/** Persisted Tron operation view. */
export type TronOperation = OperationBase & {
  readonly family: 'tron';
  readonly kind: 'transfer' | 'call' | 'sign' | 'signTypedData';
  readonly network?: TronNetwork;
  /** Set for `kind: 'transfer'`. */
  readonly transfer?: TronTransfer;
  /** Set for a `kind: 'call'` made with calldata. */
  readonly transaction?: {
    readonly to: string;
    readonly value: string;
    readonly data: `0x${string}`;
  };
  /** Set for a `kind: 'call'` made with a function name and arguments. */
  readonly call?: {
    readonly to: string;
    readonly method: string;
    readonly args: readonly TronAbiArg[];
  };
  readonly maxQuotedFee?: TronMaxQuotedFee;
  /** The TRX fee option paid at Execute, when the quote was not sponsored. */
  readonly fee?: FeeOption;
} & OperationState<ChainQuote>;

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
  /** Delay between remote refresh turns in milliseconds (default 2,000; a finite number, clamped to 250–30,000). */
  readonly pollIntervalMs?: number;
  /** Stops local waiting only (outcome `aborted`); never cancels a transaction. Use `cancel` for that. */
  readonly signal?: AbortSignal;
}

/**
 * Outcome of `waitForOperation`. A finished operation reports its terminal status as the outcome,
 * and `operation` is narrowed to that status: only `executed` means WaaS executed the
 * transaction (its `txnHash` can still be missing; refresh to obtain it), while `failed`,
 * `expired` and `cancelled` mean it did not (check `operation.provenUnsent` before preparing a
 * replacement), and `signed` ends a signing operation. `reconciliation-required` needs an
 * operator. `timed-out` and `aborted` mean the wait itself ended first; `operation` is the last
 * view read, absent if even the first read did not finish in time.
 */
export type WaitResult<TOperation extends WalletOperation> =
  | {
      readonly outcome: 'executed';
      readonly operation: TOperation & { readonly status: 'executed' };
    }
  | { readonly outcome: 'failed'; readonly operation: TOperation & { readonly status: 'failed' } }
  | { readonly outcome: 'expired'; readonly operation: TOperation & { readonly status: 'expired' } }
  | { readonly outcome: 'signed'; readonly operation: TOperation & { readonly status: 'signed' } }
  | {
      readonly outcome: 'cancelled';
      readonly operation: TOperation & { readonly status: 'cancelled' };
    }
  | {
      readonly outcome: 'reconciliation-required';
      readonly operation: TOperation & { readonly status: 'unknown' };
    }
  | { readonly outcome: 'timed-out' | 'aborted'; readonly operation?: TOperation };

/** Derived next-action classification returned by `describeOperation`. */
/**
 * Next safe action from `describeOperation`. Only `safe-to-reprepare` allows a new idempotency
 * key for the same payment; `resume-original` means repeat the original call with the same key.
 */
export type OperationNextAction =
  | 'await-review'
  | 'resume-original'
  | 'poll-original'
  | 'reconcile-original'
  | 'safe-to-reprepare'
  | 'investigate'
  | 'done';

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
  readonly chainIds?: readonly SupportedEvmChainId[];
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

/** Input to `cancel` on the EVM, Solana and Tron facets. */
export interface CancelInput {
  /** The operation to cancel; it must be `preparing` or `quoted` (not yet submitted). */
  readonly idempotencyKey: string;
}

/** WaaS status of a transaction, read by `getTransactionStatus`. */
export interface TransactionStatusView {
  readonly txnId: string;
  readonly status: 'quoted' | 'pending' | 'executed' | 'failed';
  readonly txnHash?: string;
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
  /**
   * Cancel a transaction that has not been submitted (`preparing` or `quoted`). It becomes
   * terminal `cancelled` with `provenUnsent: true`, and `execute` refuses it from then on, so a
   * replacement can be prepared under a new key. Cancelling again is a no-op; any later status
   * is refused with `INVALID_STATE`.
   */
  cancel(input: CancelInput): Promise<EvmOperation>;
  /**
   * Read-only WaaS status of a transaction by its `txnId` (`operation.quote.txnId`). Never changes
   * a stored operation; use `refreshOperation` to settle one. A `quoted` answer, or a
   * `TransactionExpired` error, does not prove nothing was broadcast while WaaS reads are still
   * catching up after the quote expired.
   */
  getTransactionStatus(txnId: string): Promise<TransactionStatusView>;
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

/** EVM typed-data signing, present only when the factory receives `signing`. */
export interface EvmTypedDataFacet {
  /**
   * Sign EIP-712 data after `signing.authorizeTypedData` returns `true`. Refuses Sequence wallet
   * `Calls` and typed data whose `verifyingContract` is the wallet.
   */
  signTypedData(input: EvmSignTypedDataInput): Promise<EvmOperation>;
}

/**
 * EVM operations. `sendTransfer` and `sendCall` exist only with `approval: 'allow-immediate'`;
 * `signTypedData` only with `signing`. Flattened so declaration emit never needs the internal
 * building-block interfaces.
 */
export type EvmFacet<
  TApproval extends ApprovalMode = 'two-phase',
  TTypedData extends boolean = false
> = {
  [
    K in keyof (EvmFacetBase &
      (TApproval extends 'allow-immediate' ? EvmImmediateFacet : unknown) &
      (TTypedData extends true ? EvmTypedDataFacet : unknown))
  ]: (EvmFacetBase &
    (TApproval extends 'allow-immediate' ? EvmImmediateFacet : unknown) &
    (TTypedData extends true ? EvmTypedDataFacet : unknown))[K];
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
  /**
   * Cancel a transaction that has not been submitted (`preparing` or `quoted`). It becomes
   * terminal `cancelled` with `provenUnsent: true`, and `execute` refuses it from then on, so a
   * replacement can be prepared under a new key. Cancelling again is a no-op; any later status
   * is refused with `INVALID_STATE`.
   */
  cancel(input: CancelInput): Promise<SolanaOperation>;
  /**
   * Read-only WaaS status of a transaction by its `txnId` (`operation.quote.txnId`). Never changes
   * a stored operation; use `refreshOperation` to settle one. A `quoted` answer, or a
   * `TransactionExpired` error, does not prove nothing was broadcast while WaaS reads are still
   * catching up after the quote expired.
   */
  getTransactionStatus(txnId: string): Promise<TransactionStatusView>;
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
  prepareTransfer(input: TronTransferInput): Promise<TronOperation>;
  prepareCall(input: TronCallInput): Promise<TronOperation>;
  execute(input: ExecuteInput): Promise<TronOperation>;
  signMessage(input: TronSignMessageInput): Promise<TronOperation>;
  getOperation(id: string): Promise<TronOperation | null>;
  refreshOperation(id: string): Promise<TronOperation | null>;
  waitForOperation(
    id: string,
    options: WaitForOperationOptions
  ): Promise<WaitResult<TronOperation>>;
  /** Resolve an operation in `unknown` / `RECONCILIATION_REQUIRED` after out-of-band verification. */
  resolveReconciliation(input: ResolveReconciliationInput): Promise<TronOperation>;
  listOperations(options?: ListOperationsOptions): Promise<OperationPage<TronOperation>>;
  /**
   * Cancel a transaction that has not been submitted (`preparing` or `quoted`). It becomes
   * terminal `cancelled` with `provenUnsent: true`, and `execute` refuses it from then on, so a
   * replacement can be prepared under a new key. Cancelling again is a no-op; any later status
   * is refused with `INVALID_STATE`.
   */
  cancel(input: CancelInput): Promise<TronOperation>;
  /**
   * Read-only WaaS status of a transaction by its `txnId` (`operation.quote.txnId`). Never changes
   * a stored operation; use `refreshOperation` to settle one. A `quoted` answer, or a
   * `TransactionExpired` error, does not prove nothing was broadcast while WaaS reads are still
   * catching up after the quote expired.
   */
  getTransactionStatus(txnId: string): Promise<TransactionStatusView>;
}

/** Immediate one-shot Tron shortcuts, present only when `approval: 'allow-immediate'` is enabled. */
export interface TronImmediateFacet {
  sendTransfer(input: TronTransferInput): Promise<TronOperation>;
  sendCall(input: TronCallInput): Promise<TronOperation>;
}

/** Tron typed-data signing, present only when the factory receives `signing`. */
export interface TronTypedDataFacet {
  /**
   * Sign TIP-712 data after `signing.authorizeTypedData` returns `true`. Refuses typed data whose
   * `verifyingContract` is the wallet.
   */
  signTypedData(input: TronSignTypedDataInput): Promise<TronOperation>;
}

/**
 * Tron operations. `sendTransfer` and `sendCall` exist only with `approval: 'allow-immediate'`;
 * `signTypedData` only with `signing`.
 */
export type TronFacet<
  TApproval extends ApprovalMode = 'two-phase',
  TTypedData extends boolean = false
> = {
  [
    K in keyof (TronFacetBase &
      (TApproval extends 'allow-immediate' ? TronImmediateFacet : unknown) &
      (TTypedData extends true ? TronTypedDataFacet : unknown))
  ]: (TronFacetBase &
    (TApproval extends 'allow-immediate' ? TronImmediateFacet : unknown) &
    (TTypedData extends true ? TronTypedDataFacet : unknown))[K];
};

/** Base handle for a single OIDC identity's attested server wallet. */
export interface ServerWalletBase<
  TApproval extends ApprovalMode = 'two-phase',
  TTypedData extends boolean = false
> {
  /** Pure local snapshot of persisted state; does not authenticate, poll WaaS, or mutate storage. */
  inspect(): Promise<WalletSnapshot>;
  /** Authenticate if needed and create or restore one wallet per requested family (default EVM). */
  createOrRestore(options?: CreateOrRestoreOptions): Promise<WalletSnapshot>;
  /**
   * Every wallet WaaS holds for this identity, signing in if needed. Use it when restore fails
   * with `WALLET_MISMATCH` because a family has several wallets, then pass the chosen one as
   * `wallets` to `createOrRestore`.
   */
  listWallets(): Promise<readonly IdentityWallet[]>;
  /** Revoke the current credential and authenticate a fresh one. */
  rotateCredential(): Promise<WalletSnapshot>;
  /** Persist disablement before revoking the current credential; blocks further auth until `enable()`. */
  disable(): Promise<WalletSnapshot>;
  /** Re-enable the wallet and authenticate a fresh credential for every held family. */
  enable(): Promise<WalletSnapshot>;
  readonly evm: EvmFacet<TApproval, TTypedData>;
  readonly solana: SolanaFacet<TApproval>;
  readonly tron: TronFacet<TApproval, TTypedData>;
  /** Explicitly unattested indexer reads for this wallet's initialized addresses. */
  readonly indexer: WalletIndexerFacet;
}

/** Single-identity server wallet handle, with `swaps` present only when `swaps: trails(...)` is configured. */
export type ServerWallet<
  TApproval extends ApprovalMode = 'two-phase',
  TSwaps extends SwapsConfig<'wallet', unknown> | undefined = undefined,
  TTypedData extends boolean = false
> =
  TSwaps extends SwapsConfig<'wallet', infer TFacet>
    ? ServerWalletBase<TApproval, TTypedData> & { readonly swaps: TFacet }
    : ServerWalletBase<TApproval, TTypedData>;

/** Multi-tenant server wallet service factory. */
export interface ServerWalletService<
  TApproval extends ApprovalMode = 'two-phase',
  TSwaps extends SwapsConfig<'service', unknown> | undefined = undefined,
  TTypedData extends boolean = false
> {
  /**
   * Obtain the wallet handle for a host-authenticated OIDC subject.
   * This is a lookup, not an authorization check: the host must authenticate the caller first.
   */
  forSubject(
    subject: string
  ): TSwaps extends SwapsConfig<'service', infer TFacet>
    ? ServerWalletBase<TApproval, TTypedData> & { readonly swaps: TFacet }
    : ServerWalletBase<TApproval, TTypedData>;
  /** Unattested indexer reads for arbitrary addresses. */
  readonly indexer: ServiceIndexerFacet;
}

/** Options for `createEphemeralServerWallet`. There is no store, executor, swaps or approval mode. */
export interface EphemeralServerWalletOptions {
  readonly publishableKey: string;
  /** Application origin sent to WaaS, when the project restricts origins. */
  readonly origin?: string;
  /** OIDC identity. `sessionLifetimeSeconds` defaults to 3600 (one hour) for ephemeral handles. */
  readonly oidc: WalletOidcOptions;
  /** Adds `evm.signTypedData` and `tron.signTypedData`, gated by the policy. */
  readonly signing?: SigningOptions;
  readonly attestation?: AttestationOptions;
  readonly fetch?: typeof fetch;
}

/** Wallets and credential held by an ephemeral handle. */
export interface EphemeralWalletSnapshot {
  readonly wallets: Readonly<Partial<Record<NetworkFamily, RemoteWallet>>>;
  readonly expiresAt?: string;
  readonly credentialId?: string;
}

/** A signature that WaaS produced and then verified. */
export interface SignatureResult {
  readonly signature: string;
  readonly verified: true;
}

/**
 * Memory-only signer for one OIDC identity, from `createEphemeralServerWallet`. It signs and reads
 * balances; it cannot prepare or send transactions and keeps no operation records. `restore()`
 * binds existing wallets and `create()` creates missing ones. Not assignable to `ServerWallet`.
 * Call `close()` when done.
 */
export interface EphemeralServerWallet<TTypedData extends boolean = false> {
  /**
   * Sign in and bind wallets that already exist on WaaS; never creates one. With `families`, each
   * must exist; without, every existing family is bound. Throws `WALLET_NOT_INITIALIZED` when
   * none exists. Required before signing or balance reads.
   */
  restore(options?: CreateOrRestoreOptions): Promise<EphemeralWalletSnapshot>;
  /**
   * Bind existing wallets and create missing ones (default EVM). Call it where a user's wallets
   * are first set up, such as signup, and `restore()` everywhere else: WaaS does not deduplicate
   * wallet creation, so two processes creating one new identity's wallets at once give it two
   * wallets per family. Concurrent calls within one process are run one at a time. After an
   * unknown outcome it throws `CREATION_UNCERTAIN`; call `restore()` later, not `create()`.
   */
  create(options?: CreateOrRestoreOptions): Promise<EphemeralWalletSnapshot>;
  /** Every wallet WaaS holds for this identity; see `ServerWalletBase.listWallets`. */
  listWallets(): Promise<readonly IdentityWallet[]>;
  inspect(): Promise<EphemeralWalletSnapshot>;
  /** Revoke this handle's credential and sign in again with a new one. */
  rotateCredential(): Promise<EphemeralWalletSnapshot>;
  /**
   * Close the handle and revoke its credential. Every later call, including calls already queued,
   * throws `WALLET_CLOSED`. Idempotent; call again to retry a revoke that failed.
   */
  close(): Promise<void>;
  readonly evm: {
    signMessage(input: {
      readonly chainId: SupportedEvmChainId;
      readonly message: string;
    }): Promise<SignatureResult>;
  } & (TTypedData extends true
    ? {
        /**
         * Sign EIP-712 data after `signing.authorizeTypedData` returns `true`. Refuses Sequence
         * wallet `Calls` and typed data whose `verifyingContract` is the wallet.
         */
        signTypedData(input: {
          readonly chainId: SupportedEvmChainId;
          readonly typedData: TypedDataInput;
        }): Promise<SignatureResult>;
      }
    : unknown);
  readonly solana: {
    signMessage(input: { readonly message: string }): Promise<SignatureResult>;
  };
  readonly tron: {
    signMessage(input: { readonly message: string }): Promise<SignatureResult>;
  } & (TTypedData extends true
    ? {
        /**
         * Sign TIP-712 data after `signing.authorizeTypedData` returns `true`. Refuses typed data
         * whose `verifyingContract` is the wallet.
         */
        signTypedData(input: {
          readonly network: TronNetwork;
          readonly typedData: TypedDataInput;
        }): Promise<SignatureResult>;
      }
    : unknown);
  readonly indexer: WalletIndexerFacet;
}
