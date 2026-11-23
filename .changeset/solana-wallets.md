---
'@polygonlabs/oms-server-wallet-sdk': minor
---

Add Solana wallets as `wallet.solana`: sponsored SOL, SPL and Token-2022 transfers (`prepareTransfer`, `executeTransfer`, `sendTransfer`), verified off-chain message signing, and `IndexerClient.getSolanaBalances`. Solana quotes last about a minute; an expired quote fails with `TRANSACTION_EXPIRED` and the operation becomes `expired` only once WaaS proves nothing was broadcast.
