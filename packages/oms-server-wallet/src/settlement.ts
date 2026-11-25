import type { WalletErrorCode } from './errors.js';

import { UpstreamError, WalletError } from './errors.js';
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
const TRANSACTION_NOT_FOUND = WaasErrorCode.TransactionNotFound;

/** A status read that says WaaS has no live transaction: expired, or not found. */
function isAbsenceRead(error: unknown): error is UpstreamError {
  return (
    error instanceof UpstreamError &&
    (error.upstreamCode === TRANSACTION_EXPIRED || error.upstreamCode === TRANSACTION_NOT_FOUND)
  );
}

/**
 * Execute refusals WaaS v1.2.0 returns only before it claims the transaction, for EVM (relayer
 * mode), Solana and Tron alike, so the request sent nothing. Any other error, such as a failed
 * broadcast, can follow the claim.
 */
export const PRE_CLAIM_REFUSALS: ReadonlySet<number> = new Set([
  WaasErrorCode.InvalidSignature,
  WaasErrorCode.KeyNotFound,
  WaasErrorCode.KeyExpired,
  WaasErrorCode.UsageLimitExceeded,
  WaasErrorCode.PreconditionFailed,
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
 * Grace window after quote expiry before an unconfirmed submission still returning
 * `TransactionExpired` escalates to `RECONCILIATION_REQUIRED` (remaining open, never silently
 * releasing debit reservations or claiming proof that nothing was broadcast).
 */
export const CLAIM_GRACE_MS = 120_000;

export interface TransactionStatus {
  status: 'quoted' | 'pending' | 'executed' | 'failed';
  txnHash?: string;
}

/** The fields settlement reads and writes on an EVM, Solana or Tron operation. */
export interface Settleable {
  status: string;
  error?: WalletErrorCode;
  txnHash?: string;
  quote?: { expiresAt: string };
  preClaimRefused?: boolean;
}

/**
 * Settle a failed Execute. A refusal WaaS returns only before claiming means this request sent
 * nothing, and it is the only Execute for the operation. Anything else stays `unknown` unless the
 * status shows the claim: WaaS reads transaction status without strong consistency, so a `quoted`
 * or expired answer just after the request may predate the claim.
 */
export async function settleExecuteError(
  op: Settleable,
  error: unknown,
  status: () => Promise<TransactionStatus>
): Promise<void> {
  if (error instanceof UpstreamError && PRE_CLAIM_REFUSALS.has(error.upstreamCode)) {
    op.status = 'failed';
    op.error = error.upstreamCode === FEE_REFUSED ? 'FEE_ABOVE_QUOTE' : 'EXECUTE_REFUSED';
    op.preClaimRefused = true;
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
 * Whether a status refresh failed only because WaaS answered `TransactionExpired` inside the
 * post-expiry grace window. That read can predate the claim, so the operation stays as stored and
 * callers poll again later.
 */
export function isStaleExpiryRead(error: unknown): boolean {
  return error instanceof UpstreamError && error.upstreamCode === TRANSACTION_EXPIRED;
}

/** Whether WaaS has already shown that it claimed (or executed) the transaction. */
function claimed(op: Settleable): boolean {
  return op.status === 'pending' || op.status === 'executed' || !!op.txnHash;
}

/**
 * Poll an operation in flight. Evidence only moves forward: WaaS reads transaction status without
 * strong consistency, so a later read can still show the row from before the claim (`quoted`,
 * `TransactionExpired` or `TransactionNotFound`). A claimed operation keeps its claim, and an
 * `executed` one stays executed; a refresh can only fill in its missing hash. An ambiguous Execute
 * is never retried. For an unclaimed operation, an absence read inside the post-expiry grace
 * window leaves it unchanged so callers keep polling; past the window it escalates the still-open
 * operation to `RECONCILIATION_REQUIRED` rather than marking it `expired` or releasing debit
 * reservations. `TransactionNotFound` before the quote expired is not explained by expiry and is
 * rethrown.
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
    if (!isAbsenceRead(error)) throw error;
    if (claimed(op)) return;
    if (!op.quote) throw error;
    const expiry = Date.parse(op.quote.expiresAt);
    if (error.upstreamCode === TRANSACTION_NOT_FOUND && now < expiry) throw error;
    if (now < expiry + CLAIM_GRACE_MS) return;
    // Heuristic grace elapsed without authoritative proof nothing was broadcast: keep open.
    op.status = 'unknown';
    op.error = 'RECONCILIATION_REQUIRED';
    return;
  }
  if (op.status === 'executed') {
    if (result.status === 'executed' && result.txnHash && !op.txnHash) op.txnHash = result.txnHash;
    return;
  }
  if (result.status === 'quoted') {
    if (!claimed(op)) op.status = 'unknown';
  } else {
    op.status = result.status;
    op.error = undefined;
  }
  if (result.txnHash) op.txnHash = result.txnHash;
}

/**
 * Settle an operator's report that an unconfirmed submission was not broadcast. Only an open
 * `RECONCILIATION_REQUIRED` operation with no transaction hash qualifies, and WaaS is asked again
 * first: a claimed status settles the operation from that evidence instead. It is marked `expired`
 * with `operatorResolved` only when WaaS still answers `TransactionExpired` or `TransactionNotFound`
 * past the grace window.
 * The caller persists the operation; every refusal throws without changing it.
 */
export async function resolveNotBroadcast(
  op: Settleable & { quote?: { txnId: string; expiresAt: string }; operatorResolved?: boolean },
  txnId: string,
  status: () => Promise<TransactionStatus>,
  now: () => number
): Promise<void> {
  if (op.status !== 'unknown' || op.error !== 'RECONCILIATION_REQUIRED' || !op.quote)
    throw new WalletError(
      'INVALID_STATE',
      'Only operations in unknown / RECONCILIATION_REQUIRED can be resolved.',
      409
    );
  if (op.quote.txnId !== txnId)
    throw new WalletError(
      'STALE_REVIEW',
      'Provided txnId does not match the stored operation quote.',
      409
    );
  if (op.txnHash)
    throw new WalletError(
      'INVALID_STATE',
      'Cannot resolve an operation with an observed transaction hash as not-broadcast.',
      409
    );
  let result: TransactionStatus;
  try {
    result = await status();
  } catch (error) {
    if (!isAbsenceRead(error)) throw error;
    if (now() < Date.parse(op.quote.expiresAt) + CLAIM_GRACE_MS)
      throw new WalletError(
        'RECONCILIATION_REQUIRED',
        'Cannot resolve before the post-expiry grace window has elapsed.',
        409
      );
    op.status = 'expired';
    op.error = 'QUOTE_EXPIRED';
    op.operatorResolved = true;
    return;
  }
  if (result.status === 'quoted')
    throw new WalletError(
      'RECONCILIATION_REQUIRED',
      'WaaS still reports this transaction as quoted; cannot resolve as expired yet.',
      409
    );
  op.status = result.status;
  op.error = undefined;
  if (result.txnHash) op.txnHash = result.txnHash;
}
