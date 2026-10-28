---
'@polygonlabs/oms-wallet': patch
---

Signed wallet API requests no longer hang, and execute failures say more precisely whether anything was submitted.

- Requests signed with the session credential, including the session expiry read, fail with `OMS_REQUEST_FAILED` after 30 seconds without a response. The deadline counts the wait for other session requests and the signing, and a request whose signer finishes after it is never sent. Previously one request that never completed could block every later wallet call.
- An execute request the SDK never sent, because signing failed or the deadline passed first, fails with `OMS_REQUEST_FAILED` and no `txnId` instead of `OMS_TRANSACTION_EXECUTION_UNCONFIRMED`. An execute that was sent before it timed out stays unconfirmed.
- A Tron execute refused while the wallet API prices it again (`InvalidRequest` 7200 or `InvalidFeeOption` 7310) fails with `OMS_REQUEST_FAILED` and no `txnId`: nothing was broadcast.
- After the wallet API answers the expiry read with `WebrpcBadRoute`, the SDK asks again 15 minutes later instead of never.
