import type { StoredEvmOperation } from '../state.js';
import type { ChainReader } from './chain.js';
import type { TrailsClient } from './client.js';
import type { BuiltRecovery, PreparedRecovery, TrailsReceipt } from './protocol.js';
import type { SwapAsset, SwapQuote, SwapRequest } from './quote.js';

export type SwapPhase =
  | 'quoted'
  | 'preparing'
  | 'activating'
  | 'funding'
  | 'settling'
  | 'succeeded'
  | 'expired'
  | 'failed'
  | 'attention'
  | 'recovering'
  | 'refunded';

export type SwapAction =
  | 'prepare-funding'
  | 'activate'
  | 'fund'
  | 'observe'
  | 'deploy-owner'
  | 'sign-recovery'
  | 'build-recovery'
  | 'submit-recovery'
  | 'observe-recovery'
  | null;

export interface RecoveryAsset {
  readonly asset: string;
  readonly amount: string;
  readonly decimals: number;
  readonly symbol: string;
}

export type RecoveryStatus =
  | 'quoted'
  | 'confirmed'
  | 'deploying'
  | 'signing'
  | 'submitting'
  | 'pending'
  | 'recovered'
  | 'partial'
  | 'failed'
  | 'expired';

/** Internal authoritative recovery record (serialized inside `StoredSwapEntry.payload`). */
export interface RecoveryRecord {
  id: string;
  source: 'origin' | 'destination';
  chainId: number;
  intentAddress: string;
  revision: string;
  expiresAt: string;
  assets: RecoveryAsset[];
  requiresOwnerDeployment: boolean;
  status: RecoveryStatus;
  prepared: PreparedRecovery;
  originalPrepared?: PreparedRecovery;
  signed?: StoredEvmOperation;
  built?: BuiltRecovery;
  deploymentId: string;
  signingId: string;
  transactionId: string;
  deployment?: StoredEvmOperation;
  transaction?: StoredEvmOperation;
  ownerBalances?: { asset: string; amount: string }[];
  error?: string;
  received?: RecoveryAsset[];
}

/** Internal authoritative swap record (never exposed publicly; serialized inside `StoredSwapEntry.payload`). */
export interface SwapRecord {
  id: string;
  version: number;
  requestHash: string;
  request: SwapRequest;
  owner: string;
  environment: string;
  assetMetadata?: {
    origin: { decimals: number; symbol?: string };
    destination: { decimals: number; symbol?: string };
  };
  quote: SwapQuote;
  phase: SwapPhase;
  action: SwapAction;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  nextAt: number | null;
  attempts: number;
  error?: string;
  fundingId: string;
  funding?: StoredEvmOperation;
  fundingConfirmed: boolean;
  upstreamStatus?: string;
  receipt?: TrailsReceipt;
  repairAttemptedAt?: string;
  recoveries: RecoveryRecord[];
  activeRecoveryId?: string;
}

/**
 * Opaque durable swap entry persisted by `SwapStore` / `NamespacedSwapStore`.
 * Hosts index the metadata fields for queries and wake-up alarms; encrypt `payload` at rest and
 * never return `payload` to browsers.
 */
export interface StoredSwapEntry {
  readonly id: string;
  readonly intentId: string;
  readonly version: number;
  readonly active: boolean;
  readonly nextAt: number | null;
  readonly createdAt: string;
  readonly payload: string;
}

/** Durable swap persistence scoped to one wallet identity. */
export interface SwapStore {
  get(id: string): Promise<StoredSwapEntry | null>;
  findIntent(intentId: string): Promise<string | null>;
  save(entry: StoredSwapEntry): Promise<void>;
  list(options: {
    readonly active?: boolean;
    readonly offset?: number;
    readonly limit: number;
  }): Promise<readonly StoredSwapEntry[]>;
}

/** Durable swap persistence partitioned by the SDK-computed wallet namespace. */
export interface NamespacedSwapStore {
  get(namespace: string, id: string): Promise<StoredSwapEntry | null>;
  findIntent(namespace: string, intentId: string): Promise<string | null>;
  save(namespace: string, entry: StoredSwapEntry): Promise<void>;
  list(
    namespace: string,
    options: { readonly active?: boolean; readonly offset?: number; readonly limit: number }
  ): Promise<readonly StoredSwapEntry[]>;
}

