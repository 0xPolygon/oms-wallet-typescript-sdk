---
'@polygonlabs/oms-wallet': patch
---

A transaction the wallet API refuses because simulation shows it would revert now fails with `OMSWalletRequestError` (`OMS_REQUEST_FAILED`, status 400, `upstreamError.code` `'7314'`) instead of `OMS_TRANSACTION_EXECUTION_UNCONFIRMED`; it was never submitted. Other execute failures are unchanged.
