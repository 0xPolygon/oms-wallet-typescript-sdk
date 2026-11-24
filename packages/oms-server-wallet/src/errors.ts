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
  | 'INVALID_TRANSACTION'
  | 'INVALID_TRANSFER'
  | 'INVALID_TYPED_DATA'
  | 'NO_CREDENTIAL'
  | 'NO_RECOVERABLE_BALANCE'
  | 'NOT_FOUND'
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
  | 'SWAPS_UNAVAILABLE'
  | 'TRAILS_ABORTED'
  | 'TRAILS_ERROR'
  | 'TRAILS_TIMEOUT'
  | 'TRAILS_UNAVAILABLE'
  | 'UNSUPPORTED_BATCH'
  | 'UNSUPPORTED_CHAIN'
  | 'UNSUPPORTED_NETWORK'
  | 'UNSUPPORTED_PROTOCOL'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_REDIRECT'
  | 'WALLET_BUSY'
  | 'WALLET_DISABLED'
  | 'WALLET_MISMATCH'
  | 'WALLET_NOT_INITIALIZED'
  | 'WALLET_PENDING';

/** Structured SDK error exposing a safe code, message, and HTTP-oriented status. */
export class WalletError extends Error {
  constructor(
    public readonly code: WalletErrorCode,
    message: string,
    public readonly status = 400
  ) {
    super(message);
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