/** Explicit store scope passed to `trails(...)`. */
export type TrailsStoreOption =
  | { readonly scope: 'wallet'; readonly adapter: SwapStore }
  | { readonly scope: 'service'; readonly adapter: NamespacedSwapStore };

/** Options for `trails(...)` from `@polygonlabs/oms-server-wallet-sdk/trails`. */
export interface TrailsOptions<TStore extends TrailsStoreOption = TrailsStoreOption> {
  readonly apiKey: string;
  /** HTTPS JSON-RPC URLs keyed by EVM chain ID (used to verify balances, code, and receipts). */
  readonly chains: Readonly<Record<number, string>>;
  /** Host-approved swap asset allowlist (never supplied by an untrusted caller). */
  readonly assets: readonly SwapAsset[];
  readonly store: TStore;
  /** Stable endpoint/project identity (never an API key). A mismatch blocks replay. */
  readonly environment?: string;
  /** Set `false` to pause new swaps/funding while still allowing observation and recovery. Default `true`. */
  readonly enabled?: boolean;
  /** Optional Trails API HTTPS base origin override. */
  readonly baseUrl?: string;
  /** Optional HTTP Origin override (defaults to the wallet's `origin`). */
  readonly origin?: string;
  /** Request timeout in milliseconds (1–60,000; default 20,000). */
  readonly timeoutMs?: number;
  /** Optional `fetch` override for instrumentation/testing. */
  readonly fetch?: typeof fetch;
}

/** Internal gateway contract used by `TrailsCoordinator` and tests. */
export type SwapGateway = Pick<
  TrailsClient,
  | 'readiness'
  | 'quoteIntent'
  | 'getIntent'
  | 'executeIntent'
  | 'getIntentReceipt'
  | 'retryIntent'
  | 'prepareIntentRecovery'
  | 'buildIntentRecoveryTransaction'
>;

export interface TransactionView {
  readonly status: string;
  readonly txnId?: string;
  readonly hash?: string;
  readonly chainId: number;
  readonly sponsored: boolean;
  readonly error?: string;
}

export interface RecoveryView {
  readonly id: string;
  readonly source: 'origin' | 'destination';
  readonly chainId: number;
  readonly intentAddress: string;
  /** Opaque review ID required by `swaps.confirmRecovery`. */
  readonly reviewId: string;
  readonly expiresAt: string;
  readonly assets: readonly RecoveryAsset[];
  readonly requiresOwnerDeployment: boolean;
  readonly status: RecoveryStatus;
  readonly deployment?: TransactionView;
  readonly transaction?: TransactionView;
  readonly error?: string;
  readonly received?: readonly RecoveryAsset[];
}

/** Sanitized public projection of a swap safe to expose to UIs and API responses. */
export interface SwapView {
  readonly id: string;
  readonly version: number;
  readonly request: SwapRequest;
  readonly owner: string;
  readonly assetMetadata?: {
    readonly origin: { readonly decimals: number; readonly symbol?: string };
    readonly destination: { readonly decimals: number; readonly symbol?: string };
  };
  readonly phase: SwapPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmedAt?: string;
  readonly error?: string;
  readonly nextAt: number | null;
  readonly quote: {
    /** Opaque review ID required by `swaps.confirm`. */
    readonly reviewId: string;
    readonly expiresAt: string;
    readonly intentId: string;
    readonly expectedOutput: string;
    readonly minimumOutput: string;
    readonly inputAmount: string;
    readonly providers: readonly string[];
    readonly estimatedDuration?: number | null;
    readonly priceImpact: number;
    readonly fees: {
      readonly totalUsd: number;
      readonly gasUsd: number;
      readonly trailsUsd: number;
      readonly providerUsd: number;
    };
  };
  readonly funding?: TransactionView;
  readonly upstreamStatus?: string;
  readonly transactions: readonly {
    readonly chainId: number;
    readonly type: string;
    readonly status: string;
    readonly hash?: string;
  }[];
  readonly outputAmount?: string;
  readonly recoveries: readonly RecoveryView[];
  readonly canRecover: boolean;
  readonly refund?: {
    readonly chainId: number;
    readonly asset: string;
    readonly amount: string;
    readonly hash?: string;
    readonly status: string;
  };
}

