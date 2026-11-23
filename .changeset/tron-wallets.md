---
'@polygonlabs/oms-server-wallet-sdk': minor
---

Add Tron wallets as `wallet.tron`: TRX transfers, raw and ABI contract calls, verified TIP-191 and TIP-712 signing, and `IndexerClient.getTronBalances`. Transactions are sent only when the wallet's delegated resources cover them, unless the caller sets `maxFee` in sun to let the wallet pay a quoted TRX fee up to that amount. Both limits apply to the quote and WaaS's execution-time re-check; on chain a contract call is bounded only by the fee limit WaaS seals into it.
