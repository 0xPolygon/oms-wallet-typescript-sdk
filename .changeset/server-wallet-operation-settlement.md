---
'@polygonlabs/oms-server-wallet-sdk': minor
---

Tighten transaction settlement, open-operation indexing, and swap debit coordination across EVM, Solana, and Tron.

- **Refused executions:** an Execute that WaaS refuses before claiming the transaction (including credential middleware refusals such as invalid signature, usage limit, or nonce replay) is recorded as `failed` (`EXECUTE_REFUSED` or `FEE_ABOVE_QUOTE`, `provenUnsent: true`) instead of staying `unknown`.
- **Pre-submit expiry vs. ambiguous submissions:** a quote that expires locally before submission becomes terminal `expired` (`QUOTE_EXPIRED`, `provenUnsent: true`) and releases swap debit reservations. An ambiguous Execute that WaaS still reports expired past the two-minute grace window stays open (`unknown`, `RECONCILIATION_REQUIRED`) and retains debit reservations until reconciled; operators can explicitly resolve verified non-broadcasts via `resolveReconciliation({ idempotencyKey, txnId, resolution: 'not-broadcast' })` (or `wallet.swaps.resolveReconciliation(...)`).
- **Known claims are kept:** once WaaS has shown a transaction claimed (`pending`, or a transaction hash), a later stale status read (`quoted`, or `TransactionExpired`) never regresses the operation back to `unknown` or `expired`.
- **Signatures:** `signMessage` and `signTypedData` record a failed or unverified signature as `failed` with its error code; retrying under the same ID returns that record without signing again.
- **Interrupted preparations:** an operation whose preparation was interrupted before its quote was stored is quoted again under the same ID and matching submission mode instead of staying stuck in `preparing`.
- **Open operation index:** `listOperations({ status: 'open' })` reads unsettled operations from a maintained open index without scanning settled history.
