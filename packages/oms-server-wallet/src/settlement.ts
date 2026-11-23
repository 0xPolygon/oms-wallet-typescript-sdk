import { UpstreamError } from './errors.js';
import { WaasErrorCode } from './internal/protocol/waasErrors.js';

/**
 * How EVM, Solana and Tron operations settle after Execute and while polling. WaaS v1.2.0 claims a
 * quoted transaction (quoted → pending) in one conditional write before it broadcasts anything, so
 * an error it returns before that write proves the request sent nothing.
 */

/**
 * WaaS answers this both for an expired quote and for a transaction another Execute already
 * claimed, so it never proves on its own that nothing was sent.
 */
export const TRANSACTION_EXPIRED = WaasErrorCode.TransactionExpired;
/**
 * Execute refusals WaaS v1.2.0 returns only before it claims the transaction, for EVM (relayer
 * mode), Solana and Tron alike, so the request sent nothing. Any other error, such as a failed
 * broadcast, can follow the claim.
 */
export const PRE_CLAIM_REFUSALS: ReadonlySet<number> = new Set([
  WaasErrorCode.DataIntegrityError,
  WaasErrorCode.InvalidRequest,
  WaasErrorCode.Unauthorized,
  WaasErrorCode.UnsupportedNetwork,
  WaasErrorCode.UnsupportedTransactionMode,
  WaasErrorCode.TransactionFailed,
  WaasErrorCode.WalletProviderError,
  WaasErrorCode.TransactionNotFound,
  WaasErrorCode.InvalidFeeOption
]);
const FEE_REFUSED = WaasErrorCode.InvalidFeeOption;
/**
 * How long after a quote's expiry an unconfirmed submission can still be claimed by an Execute
 * that started in time; until then an expired quote does not prove nothing was sent.
 */
export const CLAIM_GRACE_MS = 120_000;

export interface TransactionStatus {
  status: 'quoted' | 'pending' | 'executed' | 'failed';
  txnHash?: string;
}

/** The fields settlement reads and writes on an EVM, Solana or Tron operation. */
export interface Settleable {
  status: string;
  error?: string;
  txnHash?: string;
  quote?: { expiresAt: string };
}

/**
 * Settle a failed Execute. A refusal WaaS returns only before claiming means this request sent
 * nothing, and it is the only Execute for the operation. Anything else stays unknown unless the
 * status shows the claim: WaaS reads transaction status without strong consistency, so a
 * `quoted` or expired answer just after the request may predate the claim.
 */
export async function settleExecuteError(
  op: Settleable,
  error: unknown,
  status: () => Promise<TransactionStatus>
): Promise<void> {
  if (error instanceof UpstreamError && PRE_CLAIM_REFUSALS.has(error.upstreamCode)) {
    op.status = 'failed';
    op.error = error.upstreamCode === FEE_REFUSED ? 'FEE_ABOVE_QUOTE' : 'EXECUTE_REFUSED';
    return;
  }
  op.status = 'unknown';
  op.error = 'SUBMISSION_UNCERTAIN';
  if (!(error instanceof UpstreamError)) return;
  try {
    const result = await status();
    if (result.status === 'quoted') return;
    op.status = result.status;
    op.error = undefined;
    if (result.txnHash) op.txnHash = result.txnHash;
  } catch {
    // Still unknown; polling the operation settles it later.
  }
}

/**
 * Poll an operation in flight. An ambiguous Execute is never retried, even when status still says
 * quoted. TransactionStatus answers TransactionExpired only while the row still reads as quoted;
 * past the grace period no Execute that started in time can still claim it, and every claim has
 * long since reached the replica WaaS reads from, so the operation is expired.
 */
export async function refreshStatus(
  op: Settleable,
  status: () => Promise<TransactionStatus>,
  now: number = Date.now()
): Promise<void> {
  let result: TransactionStatus;
  try {
    result = await status();
  } catch (error) {
    if (
      !(error instanceof UpstreamError) ||
      error.upstreamCode !== TRANSACTION_EXPIRED ||
      !op.quote ||
      now < Date.parse(op.quote.expiresAt) + CLAIM_GRACE_MS
    )
      throw error;
    op.status = 'expired';
    op.error = 'TRANSACTION_EXPIRED';
    return;
  }
  if (result.status === 'quoted') op.status = 'unknown';
  else {
    op.status = result.status;
    op.error = undefined;
  }
  if (result.txnHash) op.txnHash = result.txnHash;
}
