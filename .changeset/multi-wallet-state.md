---
'@polygonlabs/oms-server-wallet-sdk': minor
---

Keep one wallet per network family (`evm`, `solana`, `tron`) and add `createOrRestore({ families })`. `WalletSnapshot.wallets` lists every held family; `WalletSnapshot.wallet` is the EVM wallet. Stored state uses strict `version: 2` validation (unrecognized formats fail closed with `INVALID_STATE`), and wallet responses follow WaaS v1.2.0 shapes including fee options.
