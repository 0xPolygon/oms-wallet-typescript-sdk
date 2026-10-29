---
"@polygonlabs/oms-wallet": minor
---

Sign-in can now claim wallets that a project preallocated for the user's verified email.

### Claimable wallets

- **Automatic wallet selection** uses an owned wallet of the requested type first, then claims a
  claimable wallet of that type, and only then creates a new one. A rejected claim fails the sign-in.
- Completed sign-in results gain **`claimableWallets`**: the wallets the user can still claim, of
  every type, excluding one claimed during the sign-in.
- **`PendingWalletSelection`** gains `claimableWallets` (of the requested type) and
  `claimAndSelectWallet({ walletId })`.
- **`omsWallet.wallet.claimWallet({ walletId })`** claims a wallet from an active session and makes
  it the active wallet. A rejected claim fails with `OMS_REQUEST_FAILED` and the WaaS
  `AccountNotFound` error as `upstreamError`.
