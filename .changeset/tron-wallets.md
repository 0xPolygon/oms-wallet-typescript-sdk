---
'@polygonlabs/oms-server-wallet-sdk': minor
---

Add Tron wallets as `wallet.tron`: TRX and TRC-20 transfers (`prepareTransfer`), ABI and calldata contract calls (`prepareCall`), verified TIP-191 and TIP-712 signing, and `IndexerClient.getTronBalances`. Transactions are sent only when the wallet's delegated resources cover them, unless the caller sets `maxQuotedFee` in sun to let the wallet pay a quoted TRX fee up to that amount. The bound applies to the quote and WaaS's execution-time re-check, not to energy burned on chain.
