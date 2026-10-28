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

Saved sessions now record the wallet's type and are stored under project-scoped keys (see "Stored
sessions are kept per project and environment" below). 0.4.0 does not restore sessions saved by
0.3.x, so users sign in once after upgrading. The 0.3.x records are left in storage unread.

### Session expiry extends with use

`session.expiresAt` is now the current expiry rather than a fixed end time. The wallet API extends
it with use, up to the lifetime requested at sign-in, and the SDK refreshes it after restoring a
session, when the local expiry is reached, and after wallet activity. Do not treat `expiresAt` as
final; listen to `onSessionExpired` instead. `credential.expiresAt` in auth results is the expiry at
sign-in and is not updated.

- A session active in memory whose local expiry has passed is checked with the wallet API before it
  is ended, so a protected operation can succeed on it. If the wallet API cannot be reached, the
  session is kept and the operation fails with the request error (for example `OMS_REQUEST_FAILED`)
  instead of `OMS_SESSION_EXPIRED`. A stored session whose local expiry has passed is discarded on
  load without asking the wallet API.
- An idle session ends about 10 days after its last use. Reading the expiry also counts as use, so
  after the local expiry the SDK waits until the session would have ended on the wallet API before
  reading it. While the app makes no wallet calls, `onSessionExpired` can fire up to about 6 hours
  after the session ended, because the wallet API extends the expiry only in steps of at least 6 hours (within 5 minutes when the lifetime
  is shorter than the idle window), assuming an accurate device clock and a page in the foreground.
  When the expiry read after restoring a session cannot reach the wallet API and no wallet call
  follows, it can fire up to about one idle window (10 days) late.
- When the wallet API rejects the session credential as not found or expired (WaaS `KeyNotFound`
  7202 or `KeyExpired` 7203), the session ends like a local expiry and the operation fails with
  `OMSWalletSessionError` (`OMS_SESSION_EXPIRED`), with the same shape as a local expiry: the WaaS
  error is its `cause`, and it has no `upstreamError`. This includes a rejected transaction execute,
  which never ran. A status lookup that fails after a transaction was submitted keeps
  `OMS_TRANSACTION_STATUS_LOOKUP_FAILED` and its `txnId`. The session also ends this way when the
  SDK's expiry check reports the credential revoked (WaaS `Unauthorized` 7207); `Unauthorized` from
  other requests is a request error and keeps the session.
- `MAX_SESSION_LIFETIME_SECONDS` is 180 days (`15552000`); previously lifetimes above 30 days were
  rejected.
- When `sessionLifetimeSeconds` is omitted, auth now requests 180 days (`DEFAULT_SESSION_LIFETIME_SECONDS`,
  the maximum) instead of one week. A session still ends after 10 days without use; pass a shorter
  `sessionLifetimeSeconds` if you need a hard limit. On wallet API versions without sliding expiry,
  the requested lifetime is clamped to the server maximum (30 days) and there is no idle timeout, so
  the default gives a fixed 30-day session there.

### Transactions refused before submission fail as request errors

When the wallet API refuses to submit a transaction because simulation shows it would revert (WaaS
`TransactionSimulationFailed`, 7314), the write now fails with `OMSWalletRequestError`
(`OMS_REQUEST_FAILED`, status 400, `upstreamError.code` `'7314'`) instead of
`OMS_TRANSACTION_EXECUTION_UNCONFIRMED`. The transaction was closed as failed and never submitted, so
there is no `txnId` to check. The same applies when the wallet API refuses the execute request
before submitting anything: an invalid request signature (`'7201'`, status 400), an exceeded
credential usage limit (`'7205'`, status 429), a nonce still rejected after the SDK's resends
(`'7206'`, status 412), or `Unauthorized` (`'7207'`, status 401). A Tron execute refused while the
wallet API prices it again (`'7200'` `InvalidRequest` or `'7310'` `InvalidFeeOption`, status 400)
and an execute request the SDK never sent (signing failed, or the 30-second request deadline passed
before it was sent) fail the same way. Other execute failures keep
`OMS_TRANSACTION_EXECUTION_UNCONFIRMED`.

### Signed requests time out after 30 seconds

