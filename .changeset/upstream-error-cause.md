---
'@polygonlabs/oms-wallet': minor
---

`upstreamError` has a new `cause` field with the reason the wallet API or an indexer gave for an error, when it gives one. For example, a Tron send from a wallet that has never received TRX now carries `'wallet is not activated on chain: it must receive TRX or a token before it can send'` behind the generic message `'The request was invalid'`.
