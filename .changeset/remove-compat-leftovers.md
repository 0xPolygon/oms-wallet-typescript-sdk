---
"@polygonlabs/oms-wallet": minor
"@polygonlabs/oms-wallet-wagmi-connector": minor
---

Indexer responses, pending OIDC redirects, and the wagmi connector's wallet type now accept only the current shapes.

- **`@polygonlabs/oms-wallet`:** indexer responses are read only with the indexer gateway's field names. A native balance without `balance`, or token metadata without `tokenId`, now fails with `OMS_INVALID_RESPONSE`.
- **`@polygonlabs/oms-wallet`:** `completeOidcRedirectAuth` rejects a pending redirect record with a missing or unknown `walletType` as `Pending OIDC redirect auth is invalid` instead of continuing with an Ethereum wallet.
- **`@polygonlabs/oms-wallet-wagmi-connector`:** `OMSWalletLike.wallet.onSessionExpired` is now required, so session expiry always disconnects wagmi. The SDK's `OMSWallet` already provides it.
