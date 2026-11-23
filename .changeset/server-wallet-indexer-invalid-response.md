---
'@polygonlabs/oms-server-wallet-sdk': patch
---

`IndexerClient.getBalances` reports malformed balance responses as `WalletError('INVALID_RESPONSE')` instead of a raw `SyntaxError` or `ZodError`.
