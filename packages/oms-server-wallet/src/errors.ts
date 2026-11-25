/** Closed union of safe, machine-readable SDK error codes. */
export type WalletErrorCode =
  | 'APPROVAL_REQUIRED'
  | 'ATTESTATION_FAILED'
  | 'CHAIN_READ_FAILED'
  | 'CONFIGURATION'
  | 'CREATION_UNCERTAIN'
  | 'DEBIT_PENDING'
  | 'EXECUTE_REFUSED'
  | 'FEE_ABOVE_QUOTE'
  | 'FEE_LIMIT_EXCEEDED'
  | 'FUNDING_FAILED'
  | 'FUNDING_RECEIPT_UNVERIFIED'
  | 'FUNDING_REVERTED'
  | 'FUNDING_UNKNOWN'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDENTITY_MISMATCH'
  | 'INDEXER_UNAVAILABLE'
  | 'INSUFFICIENT_BALANCE'
  | 'INTENT_ALREADY_TRACKED'
  | 'INTENT_NOT_FUNDABLE'
  | 'INVALID_ADDRESS'
  | 'INVALID_AMOUNT'
  | 'INVALID_CALL'
  | 'INVALID_FAMILY'
  | 'INVALID_FEE'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'INVALID_IDENTITY'
  | 'INVALID_INPUT'
  | 'INVALID_JSON'
  | 'INVALID_MESSAGE'
  | 'INVALID_METHOD'
  | 'INVALID_PAGE'
  | 'INVALID_RECOVERY'
  | 'INVALID_RECOVERY_TRANSACTION'
  | 'INVALID_RESPONSE'
  | 'INVALID_STATE'
  | 'INVALID_SWAP'
  | 'INVALID_SWAP_QUOTE'
  | 'INVALID_TRANSFER'
  | 'INVALID_TYPED_DATA'
  | 'NO_CREDENTIAL'
  | 'NO_RECOVERABLE_BALANCE'
  | 'NOT_FOUND'
  | 'OPERATION_CANCELLED'
  | 'PREPARATION_FAILED'
  | 'QUOTE_EXPIRED'
  | 'RECONCILIATION_REQUIRED'
  | 'RECOVERY_CHANGED'
  | 'RECOVERY_EVIDENCE_PENDING'
  | 'RECOVERY_EXPIRED'
  | 'RECOVERY_FAILED'
  | 'RECOVERY_LIMIT'
  | 'RECOVERY_NOT_READY'
  | 'RECOVERY_PENDING'
  | 'REFUND_REQUIRES_REVIEW'
  | 'RESPONSE_TOO_LARGE'
  | 'RPC_CONFIGURATION'
  | 'SETTLEMENT_REQUIRES_REVIEW'
  | 'SIGNATURE_INVALID'
  | 'SIGNING_FAILED'
  | 'SPONSORSHIP_REQUIRED'
  | 'STALE_QUOTE'
  | 'STALE_RECOVERY'
  | 'STALE_REVIEW'
  | 'STORAGE_INTEGRITY'
  | 'SUBMISSION_UNCERTAIN'
  | 'SWAP_ENVIRONMENT_CHANGED'
  | 'SWAP_UNAVAILABLE'
  | 'SWAPS_COORDINATION_REQUIRED'
  | 'SWAPS_DISABLED'
  | 'TRAILS_ABORTED'
  | 'TRAILS_ERROR'
  | 'TRAILS_TIMEOUT'
  | 'TRAILS_UNAVAILABLE'
  | 'TYPED_DATA_REFUSED'
  | 'UNSUPPORTED_CHAIN'
  | 'UNSUPPORTED_NETWORK'
  | 'UNSUPPORTED_PROTOCOL'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_REDIRECT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'WALLET_BUSY'
  | 'WALLET_CLOSED'
  | 'WALLET_DISABLED'
  | 'WALLET_MISMATCH'
  | 'WALLET_NOT_INITIALIZED'
  | 'WALLET_PENDING';

