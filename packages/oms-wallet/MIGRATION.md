# Migration Guide

This document records breaking changes and the steps to migrate between published
versions of `@polygonlabs/oms-wallet`.

## 0.4.0

### Active wallet replaces `walletAddress`

`omsWallet.wallet.walletAddress` was removed. Read the active wallet from
`omsWallet.wallet.activeWallet`, which is a `WalletAccount` (`id`, `type`, `address`, `reference`,
`keyOrigin`) or `undefined` when signed out. Narrowing on `type` gives Ethereum wallets a viem
`Address`, so the `listWallets()` lookup from 0.3.0 is no longer needed:

```typescript
import { WalletType } from '@polygonlabs/oms-wallet'

// Before
const address = omsWallet.wallet.walletAddress

// After
const activeWallet = omsWallet.wallet.activeWallet
if (activeWallet?.type === WalletType.Ethereum) {
  const ethereumAddress = activeWallet.address // viem Address
}
```

The `walletAddress` field was also removed from `WalletActivationResult` and the auth results
(`CompleteEmailAuthResult`, `CompleteOidcIdTokenAuthResult`, `CompleteOidcRedirectAuthResult`). Use
`result.wallet.address`.

### `session` is `undefined` when signed out

`OMSWalletSessionState` was renamed to `OMSWalletSession`, and `omsWallet.wallet.session` is now
`OMSWalletSession | undefined`. Previously it returned an object whose fields were all `undefined`.
The `walletAddress` field was removed, and `expiresAt` and `auth` are now always defined. `session`
is defined exactly when `activeWallet` is.

```typescript
// Before
const email = omsWallet.wallet.session.auth?.email

// After
const email = omsWallet.wallet.session?.auth.email
```

`OMSWalletSessionExpiredEvent` gained `wallet: WalletAccount | undefined`, and its `session` no
longer carries `walletAddress`. `wallet` is `undefined` when the credential expired while a manual
wallet selection was still pending.

### One-time sign-in after upgrading

Saved sessions now record the wallet's type. Sessions saved by 0.3.x do not, so 0.4.0 discards them
on load and users sign in once after upgrading.

### Exhaustive wallet-type checks

`WalletType` gained `Tron` and `WalletAccount` gained `TronWalletAccount`. Exhaustive `switch`
statements over either need a `tron` case.

### Wagmi connector

`@polygonlabs/oms-wallet-wagmi-connector` now reads `wallet.activeWallet` instead of
`wallet.walletAddress`. Upgrade both packages together; they are released with the same version.

## 0.3.0

### Wallet addresses and provenance

`walletAddress` and `WalletAccount.address` widened from viem's Ethereum `Address` type to `string`
because wallet results can now contain Ethereum or Solana accounts. Existing Ethereum code must
narrow `wallet.type` before passing an address to viem or another Ethereum-only API:

```typescript
import { WalletType } from '@polygonlabs/oms-wallet'

const wallet = await omsWallet.wallet.createWallet()

if (wallet.wallet.type === WalletType.Ethereum) {
  const ethereumAddress = wallet.wallet.address
  // Pass `ethereumAddress` to viem or another Ethereum-only API here.
}
```

Every `WalletAccount` now has a required `keyOrigin` field. Wallets returned by the SDK already
include it. Tests, mocks, or adapters that construct `WalletAccount` values directly must set it to
`WalletKeyOrigin.Enclave` or `WalletKeyOrigin.Imported`.

### Access grants and revocation

`AccessGrant` changed from an alias of `WalletCredential` to a discriminated union of
`DirectAccessGrant` and `RemoteAccessGrant`. Code that constructs access-grant fixtures must now set
`type`. Narrow on `grant.type` before reading the remote session ID, metadata, or grants:

```typescript
for (const grant of await omsWallet.wallet.listAccess()) {
  if (grant.type === 'remote') {
    // Use these fields to display the remote app/session and its authorized permissions.
    console.log(grant.sessionId, grant.metadata, grant.grants)
  }
}
```

The public `revokeAccess` parameter was renamed from `targetCredentialId` to `credentialId`. Pass an
optional `sessionId` to revoke only one remote session for that credential:

```typescript
// 0.2.0
await omsWallet.wallet.revokeAccess({ targetCredentialId: credentialId })

// 0.3.0
await omsWallet.wallet.revokeAccess({ credentialId })
await omsWallet.wallet.revokeAccess({ credentialId, sessionId })
```

### Sponsored fee selectors

When `selectFeeOption` is provided, sponsored transactions now invoke it with an empty array before
execution. Treat the empty array as the sponsored case and return `undefined` to continue, or throw
to stop execution. `FeeOptionSelector.firstAvailable` already handles both sponsored and
non-sponsored transactions.

```typescript
import { FeeOptionSelector, Networks } from '@polygonlabs/oms-wallet'

await omsWallet.wallet.sendTransaction({
  network: Networks.amoy,
  to: '0x1111111111111111111111111111111111111111',
  value: 1n,
  selectFeeOption: FeeOptionSelector.firstAvailable,
})
```