Requests signed with the session credential, including the expiry read, and requests of a
`RemoteAccessClient` now fail with
`OMS_REQUEST_FAILED` (`retryable: true`) when they do not complete within 30 seconds, counted from
the start, including the wait for other session requests, the signing and reading the whole
response. The call returns by then even if the signer has not finished; a signature that finishes
later is never sent. Previously a request that
never completed could block every later wallet call. An execute request that was already sent when it
timed out keeps `OMS_TRANSACTION_EXECUTION_UNCONFIRMED`.

### Invalid Ethereum wallet addresses are rejected

A wallet returned by WaaS (auth, `listWallets`, `useWallet`, `createWallet`, import) whose Ethereum
address is not a valid hex address now fails with `OMSWalletResponseError` (`OMS_INVALID_RESPONSE`)
instead of being returned as a viem `Address`. Checksum casing is not enforced.

### Exhaustive wallet-type checks

`WalletType` gained `Tron` and `WalletAccount` gained `TronWalletAccount`. Exhaustive `switch`
statements over either need a `tron` case. `ImportWalletParams` gained a `type: 'tron'` variant, so
code that matches on it needs the same case. `WalletClient` gained `signTronMessage`,
`signTronTypedData`, `isValidTronMessageSignature`, `isValidTronTypedDataSignature`,
`sendTronTransaction`, `callTronContract` and `listAccessPage`, and `IndexerClient` gained
`getTronBalances`, so objects that implement these interfaces (for example typed test doubles) need
them.

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
`walletAddress` still works while signed out. As with other wallet operations, a locally expired
session found this way is first refreshed with the wallet API; if it has ended, it is cleared and
your `onSessionExpired` listeners are called.

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

### Claimable wallets

Automatic wallet selection now claims a preallocated wallet: when the user owns no wallet of the
requested type but one is claimable, sign-in claims and activates it instead of creating a wallet.
A rejected claim fails the sign-in. See the README's claimable wallets section.

`CompleteEmailAuthResult`, `CompleteOidcIdTokenAuthResult` and `CompleteOidcRedirectAuthResult`
gained `claimableWallets`, `PendingWalletSelection` gained `claimableWallets` and
`claimAndSelectWallet`, and `WalletClient` gained `claimWallet`, so objects that implement these
interfaces (for example typed test doubles) need them. Update deep-equality assertions on sign-in
results.

### Instances of one project share one wallet

Creating `OMSWallet` again for the same project and environment, with the default browser storage and
signer or the same `storage`, `credentialSigner` and `redirectAuthStorage` objects, now returns the
same wallet instead of a separate copy of the session. Signing out, switching wallets and session
expiry through one instance apply to the other. A rotated publishable key of the same project keeps
the session. Node defaults, and instances with different storage objects, stay separate sessions.
Passing one `storage` object with a different `credentialSigner` or `redirectAuthStorage` now throws
`OMSWalletValidationError`. Outside a browser the default signer keeps its key in memory, so two
instances sharing one `storage` must also share one `credentialSigner`.

### Stored sessions are kept per project and environment

The session, its signing key, redirect state and activity record are stored under keys that name the
project and wallet API origin, so several projects or environments on one origin no longer replace
each other's session. 0.4.0 does not restore 0.3.x sessions anyway (see above), so there is nothing
to migrate; the unscoped 0.3.x records are left in storage unread.

### Signed requests go one at a time

Requests signed with one credential, including the session expiry read, are sent one at a time, in
order, by every client in the process and across tabs where the browser supports Web Locks.
Concurrent calls from this app no longer fail with a stale nonce (`PreconditionFailed`, 7206), but a
burst of calls takes longer: each waits for the one before it, within its 30-second deadline.
Requests signed elsewhere with the same credential (another process or device, or an older SDK
version) can still interleave, so the SDK keeps resending a rejected nonce.

### Wagmi connector

`@polygonlabs/oms-wallet-wagmi-connector` now reads `wallet.activeWallet` instead of
`wallet.walletAddress`. Upgrade both packages together; they are released with the same version.
Custom `OMSWalletLike` implementations need `activeWallet` and `onSessionExpired`; see the
connector's `MIGRATION.md`.
It now observes session expiry from `connect` on, so a wagmi config that never connects leaves no
listener on the wallet.

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