/** Every `WalletErrorCode`; `satisfies` fails the build if this and the union ever differ. */
const WALLET_ERROR_CODES = {
  APPROVAL_REQUIRED: true,
  ATTESTATION_FAILED: true,
  CHAIN_READ_FAILED: true,
  CONFIGURATION: true,
  CREATION_UNCERTAIN: true,
  DEBIT_PENDING: true,
  EXECUTE_REFUSED: true,
  FEE_ABOVE_QUOTE: true,
  FEE_LIMIT_EXCEEDED: true,
  FUNDING_FAILED: true,
  FUNDING_RECEIPT_UNVERIFIED: true,
  FUNDING_REVERTED: true,
  FUNDING_UNKNOWN: true,
  IDEMPOTENCY_CONFLICT: true,
  IDENTITY_MISMATCH: true,
  INDEXER_UNAVAILABLE: true,
  INSUFFICIENT_BALANCE: true,
  INTENT_ALREADY_TRACKED: true,
  INTENT_NOT_FUNDABLE: true,
  INVALID_ADDRESS: true,
  INVALID_AMOUNT: true,
  INVALID_CALL: true,
  INVALID_FAMILY: true,
  INVALID_FEE: true,
  INVALID_IDEMPOTENCY_KEY: true,
  INVALID_IDENTITY: true,
  INVALID_INPUT: true,
  INVALID_JSON: true,
  INVALID_MESSAGE: true,
  INVALID_METHOD: true,
  INVALID_PAGE: true,
  INVALID_RECOVERY: true,
  INVALID_RECOVERY_TRANSACTION: true,
  INVALID_RESPONSE: true,
  INVALID_STATE: true,
  INVALID_SWAP: true,
  INVALID_SWAP_QUOTE: true,
  INVALID_TRANSFER: true,
  INVALID_TYPED_DATA: true,
  NO_CREDENTIAL: true,
  NO_RECOVERABLE_BALANCE: true,
  NOT_FOUND: true,
  OPERATION_CANCELLED: true,
  PREPARATION_FAILED: true,
  QUOTE_EXPIRED: true,
  RECONCILIATION_REQUIRED: true,
  RECOVERY_CHANGED: true,
  RECOVERY_EVIDENCE_PENDING: true,
  RECOVERY_EXPIRED: true,
  RECOVERY_FAILED: true,
  RECOVERY_LIMIT: true,
  RECOVERY_NOT_READY: true,
  RECOVERY_PENDING: true,
  REFUND_REQUIRES_REVIEW: true,
  RESPONSE_TOO_LARGE: true,
  RPC_CONFIGURATION: true,
  SETTLEMENT_REQUIRES_REVIEW: true,
  SIGNATURE_INVALID: true,
  SIGNING_FAILED: true,
  SPONSORSHIP_REQUIRED: true,
  STALE_QUOTE: true,
  STALE_RECOVERY: true,
  STALE_REVIEW: true,
  STORAGE_INTEGRITY: true,
  SUBMISSION_UNCERTAIN: true,
  SWAP_ENVIRONMENT_CHANGED: true,
  SWAP_UNAVAILABLE: true,
  SWAPS_COORDINATION_REQUIRED: true,
  SWAPS_DISABLED: true,
  TRAILS_ABORTED: true,
  TRAILS_ERROR: true,
  TRAILS_TIMEOUT: true,
  TRAILS_UNAVAILABLE: true,
  TYPED_DATA_REFUSED: true,
  UNSUPPORTED_CHAIN: true,
  UNSUPPORTED_NETWORK: true,
  UNSUPPORTED_PROTOCOL: true,
  UPSTREAM_ERROR: true,
  UPSTREAM_REDIRECT: true,
  UPSTREAM_UNAVAILABLE: true,
  WALLET_BUSY: true,
  WALLET_CLOSED: true,
  WALLET_DISABLED: true,
  WALLET_MISMATCH: true,
  WALLET_NOT_INITIALIZED: true,
  WALLET_PENDING: true
} as const satisfies Record<WalletErrorCode, true>;

/** Whether a string is one of the SDK's `WalletErrorCode`s. */
export function isWalletErrorCode(value: unknown): value is WalletErrorCode {
  return typeof value === 'string' && Object.hasOwn(WALLET_ERROR_CODES, value);
}

/**
 * Structured SDK error exposing a safe code, message, and HTTP-oriented status. When the SDK wraps
 * a lower-level failure (network, timeout, TLS), the original error is kept as `cause` for logs.
 */
export class WalletError extends Error {
  constructor(
    public readonly code: WalletErrorCode,
    message: string,
    public readonly status = 400,
    options?: { readonly cause?: unknown }
  ) {
    super(message, options);
    this.name = 'WalletError';
  }
}

/** Verified upstream WaaS RPC error with its numeric error code and RPC method name. */
export class UpstreamError extends WalletError {
  constructor(
    public readonly upstreamCode: number,
    public readonly method: string
  ) {
    super('UPSTREAM_ERROR', `WaaS ${method} failed (code ${upstreamCode}).`, 502);
    this.name = 'UpstreamError';
  }
}

/** Type guard for `WalletError` (including `UpstreamError` and `TrailsError`). */
export function isWalletError(error: unknown): error is WalletError {
  return error instanceof WalletError;
}

/** Type guard for verified WaaS RPC `UpstreamError` instances. */
export function isUpstreamError(error: unknown): error is UpstreamError {
  return error instanceof UpstreamError;
}
