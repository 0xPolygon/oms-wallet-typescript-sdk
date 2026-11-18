import type { Hex } from 'viem';

import { isOMSWalletError } from '@polygonlabs/oms-wallet';

import type { PrivacyTransactionStep } from './types.js';

export type OMSWalletPrivacyErrorCode =
  /** The network has no private balances. */
  | 'OMS_PRIVACY_UNSUPPORTED_NETWORK'
  /** Invalid input: a zero amount, a bad address, or a quote of the wrong kind. */
  | 'OMS_PRIVACY_INVALID_PARAMS'
  /** The quote expired, was already used, or was made for another wallet. */
  | 'OMS_PRIVACY_QUOTE_INVALID'
  /** No active Ethereum wallet. */
  | 'OMS_PRIVACY_NO_WALLET'
  /** The active wallet changed while the call ran. */
  | 'OMS_PRIVACY_WALLET_CHANGED'
  /** The wallet refused or failed a request before any transaction was created; see `cause`. */
  | 'OMS_PRIVACY_WALLET_ERROR'
  /** The private balance cannot cover the amount and fee. */
  | 'OMS_PRIVACY_INSUFFICIENT_BALANCE'
  /** There are no recoverable funds for this token. */
  | 'OMS_PRIVACY_NOTHING_TO_RECOVER'
  /** The network fee cannot be paid in the moved token, or is above `maxNetworkFee`. */
  | 'OMS_PRIVACY_NETWORK_FEE'
  /** A wallet transaction outside the quoted operation was attempted and refused. */
  | 'OMS_PRIVACY_UNAUTHORIZED_TRANSACTION'
  /** A wallet transaction failed or its outcome is unknown. See `txnIds`. */
  | 'OMS_PRIVACY_TRANSACTION_FAILED'
  /** The private send was deposited but could not be delivered; the funds are recoverable. */
  | 'OMS_PRIVACY_DELIVERY_FAILED'
  /** The delivery did not finish within the polling timeout. It may still finish. */
  | 'OMS_PRIVACY_DELIVERY_TIMEOUT'
  /**
   * The keys derived for this wallet's private balance differ from the ones seen before. Nothing
   * is shown or sent, since the balance would look empty.
   */
  | 'OMS_PRIVACY_KEY_MISMATCH'
  /** The privacy service failed or is unreachable. */
  | 'OMS_PRIVACY_SERVICE_ERROR';

/** Which part of an operation had run when it failed. */
export type OMSWalletPrivacyStage =
  'setup' | 'quote' | PrivacyTransactionStep | 'withdraw' | 'delivery';

export interface OMSWalletPrivacyErrorParams {
  code: OMSWalletPrivacyErrorCode;
  message: string;
  operation: string;
  stage?: OMSWalletPrivacyStage;
  txnIds?: ReadonlyArray<string>;
  txnHash?: Hex;
  deliveryId?: string;
  cause?: unknown;
}

/**
 * An error from `oms.privacy`. `txnIds` lists every wallet transaction the operation had created
 * when it failed, so for `shield` and `privateSend` an app can tell "no wallet transaction was sent"
 * (empty) from "a deposit may have been sent" and reconcile with `wallet.getTransactionStatus` and
 * `oms.privacy.getBalances`. `unshield` and `recover` send no wallet transaction, so their `txnIds`
 * is always empty; the message says whether the withdrawal may have been submitted.
 * `cause` is only set to an `OMSWalletError` from the wallet.
 */
export class OMSWalletPrivacyError extends Error {
  readonly code: OMSWalletPrivacyErrorCode;
  /** For example `privacy.shield`. */
  readonly operation: string;
  readonly stage?: OMSWalletPrivacyStage;
  readonly txnIds: ReadonlyArray<string>;
  readonly txnHash?: Hex;
  readonly deliveryId?: string;

  constructor(params: OMSWalletPrivacyErrorParams) {
    super(params.message);
    this.name = 'OMSWalletPrivacyError';
    this.code = params.code;
    this.operation = params.operation;
    this.stage = params.stage;
    this.txnIds = Object.freeze([...(params.txnIds ?? [])]);
    this.txnHash = params.txnHash;
    this.deliveryId = params.deliveryId;
    if (params.cause !== undefined && isOMSWalletError(params.cause)) {
      this.cause = params.cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isOMSWalletPrivacyError(error: unknown): error is OMSWalletPrivacyError {
  return error instanceof OMSWalletPrivacyError;
}
