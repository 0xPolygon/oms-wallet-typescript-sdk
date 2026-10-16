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

### Invalid Ethereum wallet addresses are rejected

A wallet returned by WaaS (auth, `listWallets`, `useWallet`, `createWallet`, import) whose Ethereum
address is not a valid hex address now fails with `OMSWalletResponseError` (`OMS_INVALID_RESPONSE`)
instead of being returned as a viem `Address`. Checksum casing is not enforced.

### Exhaustive wallet-type checks

`WalletType` gained `Tron` and `WalletAccount` gained `TronWalletAccount`. Exhaustive `switch`
statements over either need a `tron` case.

### Signature verification takes an address, not a wallet ID

`walletId` was removed from `IsValidMessageSignatureParams`, `IsValidTypedDataSignatureParams`,
`IsValidSolanaMessageSignatureParams`, `IsValidTronMessageSignatureParams`, and
`IsValidTronTypedDataSignatureParams`. Pass `walletAddress`, or omit it to verify against the active
wallet's address. Requests now always send `networkFamily` and `walletAddress` and never a wallet ID.

```typescript
// Before
await omsWallet.wallet.isValidMessageSignature({ walletId, message, signature })

// After
await omsWallet.wallet.isValidMessageSignature({ walletAddress, message, signature })
// or, for the active wallet
await omsWallet.wallet.isValidMessageSignature({ message, signature })
```

When `walletAddress` is omitted, the SDK now checks the active wallet locally before sending a
request. Without an active session it throws `OMSWalletSessionError` (`OMS_SESSION_MISSING`, or
`OMS_SESSION_EXPIRED` for an expired session) instead of a backend request error. If the
active wallet belongs to another family, for example `isValidSolanaMessageSignature` with an active
Ethereum wallet, it throws `OMSWalletValidationError` instead of a backend error. Passing
`walletAddress` still works while signed out. As with other wallet operations, an expired session
found this way is cleared and your `onSessionExpired` listeners are called.

An empty or whitespace-only `walletAddress` now throws `OMSWalletValidationError`
(`walletAddress must not be empty`) before any request. Previously `""` silently fell back to the
active wallet's address. Omit `walletAddress` to verify against the active wallet.

### `walletType` replaces `type` for wallet creation and encrypted import

`createWallet` and `ImportEncryptedWalletParams` take `walletType`, matching the auth methods.
`ImportWalletParams` keeps its `type` discriminant.

```typescript
// Before
await omsWallet.wallet.createWallet({ type: WalletType.Tron })
await omsWallet.wallet.importEncryptedWallet({ type: WalletType.Solana, keyMaterial })

// After
await omsWallet.wallet.createWallet({ walletType: WalletType.Tron })
await omsWallet.wallet.importEncryptedWallet({ walletType: WalletType.Solana, keyMaterial })
```

TypeScript rejects `type` in an object literal. Untyped JavaScript that still passes
`createWallet({ type })` silently creates an Ethereum wallet, the default, so search for these calls.
`importEncryptedWallet({ type })` from untyped JavaScript sends no wallet type and is rejected:
during a pending manual wallet selection with a local `OMSWalletValidationError` before any request,
otherwise by the wallet API with an `UnsupportedWalletType` request error.

### Fee token fields use `logoUrl` and `tokenId`

`FeeToken` (now exported) renamed `logoURL` to `logoUrl` and `tokenID` to `tokenId`. Fee options
passed to `selectFeeOption` and returned by `RemoteAccessClient.prepareTransaction` no longer carry
the old keys at runtime.

```typescript
// Before
const icon = option.feeOption.token.logoURL

// After
const icon = option.feeOption.token.logoUrl
```

### `upstreamError.code` is a string

`OMSWalletUpstreamError.code` is now `string | undefined`. Numeric WebRPC codes are stringified, so
code that compares or switches on numbers must compare strings.

```typescript
// Before
if (error.upstreamError?.code === 7313) {}

// After
if (error.upstreamError?.code === '7313') {}
```

TypeScript flags direct `===` comparisons with a number, but not `switch` cases, `Number(...)`
conversions, or serialized logs, which now see a string.

### `callContract` rejects full function signatures

`callContract` (and the new `callTronContract`) now throws `OMSWalletValidationError`
(`OMS_VALIDATION_ERROR`) before any request when `method` is not a bare function name, for example
`'transfer(address,uint256)'`. Pass `'transfer'`; the wallet service builds the signature from the
`args` types. Previously the request reached WaaS and failed with a request error.

### `AuthMode` lists only OIDC redirect modes

`AuthMode.OTP` and `AuthMode.IDToken` were removed; no SDK parameter accepted them. `AuthMode` now
contains `AuthCode` and `AuthCodePKCE`, the same values as `OidcAuthMode`.

### Client interfaces renamed

`OMSWalletClient` is now `WalletClient` and `OMSWalletIndexerClient` is now `IndexerClient`. They
remain the types of `omsWallet.wallet` and `omsWallet.indexer`.

```typescript
// Before
import type { OMSWalletClient, OMSWalletIndexerClient } from '@polygonlabs/oms-wallet'

// After
import type { WalletClient, IndexerClient } from '@polygonlabs/oms-wallet'
```

### Stricter indexer and redirect-state parsing

Indexer responses are read only with the gateway's field names (`balance`, `tokenIds` on transfers,
`tokenId` on token metadata and metadata assets). Test doubles that still return the old alternate
spellings now fail with `OMS_INVALID_RESPONSE`. A pending OIDC redirect record without a valid
`walletType` is rejected with `Pending OIDC redirect auth is invalid` instead of continuing with an
Ethereum wallet.

### Access pages include paging metadata

`AccessGrantPage` gained an optional `page` (`limit`, `cursor`), so pages yielded by
`listAccessPages` now include it when WaaS returns paging data. Use the new `listAccessPage` to read
one page and resume from `page.cursor`. Update deep-equality assertions on yielded pages.

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
