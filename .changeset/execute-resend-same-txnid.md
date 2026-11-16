---
'@polygonlabs/oms-wallet': patch
---

When an Execute request fails after it was sent, the SDK now sends Execute again with the same `txnId` up to three times (after 1, 2 and 4 seconds) before it reports `OMS_TRANSACTION_EXECUTION_UNCONFIRMED`. The wallet API executes a `txnId` at most once, so a resend cannot submit the transaction twice. Resends stop when the session that sent the first request ends, and when WaaS refuses a resend (including `'7309'` and `'7314'`); the write is then reported as `OMS_TRANSACTION_EXECUTION_UNCONFIRMED` with the `txnId` and that `upstreamError`, because the earlier send may still land. A first Execute refused before submission, or answered with `'7309'`, fails as before.
