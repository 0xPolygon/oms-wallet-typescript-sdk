import type { Address, Hex } from 'viem';

import type {
  FeeOptionSelector,
  Network,
  SendTransactionResponse,
  StorageManager
} from '@polygonlabs/oms-wallet';

import type { PrivacyQuote } from './quote.js';

export type { PrivacyQuote, PrivacyQuoteKind } from './quote.js';

/** Options for `privacy()`. */
export interface PrivacyOptions {
  /**
   * Where the package keeps a fingerprint of each wallet's private-balance keys, to detect if they
   * ever change. Defaults to localStorage in browsers and memory elsewhere.
   */
  storage?: StorageManager;
}

/** A token in a private balance. The native token is `0x0000000000000000000000000000000000000000`. */
export interface PrivateBalance {
  readonly network: Network;
  readonly token: Address;
  /** Spendable private balance, in the token's base units. */
  readonly amount: bigint;
  /**
   * Funds from private sends that were deposited but not delivered, in base units. Not spendable;
   * `recover` pays them back to the wallet.
   */
  readonly recoverable: bigint;
}

export interface GetPrivateBalancesParams {
  /** Defaults to every network in `networks`. */
  networks?: ReadonlyArray<Network>;
}

export interface QuoteShieldParams {
  network: Network;
  token: Address;
  /** In the token's base units. */
  amount: bigint;
}

export interface QuoteUnshieldParams {
  network: Network;
  token: Address;
  /** What `to` receives, in the token's base units. */
  amount: bigint;
  /** Defaults to the active wallet. */
  to?: Address;
}

export interface QuotePrivateSendParams {
  network: Network;
  token: Address;
  /** What `to` receives, in the token's base units. */
  amount: bigint;
  to: Address;
}

export interface RecoverParams {
  network: Network;
  token: Address;
}

export interface GetDeliveryStatusParams {
  deliveryId: string;
}

/** A network fee paid for one wallet transaction. */
export interface NetworkFee {
  /** The fee token; the native token is `0x0000000000000000000000000000000000000000`. */
  readonly token: Address;
  /** In the fee token's base units. */
  readonly amount: bigint;
}

/** A wallet transaction step. Steps that are not needed are skipped. */
export type PrivacyTransactionStep = 'reset-approval' | 'approve' | 'deposit';

export type PrivacyProgressEvent =
  | {
      readonly step: PrivacyTransactionStep;
      /**
       * `prepared`: the wallet has a transaction ID and nothing is submitted yet; store `txnId` to
       * reconcile later. `confirmed`: it executed on chain.
       */
      readonly state: 'prepared' | 'confirmed';
      readonly txnId: string;
      readonly txnHash?: Hex;
      /** Undefined for sponsored transactions and before a fee is chosen. */
      readonly networkFee?: NetworkFee;
    }
  | {
      readonly step: 'delivery';
      readonly state: 'pending' | 'delivered';
      readonly deliveryId: string;
      readonly txnHash?: Hex;
    };

export interface DepositOptions {
  /**
   * Chooses the network fee of each wallet transaction. By default the fee is paid in the token
   * being moved, and the call fails before sending if that is not possible.
   */
  selectFeeOption?: FeeOptionSelector;
  /**
   * The most each wallet transaction may pay in network fees, in the moved token's base units.
   * Applies when the fee is paid in the moved token; above it the call fails before that
   * transaction executes.
   */
  maxNetworkFee?: bigint;
  /**
   * Called as each step progresses. For `prepared` events it is awaited before the transaction
   * executes, so an async callback can store `txnId` first; if it throws or rejects, that
   * transaction is not executed. Errors from other events are ignored.
   */
  onProgress?: (event: PrivacyProgressEvent) => void | Promise<void>;
}

export interface PrivacyTransaction {
  readonly step: PrivacyTransactionStep;
  readonly response: SendTransactionResponse;
  readonly networkFee?: NetworkFee;
}

export interface ShieldResult {
  /** Every wallet transaction sent, in order. The last one is the deposit. */
  readonly transactions: ReadonlyArray<PrivacyTransaction>;
}

export interface DeliveryPollingOptions {
  /** Defaults to 15 minutes. */
  timeoutMs?: number;
  /** Defaults to 3 seconds. */
  intervalMs?: number;
}

export interface PrivateSendOptions extends DepositOptions {
  /** Wait until the recipient has the funds. Defaults to `false`. */
  waitForDelivery?: boolean;
  deliveryPolling?: DeliveryPollingOptions;
}

export interface PrivateSendResult {
  /** Every wallet transaction sent, in order. The last one is the deposit. */
  readonly transactions: ReadonlyArray<PrivacyTransaction>;
  /** Identifies the delivery to the recipient. Treat it as private: it reveals the delivery. */
  readonly deliveryId: string;
  /** Present when `waitForDelivery` was set. */
  readonly delivery?: DeliveryStatus;
}

export interface UnshieldResult {
  readonly txnHash: Hex;
}

export interface RecoverResult {
  /** One transaction per batch of recovered funds. */
  readonly txnHashes: ReadonlyArray<Hex>;
}

export interface DeliveryStatus {
  readonly status: 'pending' | 'delivered' | 'failed';
  /** The delivery transaction, once known. */
  readonly txnHash?: Hex;
}

/** `oms.privacy`, added by `new OMSWallet(...).extend(privacy())`. */
export interface PrivacyActions {
  /** Networks with private balances. */
  readonly networks: ReadonlyArray<Network>;
  /** Private balances of the active wallet with a non-zero amount. */
  getBalances(params?: GetPrivateBalancesParams): Promise<PrivateBalance[]>;
  /** Quotes moving tokens from the wallet into its private balance; `shield` runs it. */
  quoteShield(params: QuoteShieldParams): Promise<PrivacyQuote<'shield'>>;
  /** Quotes moving tokens from the private balance to an address; `unshield` runs it. */
  quoteUnshield(params: QuoteUnshieldParams): Promise<PrivacyQuote<'unshield'>>;
  /**
   * Quotes sending tokens from the wallet to an address without an on-chain link between the two;
   * `privateSend` runs it.
   */
  quotePrivateSend(params: QuotePrivateSendParams): Promise<PrivacyQuote<'privateSend'>>;
  shield(quote: PrivacyQuote<'shield'>, options?: DepositOptions): Promise<ShieldResult>;
  /** Sends no wallet transaction: the privacy service submits the withdrawal. */
  unshield(quote: PrivacyQuote<'unshield'>): Promise<UnshieldResult>;
  privateSend(
    quote: PrivacyQuote<'privateSend'>,
    options?: PrivateSendOptions
  ): Promise<PrivateSendResult>;
  getDeliveryStatus(params: GetDeliveryStatusParams): Promise<DeliveryStatus>;
  /** Pays all recoverable funds of a token back to the active wallet. */
  recover(params: RecoverParams): Promise<RecoverResult>;
}
