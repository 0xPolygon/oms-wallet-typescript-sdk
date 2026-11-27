---
'@polygonlabs/oms-server-wallet-sdk': minor
---

Keep one wallet per network family (`evm`, `solana`, `tron`) and add `createOrRestore({ families })`. `WalletSnapshot.wallets` lists every held family. Stored state uses strict `version: 2` validation (unrecognized formats fail closed with `STORAGE_INTEGRITY`), and wallet responses follow WaaS v1.2.0 shapes including fee options.
