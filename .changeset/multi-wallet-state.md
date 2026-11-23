---
'@polygonlabs/oms-server-wallet-sdk': minor
---

Keep one wallet per network family (`evm`, `solana`, `tron`) and add `createOrRestore({ families })`. `WalletSnapshot.wallets` lists them; `WalletSnapshot.wallet` is still the EVM wallet, and EVM methods are unchanged. Wallet state from 0.2.x is migrated on first load, and state in neither format fails with `INVALID_STATE`. Wallet responses are read with the WaaS v1.2.0 shapes, including fee options.
