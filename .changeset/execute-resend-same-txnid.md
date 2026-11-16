---
'@polygonlabs/oms-wallet': patch
---

When an Execute request fails after it was sent, the SDK now sends Execute again with the same `txnId` up to three times (after 1, 2 and 4 seconds) before it reports `OMS_TRANSACTION_EXECUTION_UNCONFIRMED`. The wallet API executes a `txnId` at most once, so a resend cannot submit the transaction twice. A resend answered with `TransactionExpired` (`'7309'`) is treated as already submitted and its status is polled. A resend refused as reverting (`'7314'`) stops the resends and is reported as `OMS_TRANSACTION_EXECUTION_UNCONFIRMED`, since an earlier send may still land. An Execute refused before submission, or a first Execute answered with `'7309'` or `'7314'`, fails as before.