export interface QuoteSwapInput extends SwapRequest {
  readonly idempotencyKey: string;
}

export interface ConfirmSwapInput {
  readonly swapId: string;
  /** Review ID from `quoted.quote.reviewId`. */
  readonly reviewId: string;
}

export interface ListSwapsOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SwapListPage {
  readonly items: readonly SwapView[];
  readonly nextCursor?: string;
}

export interface TickSwapsOptions {
  /** Maximum due swaps to advance in one bounded batch (1–10; default 3). */
  readonly limit?: number;
}

/** Result of `wallet.swaps.tick`, returning the earliest pending alarm timestamp. */
export interface TickSwapsResult {
  /** Epoch ms timestamp for the next scheduled wake-up, or `null` when no active swaps remain. */
  readonly nextAt: number | null;
}

export interface PrepareRecoveryInput {
  readonly swapId: string;
  readonly idempotencyKey: string;
  readonly source: 'origin' | 'destination';
}

export interface ConfirmRecoveryInput {
  readonly swapId: string;
  readonly recoveryId: string;
  /** Review ID from `recovery.reviewId`. */
  readonly reviewId: string;
}

/**
 * Input to `wallet.swaps.resolveReconciliation` after an operator has independently verified that
 * a funding or recovery transaction stuck in `unknown` / `RECONCILIATION_REQUIRED` was never
 * broadcast.
 */
export interface ResolveSwapReconciliationInput {
  readonly swapId: string;
  /** Must match the funding or active recovery transaction's WaaS `txnId`. */
  readonly txnId: string;
  readonly resolution: 'not-broadcast';
}

/**
 * Public swaps capability attached at `wallet.swaps` when `swaps: trails(...)` is configured.
 * Shares one identity executor and debit gate with `wallet.evm`.
 */
export interface SwapsFacet {
  /**
   * Request and validate an exact-input swap quote without activating or funding it.
   * Retrying with the same `idempotencyKey` and identical inputs returns the existing quote.
   */
  quote(input: QuoteSwapInput): Promise<SwapView>;
  /**
   * Authorize a reviewed swap quote bound to its exact `reviewId`, reserving its origin chain
   * before any funding or activation occurs. Repeated calls with the same `reviewId` are idempotent.
   */
  confirm(input: ConfirmSwapInput): Promise<SwapView>;
  /** Return the current sanitized view of a swap (expires unconfirmed quotes past deadline). */
  get(swapId: string): Promise<SwapView>;
  /** Paginated list of persisted swaps owned by this wallet. */
  list(options?: ListSwapsOptions): Promise<SwapListPage>;
  /** Advance one due swap if its `nextAt` has elapsed and return its updated view. */
  reconcile(swapId: string): Promise<SwapView>;
  /**
   * Advance one bounded batch of due swaps, reconcile orphaned reservations, and return the
   * earliest remaining `nextAt` timestamp for host / Durable Object alarm rescheduling.
   */
  tick(options?: TickSwapsOptions): Promise<TickSwapsResult>;
  /** Inspect on-chain intent balances and prepare a separately reviewable recovery plan. */
  prepareRecovery(input: PrepareRecoveryInput): Promise<SwapView>;
  /** Authorize a reviewed recovery bound to its exact `reviewId`. */
  confirmRecovery(input: ConfirmRecoveryInput): Promise<SwapView>;
  /**
   * Resolve a swap funding or recovery transaction stuck in `unknown` / `RECONCILIATION_REQUIRED`
   * after out-of-band verification, re-checking WaaS status under lock before releasing the chain.
   */
  resolveReconciliation(input: ResolveSwapReconciliationInput): Promise<SwapView>;
}

export type { ChainReader };
