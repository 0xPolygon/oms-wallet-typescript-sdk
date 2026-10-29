---
'@polygonlabs/oms-wallet': patch
---

Concurrent wallet requests no longer fail when the wallet API rejects one for an out-of-order nonce.

When the wallet API rejects a signed request's nonce (WaaS `PreconditionFailed`, 7206), the SDK signs the request again with a fresh nonce and resends it, up to 2 times. The wallet API rejects the nonce before running the method, so this also applies to transaction writes. If the last attempt is still rejected, the error surfaces as a request error (`OMS_REQUEST_FAILED`, status 412); a transaction's `Execute` reports it the same way instead of as `OMS_TRANSACTION_EXECUTION_UNCONFIRMED`, because the transaction was never submitted.
