---
'@polygonlabs/oms-wallet-wagmi-connector': minor
---

The connector now reads the SDK's `wallet.activeWallet` and checks the wallet type instead of the address shape. Use it with `@polygonlabs/oms-wallet` 0.4.0. Connecting with an active Tron wallet rejects with `OMSWalletProviderRpcError` code `4100`, the same as an active Solana wallet.
