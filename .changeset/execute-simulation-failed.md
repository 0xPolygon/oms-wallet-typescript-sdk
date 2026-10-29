---
'@polygonlabs/oms-wallet': patch
---

A transaction the wallet API refuses because simulation shows it would revert now fails with `OMSWalletRequestError` (`OMS_REQUEST_FAILED`, status 400, `upstreamError.code` `'7314'`) instead of `OMS_TRANSACTION_EXECUTION_UNCONFIRMED`; it was never submitted. The same applies when the wallet API refuses the execute request before submitting anything: an invalid request signature (`'7201'`), an exceeded credential usage limit (`'7205'`), or `Unauthorized` (`'7207'`). Other execute failures are unchanged.
