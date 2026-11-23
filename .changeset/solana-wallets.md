---
'@polygonlabs/oms-server-wallet-sdk': minor
---

Add Solana wallets as `wallet.solana`: sponsored SOL, SPL and Token-2022 transfers (`prepareTransfer`, `executeTransfer`, `sendTransfer`), verified off-chain message signing, and `IndexerClient.getSolanaBalances`. Solana quotes last about a minute; an expired quote fails with `TRANSACTION_EXPIRED` and an operation whose Execute was already called stays `unknown` until WaaS shows its claim or, two minutes past expiry, still reports it unclaimed.
