# OMS Wallet TypeScript SDK

Build non-custodial EVM, Solana, and Tron wallet experiences in TypeScript with OMS Wallet: email and OIDC
auth, session restore, message signing, transaction submission, attested opt-in key import, smart
sessions, and token balance queries.

[API reference](https://docs.polygon.technology/wallets/sdk/typescript/api-reference)

**Requirements:** Node.js 22+ for Node runtimes and local builds. Browser apps
need a modern browser with WebCrypto support.

## Before You Start

- Use an OMS publishable key for your project. Use sandbox/dev keys for local development and testnet flows.
- Browser apps work out of the box. Node.js and other custom runtimes should provide custom storage when they need persistent sessions.
- Start with a sign-in, sign-message, or balance-read flow. Transaction examples below use Polygon Amoy; mainnet transactions can move real funds.

## Installation

Install the published SDK package in your application:

```bash
pnpm add @polygonlabs/oms-wallet
```

For npm or yarn projects:

```bash
npm install @polygonlabs/oms-wallet
yarn add @polygonlabs/oms-wallet
```

Then initialize OMS Wallet with your OMS publishable key:

```typescript
import { OMSWallet } from '@polygonlabs/oms-wallet'

const omsWallet = new OMSWallet({
  publishableKey: 'your-publishable-key',
})
```

The SDK derives the wallet API and indexer endpoints from the publishable key prefix.

## Quick Start

```typescript
import { Networks, OMSWallet, WalletType } from '@polygonlabs/oms-wallet'

const omsWallet = new OMSWallet({
  publishableKey: 'your-publishable-key',
})

// 1. Send a one-time code to the user's email
await omsWallet.wallet.startEmailAuth({ email: 'user@example.com' })

// 2. User enters the code from their inbox.
const { wallet } = await omsWallet.wallet.completeEmailAuth({ code: '123456' })
if (wallet.type !== WalletType.Ethereum) throw new Error('Expected an Ethereum wallet')

// 3. The wallet is ready
console.log('Wallet address:', wallet.address)

// 4. Prove the wallet can sign without moving funds.
const signature = await omsWallet.wallet.signMessage({
  network: Networks.amoy,
  message: 'hello from OMS Wallet',
})
console.log('Signature:', signature)

// 5. Read balances from the chains your app needs.
const balances = await omsWallet.indexer.getBalances({
  walletAddress: wallet.address,
  networks: [Networks.polygon, Networks.base, Networks.arbitrum],
  includeMetadata: true,
})
console.log('Balances:', balances)
```

## Overview

`OMSWallet` exposes two sub-clients:

| Property | Type | Description |
|---|---|---|
| `omsWallet.wallet` | `OMSWalletClient` | Authentication, signing, and transaction submission. |
| `omsWallet.indexer` | `OMSWalletIndexerClient` | Read token balances and on-chain state. |

## Security Model

The SDK stores completed wallet-session metadata in the configured storage so apps can restore an active session after refresh or restart. Pending email OTP and OIDC redirect state are transient and are not exposed through `session`.

In browsers, wallet API requests are signed with a non-extractable WebCrypto P-256 credential. Persisted session data contains wallet and auth metadata only; the browser credential remains managed by WebCrypto. Non-browser runtimes fall back to in-memory storage unless you provide a custom `StorageManager`.

Completed auth requests ask for a one-week session lifetime by default. You can request a shorter or longer lifetime up to 30 days. Expired sessions become inactive before protected wallet operations; call `signOut()` to end the session and clear active wallet state.

## Authentication Flow

OMS supports email-based OTP, OIDC ID-token auth, and OIDC authorization-code redirect auth.

### Email OTP Auth

Email OTP is a two-step flow:

1. **`startEmailAuth({ email, sessionLifetimeSeconds? })`** — validates the requested session lifetime, clears any active session, and sends a one-time code to the user's inbox.
2. **`completeEmailAuth({ code })`** — verifies the code, then automatically loads an existing wallet or creates a new one if none exists. Returns `{ wallet, wallets, credential }`.

Use manual wallet selection when the app needs to present wallet choices:

```typescript
const selection = await omsWallet.wallet.completeEmailAuth({
  code: '123456',
  walletSelection: 'manual',
})

await selection.selectWallet({ walletId: selection.wallets[0].id })
// or:
await selection.createAndSelectWallet({ reference: 'main' })
```

The returned pending selection is bound to the verified auth flow and signer. Hold that object and complete selection through it instead of saving `{ wallets }` and later calling global wallet activation methods.

### OIDC Redirect Auth

For simple browser apps, call `signInWithOidcRedirect` from a sign-in action.
Pass one of the immutable `OmsRelayOidcProviders` values for Google or Apple.
For these OMS-relayed providers, the method calls `startOidcRedirectAuth`, derives the
current page as `omsRelayReturnUri`, and navigates with `window.location.assign`:

```typescript
import { OmsRelayOidcProviders } from '@polygonlabs/oms-wallet'

void omsWallet.wallet.signInWithOidcRedirect({ provider: OmsRelayOidcProviders.google })
void omsWallet.wallet.signInWithOidcRedirect({ provider: OmsRelayOidcProviders.apple })

// On the callback page:
const result = await omsWallet.wallet.completeOidcRedirectAuth()
if (result && 'wallet' in result) {
  console.log('Wallet address:', result.wallet.address)
}
```

For router-driven apps, use the explicit start/complete methods:

```typescript
const { authorizationUrl } = await omsWallet.wallet.startOidcRedirectAuth({
  provider: OmsRelayOidcProviders.google,
  omsRelayReturnUri: `${window.location.origin}/auth/callback`, // optional in browser apps
})

window.location.assign(authorizationUrl)

// On the callback route:
const result = await omsWallet.wallet.completeOidcRedirectAuth()
if (result && 'wallet' in result) {
  console.log('Wallet address:', result.wallet.address)
}
```

OIDC redirect auth also supports manual wallet selection by passing
`walletSelection: 'manual'` to `startOidcRedirectAuth` or
`completeOidcRedirectAuth`. Options passed at start are stored with the pending
redirect state and used after the provider redirects back.

For SDK built-in Google and Apple providers, `omsRelayReturnUri` is the URL where the OMS relay returns the user after Google or Apple redirects to the OMS callback. In browser convenience flows, the SDK derives it from the current page URL when omitted. Custom OIDC providers do not use `omsRelayReturnUri`; configure their OAuth callback with `providerRedirectUri` instead:

| Flow | Provider config | App return URL | Provider OAuth callback |
|---|---|---|---|
| OMS relay Google/Apple | `OmsRelayOidcProviders.google` / `.apple` | `omsRelayReturnUri` | OMS relay callback derived as `{apiBase}/auth/waas/callback/{google\|apple}` |
| Custom OIDC provider | `CustomOidcProviderConfig` | `providerRedirectUri` | `providerRedirectUri` |
| Google/Apple without SDK relay | Direct custom config for Google or Apple | `providerRedirectUri` | `providerRedirectUri` |

Pass `loginHint` only when you want to prefill or select a specific Google
account, such as during session-expiry reauth. When omitted, the SDK falls back
to the previous active session email when one exists before the redirect auth
attempt starts. To force no `login_hint` for a call, pass `loginHint: ''`.

Pending redirect state is stored in `sessionStorage` by default. Final wallet session metadata continues to use the configured SDK storage.

`OmsRelayOidcProviders.google` and `OmsRelayOidcProviders.apple` are deeply
frozen, opaque SDK values. Their client IDs, scopes, authorization parameters,
and PKCE auth-code mode are not caller-editable. The SDK derives their provider
callback URL from the publishable-key environment as
`{apiBase}/auth/waas/callback/{provider}`.
For custom providers, see [Custom OIDC Providers](#custom-oidc-providers).

### OIDC ID-Token Auth

For OIDC ID-token flows, obtain the provider token in your app or backend flow,
then pass it to the SDK with the issuer and audience:

```typescript
const result = await omsWallet.wallet.signInWithOidcIdToken({
  idToken: googleIdToken,
  issuer: 'https://accounts.google.com',
  audience: 'YOUR_WEB_CLIENT_ID',
})

console.log('Wallet address:', result.wallet.address)
```

Use `walletSelection: 'manual'` with `signInWithOidcIdToken` when your app needs
to present its own wallet picker after the token is verified.

### Session State

Email and OIDC auth both persist the active wallet session in the configured SDK storage. The versioned session record is scoped to the publishable key project and API environment. A client rejects and clears a stored session when either scope differs. Browser storage defaults to `localStorage` when available; non-browser runtimes fall back to in-memory storage unless you provide a custom `StorageManager`. Browser signing defaults to a non-extractable WebCrypto P-256 credential using `ecdsa-p256-sha256`. Completed auth requests ask the wallet API for a one-week session lifetime.

Pass `sessionLifetimeSeconds` to `startEmailAuth`, `signInWithOidcIdToken`, `startOidcRedirectAuth`, `completeOidcRedirectAuth`, or `signInWithOidcRedirect` to request a different session lifetime. Values must be integer seconds from `1` through `2592000` (30 days). For OIDC redirects, values passed at start are stored with the pending redirect state and used on callback completion unless completion overrides them.

Use `omsWallet.wallet.activeWallet` for the active wallet. It has the same shape as the entries `listWallets()` returns and is `undefined` when signed out. Narrow on `type` to get the address type for that wallet family; Ethereum addresses are typed as viem `Address`. Use `omsWallet.wallet.session` for credential expiry and structured auth metadata. It is defined exactly when `activeWallet` is.

```typescript
import { WalletType } from '@polygonlabs/oms-wallet'

const activeWallet = omsWallet.wallet.activeWallet
if (!activeWallet) {
  // Show sign-in.
} else if (activeWallet.type === WalletType.Ethereum) {
  console.log('EVM address:', activeWallet.address) // viem Address
}

const session = omsWallet.wallet.session
const accountEmail = session?.auth.email
const authLabel = session?.auth.type === 'oidc'
  ? session.auth.providerLabel ?? session.auth.provider ?? session.auth.issuer
  : session?.auth.type === 'email'
    ? 'Email'
    : 'Unknown'
```

`activeWallet` and `session` return readonly snapshots. Changing a returned object does not update SDK state or persisted session metadata.

Use `omsWallet.wallet.getIdToken({ ttlSeconds, customClaims })` to request an ID token for the active wallet session.

Pending email OTP and OIDC redirect state are not exposed through `session`; use the auth method results to drive pending UI.

The SDK makes expired sessions inactive before protected wallet operations and throws `OMSWalletSessionError` with code `OMS_SESSION_EXPIRED`. It clears the active signer/session state, but keeps the expired session metadata in storage until the app explicitly starts a new auth flow or calls `signOut()`. Subscribe with `omsWallet.wallet.onSessionExpired` to route the user back to sign-in while preserving the expired session snapshot for email OTP reauth or Google account hints, including after a page refresh:

```typescript
const omsWallet = new OMSWallet({
  publishableKey: 'your-publishable-key',
})

const unsubscribe = omsWallet.wallet.onSessionExpired(({ wallet, session }) => {
  // Use the expired session metadata to populate and display your reauthentication UI.
  // `wallet` is undefined when the credential expired during a pending manual wallet selection.
  console.info('Session expired:', wallet?.address, session.auth)
})
```

To end the session, call:

```typescript
await omsWallet.wallet.signOut()
```

## Core Workflows

### Manage and Import Wallets

`listWallets`, `useWallet`, and `createWallet` manage the wallets attached to the authenticated
account. Every returned wallet includes `keyOrigin`, which is `WalletKeyOrigin.Enclave` for a key
created by WaaS and `WalletKeyOrigin.Imported` for an imported key.

Wallet import verifies AWS Nitro enclave attestations against the measurements managed by each OMS
environment. Development uses Nitro debug mode, whose all-zero PCR0 does not identify a specific
enclave image; use only disposable test keys there. Staging and Production accept only the release
measurements shipped by the SDK.

```typescript
import {
  OMSWallet,
  WalletImportCipherSuite,
  WalletKeyOrigin,
  WalletType,
} from '@polygonlabs/oms-wallet'

const omsWallet = new OMSWallet({
  publishableKey: 'your-publishable-key',
})

const { wallet } = await omsWallet.wallet.importWallet({
  type: WalletType.Ethereum,
  privateKey: process.env.TEST_EVM_PRIVATE_KEY!,
  reference: 'Imported test wallet',
})

console.log(wallet.keyOrigin === WalletKeyOrigin.Imported)
```

The high-level method validates the key locally, fetches an attested recipient key, verifies the
Nitro certificate chain, PCR0, freshness, nonce, signature, and request/response binding, and HPKE
encrypts the private key before sending it. EVM and Tron keys (both secp256k1) can be 32 raw bytes
or hexadecimal text; Solana keys can be a 32-byte seed, 64-byte keypair, or unambiguous base58 text. Pass raw bytes when
a valid base58 encoding is itself exactly 32 or 64 characters, because those string lengths are
rejected as ambiguous. Imported keys are never stored by the SDK. Import also works while a manual
wallet selection is pending, provided its wallet type matches the pending selection.

Custody systems that perform HPKE themselves can call `getWalletImportRecipientKey` followed by
`importEncryptedWallet`. These advanced methods expose base64 key material and all WaaS-supported
`WalletImportCipherSuite` values; the SDK still verifies attestation on both requests.

For a Privy server-wallet migration, request Privy's supported suite and send the returned public
key to an application-backend endpoint that calls Privy's wallet export API. Never call Privy with
an app secret from browser code.

```typescript
const recipient = await omsWallet.wallet.getWalletImportRecipientKey({
  cipherSuite: WalletImportCipherSuite.P256Sha256ChaCha20Poly1305,
})

// Replace this path with your application backend endpoint.
const response = await fetch('/api/export-privy-wallet', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ recipientPublicKey: recipient.publicKey }),
})

if (!response.ok) {
  throw new Error('Privy wallet export failed')
}

const privyExport = await response.json() as {
  encapsulated_key: string
  ciphertext: string
}

await omsWallet.wallet.importEncryptedWallet({
  type: WalletType.Ethereum,
  keyMaterial: {
    keyId: recipient.keyId,
    cipherSuite: recipient.cipherSuite,
    encapsulatedKey: privyExport.encapsulated_key,
    ciphertext: privyExport.ciphertext,
  },
})
```

The backend's Privy export request uses `encryption_type: "HPKE"` and
`recipient_public_key: recipient.publicKey`. Privy exports an individual wallet private key; derive
the intended child key before import when migrating from a mnemonic or HD root.

For cross-origin browser use, the WaaS deployment must include `X-Attestation-Document` in
`Access-Control-Expose-Headers` so the SDK can read and verify it.

### Sign and Verify EVM Messages

EVM message signing and verification require an Ethereum wallet. Signing requires a network;
verification can omit it for EOA signatures but requires it for smart-wallet signatures. Narrow the
active wallet account before passing its address to the verification method:

```typescript
import { Networks, WalletType } from '@polygonlabs/oms-wallet'

const activeWallet = omsWallet.wallet.activeWallet
if (activeWallet?.type !== WalletType.Ethereum) {
  throw new Error('An Ethereum wallet is required')
}

const signature = await omsWallet.wallet.signMessage({
  network: Networks.amoy,
  message: 'some message to sign',
})

const isValid = await omsWallet.wallet.isValidMessageSignature({
  network: Networks.amoy,
  walletAddress: activeWallet.address,
  message: 'some message to sign',
  signature,
})
```

### Sign and Verify Typed Data

```typescript
import { Networks, WalletType } from '@polygonlabs/oms-wallet'

const typedData = {
  domain: { name: 'Checkout', version: '1', chainId: 80002n },
  types: {
    Order: [
      { name: 'orderId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
    ],
  },
  primaryType: 'Order',
  message: { orderId: 1042n, amount: 1_000_000n },
} as const

const activeWallet = omsWallet.wallet.activeWallet
if (activeWallet?.type !== WalletType.Ethereum) {
  throw new Error('An Ethereum wallet is required')
}

const signature = await omsWallet.wallet.signTypedData({
  network: Networks.amoy,
  typedData,
})

const isValid = await omsWallet.wallet.isValidTypedDataSignature({
  network: Networks.amoy,
  walletAddress: activeWallet.address,
  typedData,
  signature,
})
```

### Query Balances

```typescript
const activeWallet = omsWallet.wallet.activeWallet
if (activeWallet?.type !== WalletType.Ethereum) throw new Error('No active Ethereum wallet')

const result = await omsWallet.indexer.getBalances({
  networks: [Networks.polygon, Networks.base, Networks.arbitrum],
  walletAddress: activeWallet.address,
  includeMetadata: true,
})

for (const b of result.nativeBalances) {
  console.log(b.symbol, b.balance)
}

for (const b of result.balances) {
  console.log(b.contractInfo?.symbol, b.balance, b.contractInfo?.decimals)
}
```

### Query Solana Balances

Use `getSolanaBalances` for native SOL and fungible SPL-token balances. Omit `networks` to query both
Solana Mainnet and Devnet, or pass either supported network explicitly. Results contain
precision-safe raw and formatted balance strings. Individual network failures are reported in
`errors` without discarding balances returned by the other requested network.

```typescript
import { SolanaNetworks } from '@polygonlabs/oms-wallet'

const result = await omsWallet.indexer.getSolanaBalances({
  walletAddress: 'vn3YnndV3gGu7DrHSQAPfywmba7QPq18SvA7PSiytAV',
  networks: [SolanaNetworks.mainnet, SolanaNetworks.devnet],
  includeMetadata: true,
})

for (const balance of result.balances) {
  console.log(balance.network, balance.symbol, balance.formattedBalance)
}

for (const error of result.errors) {
  console.warn(error.network, error.reason)
}
```

Solana wallets support off-chain message signing and verification without a network argument because
off-chain messages are not cluster-specific. Solana verification has a separate method from EVM
message verification:

```typescript
import { WalletType } from '@polygonlabs/oms-wallet'

const { wallet } = await omsWallet.wallet.createWallet({ type: WalletType.Solana })

const signature = await omsWallet.wallet.signSolanaMessage({
  message: 'some message to sign',
})

const isValid = await omsWallet.wallet.isValidSolanaMessageSignature({
  walletAddress: wallet.address,
  message: 'some message to sign',
  signature,
})
```

Use `sendSolanaTransfer` for native SOL or SPL-token transfers. Amounts use the asset's smallest
unit: lamports for SOL and base units for SPL tokens. Transfers use relayer mode by default, so the
network fee is sponsored. If an SPL transfer must create the recipient's associated token account,
WaaS returns fee options for the account rent; the SDK uses a supplied fee selector or the first
option by default. Pass `mode: TransactionMode.Native` to explicitly prepare a self-funded transfer
instead.

```typescript
import { SolanaNetworks } from '@polygonlabs/oms-wallet'

const solTransfer = await omsWallet.wallet.sendSolanaTransfer({
  network: SolanaNetworks.devnet,
  asset: 'SOL',
  to: '3gFktQX6vki5M2DzN8Y1ESPUJ4fJ8o6hVQWf8vYvPypD',
  amount: 1_000_000n, // 0.001 SOL
})

const splTransfer = await omsWallet.wallet.sendSolanaTransfer({
  network: SolanaNetworks.devnet,
  asset: 'So11111111111111111111111111111111111111112',
  to: '3gFktQX6vki5M2DzN8Y1ESPUJ4fJ8o6hVQWf8vYvPypD',
  amount: 1n,
})

console.log(solTransfer.txnHash ?? solTransfer.txnId)
console.log(splTransfer.txnHash ?? splTransfer.txnId)
```

For SPL transfers, the recipient is a wallet address rather than an associated token account. WaaS
uses the recipient's existing associated token account or creates it when necessary. In relayer mode,
only the rent for a newly created token account is paid through the returned fee options.

Pass `contractAddresses` to filter balances to specific token contracts. Omit `networks` to query mainnets by default, or pass `networkType: 'TESTNETS'` / `'ALL'`. With `includeMetadata: true`, ERC-20 decimals are available as `contractInfo.decimals`. The response is paginated; pass `page` when requesting later pages.

### Tron Wallets

Tron wallets are EOAs and always execute in native mode, so the Tron methods take no `mode`
parameter. Create one with `createWallet({ type: WalletType.Tron })`, sign in with
`walletType: WalletType.Tron`, or import a secp256k1 private key with `type: 'tron'`. Tron addresses
are Base58Check strings (`T…`). Supported networks are `TronNetworks.mainnet` and
`TronNetworks.nile`. TRC-10 tokens are not supported.

```typescript
import { TronNetworks, WalletType } from '@polygonlabs/oms-wallet'

const { wallet } = await omsWallet.wallet.createWallet({ type: WalletType.Tron })

const signature = await omsWallet.wallet.signTronMessage({ message: 'some message to sign' })
const isValid = await omsWallet.wallet.isValidTronMessageSignature({
  walletAddress: wallet.address,
  message: 'some message to sign',
  signature,
})

// TRX transfer. Values are in sun (1 TRX = 1,000,000 sun).
const trxTransfer = await omsWallet.wallet.sendTronTransaction({
  network: TronNetworks.nile,
  to: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  value: 1_000_000n,
})

// TRC-20 transfer. The wallet service ABI-encodes the call; address arguments accept `T…`.
const trc20Transfer = await omsWallet.wallet.callTronContract({
  network: TronNetworks.nile,
  contractAddress: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
  method: 'transfer',
  args: [
    { type: 'address', value: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
    { type: 'uint256', value: '1000000' },
  ],
})
```

`signTronTypedData` and `isValidTronTypedDataSignature` sign and verify TIP-712 typed data, whose
address values may be Base58Check.

Omitting `data` from `sendTronTransaction` sends a plain TRX transfer. Passing `data`, even `'0x'`,
makes the transaction a contract call: `'0x'` calls the recipient contract's payable fallback.

Every Tron account gets a daily free bandwidth allowance (600 points, about two TRX transfers),
so prepared Tron transactions are often `sponsored` even without a relayer. When the allowance is
spent, WaaS quotes the TRX to burn as a single native fee option, which a fee selector receives like
any other fee option.

`getTronBalances` returns TRX and TRC-20 balances in the same shape as `getSolanaBalances`. It is
experimental. Until the OMS Tron indexer is available, it reads balances from public Tron JSON-RPC
(TronGrid), so TRC-20 balances are returned only for the contracts passed in `contractAddresses`.
Failures on individual networks are reported in `errors`.

```typescript
const balances = await omsWallet.indexer.getTronBalances({
  walletAddress: wallet.address,
  networks: [TronNetworks.nile],
  contractAddresses: ['TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'],
})
```

### Query Transaction History

```typescript
const activeWallet = omsWallet.wallet.activeWallet
if (activeWallet?.type !== WalletType.Ethereum) throw new Error('No active Ethereum wallet')

const history = await omsWallet.indexer.getTransactionHistory({
  walletAddress: activeWallet.address,
  networks: [Networks.polygon, Networks.base, Networks.arbitrum],
  includeMetadata: true,
})

for (const transaction of history.transactions) {
  console.log(transaction.txnHash, transaction.timestamp)
}
```

### Sending Transactions

`sendTransaction` can move real funds on mainnet. Start on a testnet such as Polygon Amoy, fund the wallet from a faucet, and use a small value before switching to production networks.

Install `viem` when using `parseUnits` for transaction values:

```bash
pnpm add viem
```

`sendTransaction` has three overloaded signatures to cover the most common patterns.

#### First Testnet Transfer

```typescript
import { FeeOptionSelector, Networks } from '@polygonlabs/oms-wallet'
import { parseUnits } from 'viem'

const tx = await omsWallet.wallet.sendTransaction({
  network: Networks.amoy,
  to: '0x1111111111111111111111111111111111111111',
  value: parseUnits('0.001', 18), // 0.001 testnet POL
  selectFeeOption: FeeOptionSelector.firstAvailable,
})

console.log(tx.txnHash ?? tx.txnId)
```

#### Raw Data Transaction

```typescript
const tx = await omsWallet.wallet.sendTransaction({
  network: Networks.amoy,
  to: '0x2222222222222222222222222222222222222222',
  data: '0x12345678',
})
```

#### ABI-Encoded Contract Call (via viem)

Pass an ABI and function name — the SDK encodes the calldata automatically using viem.

```typescript
import { parseUnits } from 'viem'

const erc20Abi = [
  {
    name: 'transfer',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  },
] as const

const tx = await omsWallet.wallet.sendTransaction({
  network: Networks.amoy,
  to: '0x3333333333333333333333333333333333333333',
  abi: erc20Abi,
  functionName: 'transfer',
  args: ['0x1111111111111111111111111111111111111111', parseUnits('0.001', 18)],
})
```

#### Call a Contract (method string + args)

```typescript
import { parseUnits } from 'viem'

const tx = await omsWallet.wallet.callContract({
  network: Networks.amoy,
  contractAddress: '0x3333333333333333333333333333333333333333',
  method: 'transfer',
  args: [
    { type: 'address', value: '0x1111111111111111111111111111111111111111' },
    { type: 'uint256', value: parseUnits('0.001', 18).toString() },
  ],
})
```

Pass the function name only (`'transfer'`, not `'transfer(address,uint256)'`). The wallet service
builds the signature from the `args` types, and the SDK rejects a full signature locally.

`sendTransaction` and `callContract` prepare and execute the transaction, then poll the wallet API for
the latest transaction status. The response includes `txnId`, `status`, and `txnHash`
when the transaction has been published. `statusResolution` is `resolved` when
polling finds a terminal status or transaction hash, and `timed-out` when the
polling deadline is reached.

To return immediately after execute without status polling, pass
`waitForStatus: false`. You can then call `getTransactionStatus` with the
returned `txnId`.

```typescript
import { parseUnits } from 'viem'

const tx = await omsWallet.wallet.sendTransaction({
  network: Networks.amoy,
  to: '0x1111111111111111111111111111111111111111',
  value: parseUnits('0.001', 18),
  waitForStatus: false,
})

const status = await omsWallet.wallet.getTransactionStatus({ txnId: tx.txnId })
```

With `waitForStatus: false`, the response has `statusResolution: 'not-requested'`.

To tune polling, pass `statusPolling`:

```typescript
import { parseUnits } from 'viem'

await omsWallet.wallet.sendTransaction({
  network: Networks.amoy,
  to: '0x1111111111111111111111111111111111111111',
  value: parseUnits('0.001', 18),
  statusPolling: {
    timeoutMs: 30_000,
    intervalMs: 1_000,
  },
})
```

If the wallet API returns fee options, pass a selector to choose one. The
selector receives `FeeOptionWithBalance` values. For Ethereum fees, `balance`
contains the matching `TokenBalance` when available. For Ethereum, Solana, and Tron fees,
`available` is formatted with the token decimals, `availableRaw` keeps the raw integer
value, and `decimals` is the token decimal count used for formatting. Use
`FeeOptionSelector.firstAvailable` to choose the first option the wallet can
pay on Ethereum, Solana, or Tron, or return `option.selection` from a custom selector. A
sponsored transaction invokes the selector with an empty array. Resolve with `undefined`
after acknowledging the free fee, or throw to stop execution.
`FeeOptionSelector.firstAvailable` returns `undefined` for that empty array and continues
execution as before.

```typescript
const tx = await omsWallet.wallet.sendTransaction({
  network: Networks.amoy,
  to: '0x3333333333333333333333333333333333333333',
  data: '0x12345678',
  selectFeeOption: async (feeOptions) => {
    if (feeOptions.length === 0) {
      // Present the sponsored transaction for confirmation here.
      return undefined
    }
    const selected = feeOptions.find(option => option.feeOption.token.symbol === 'USDC')
    return selected?.selection
  },
})
```

## Advanced Configuration

### Publishable-Key Routing

`OMSWallet` derives service endpoints from the publishable key. Wallet requests use the API base URL directly; indexer requests use the same environment-specific API base.

| Publishable key prefix | API base URL |
|---|---|
| `pk_dev_sdbx_` | `https://sandbox-api.dev.polygon-dev.technology` |
| `pk_dev_live_` | `https://api.dev.polygon-dev.technology` |
| `pk_stg_sdbx_` | `https://sandbox-api.stg.polygon-dev.technology` |
| `pk_stg_live_` | `https://api.stg.polygon-dev.technology` |
| `pk_sdbx_` | `https://sandbox-api.polygon.technology` |
| `pk_live_` | `https://api.polygon.technology` |

### Custom OIDC Providers

Create a `CustomOidcProviderConfig` and pass it directly to an OIDC redirect
method. Custom configs require `providerRedirectUri`.
They cannot use `omsRelayReturnUri`.

```typescript
import { type CustomOidcProviderConfig } from '@polygonlabs/oms-wallet'

const acmeProvider = {
  clientId: 'acme-client-id',
  issuer: 'https://login.acme.example',
  authorizationUrl: 'https://login.acme.example/oauth/authorize',
  provider: 'acme',
  providerLabel: 'Acme',
  providerRedirectUri: 'https://app.example/auth/callback',
  scopes: ['openid', 'email', 'profile'],
} satisfies CustomOidcProviderConfig

await omsWallet.wallet.signInWithOidcRedirect({ provider: acmeProvider })
```

Provider configs are the source of truth for OIDC scopes. If `scopes` is omitted or empty, the SDK does not send a `scope` authorization parameter. OIDC auth mode defaults to PKCE; pass `authMode` when a provider needs a different authorization-code mode.

### Custom Storage and Signing

The default storage backend is browser `localStorage` when available, otherwise in-memory storage for wallet metadata only. The default browser signer stores its non-extractable key reference separately through WebCrypto-compatible browser storage. Provide a custom `StorageManager` when Node.js, tests, or another custom runtime needs persistence:

```typescript
import { MemoryStorageManager, OMSWallet } from '@polygonlabs/oms-wallet'

const omsWallet = new OMSWallet({
  publishableKey: 'your-publishable-key',
  storage: new MemoryStorageManager(),
})
```

OIDC redirect auth uses separate transient storage for verifier/state data. In browsers it defaults to `sessionStorage`; pass `redirectAuthStorage` to override it. Final wallet session metadata continues to use the configured `storage`.

## Reference

### Networks

The SDK exports `Networks`, `findNetworkById(id)`, and `findNetworkByName(name)` for the networks currently configured by OMS. Each network has `id`, `name`, `nativeTokenSymbol`, `explorerUrl`, and `displayName`. `name` is the registry/routing slug, while `displayName` is the user-facing label. `Network` is a closed SDK type: use a `Networks` value or a successful lookup result.

The `network` parameter on all transaction and signing methods accepts a `Network` from the SDK registry:

```typescript
import { Networks, findNetworkById } from '@polygonlabs/oms-wallet'

await omsWallet.wallet.signMessage({ network: Networks.amoy, message: 'some message to sign' })

console.log(Object.values(Networks))
console.log(findNetworkById(80002)) // Networks.amoy
```

| Key | id | name | display name | native token | explorerUrl |
|---|---:|---|---|---|---|
| `Networks.mainnet` | 1 | `mainnet` | Ethereum | ETH | `https://etherscan.io` |
| `Networks.sepolia` | 11155111 | `sepolia` | Sepolia | ETH | `https://sepolia.etherscan.io` |
| `Networks.polygon` | 137 | `polygon` | Polygon | POL | `https://polygonscan.com` |
| `Networks.amoy` | 80002 | `amoy` | Polygon Amoy | POL | `https://amoy.polygonscan.com` |
| `Networks.arbitrum` | 42161 | `arbitrum` | Arbitrum | ETH | `https://arbiscan.io` |
| `Networks.arbitrumSepolia` | 421614 | `arbitrum-sepolia` | Arbitrum Sepolia | ETH | `https://sepolia.arbiscan.io` |
| `Networks.optimism` | 10 | `optimism` | Optimism | ETH | `https://optimistic.etherscan.io` |
| `Networks.optimismSepolia` | 11155420 | `optimism-sepolia` | Optimism Sepolia | ETH | `https://sepolia-optimism.etherscan.io` |
| `Networks.base` | 8453 | `base` | Base | ETH | `https://basescan.org` |
| `Networks.baseSepolia` | 84532 | `base-sepolia` | Base Sepolia | ETH | `https://sepolia.basescan.org` |
| `Networks.bsc` | 56 | `bsc` | BSC | BNB | `https://bscscan.com` |
| `Networks.bscTestnet` | 97 | `bsc-testnet` | BSC Testnet | BNB | `https://testnet.bscscan.com` |
| `Networks.arbitrumNova` | 42170 | `arbitrum-nova` | Arbitrum Nova | ETH | `https://nova.arbiscan.io` |
| `Networks.avalanche` | 43114 | `avalanche` | Avalanche | AVAX | `https://subnets.avax.network/c-chain` |
| `Networks.avalancheTestnet` | 43113 | `avalanche-testnet` | Avalanche Testnet | AVAX | `https://subnets-test.avax.network/c-chain` |
| `Networks.katana` | 747474 | `katana` | Katana | ETH | `https://katanascan.com` |

Solana and Tron networks are string identifiers rather than `Network` values: `SolanaNetworks.mainnet`
(`'solana:mainnet'`), `SolanaNetworks.devnet` (`'solana:devnet'`), `TronNetworks.mainnet`
(`'tron:mainnet'`), and `TronNetworks.nile` (`'tron:nile'`).

### Errors

Public methods throw `OMSWalletError` subclasses with stable SDK fields such as `code`, `operation`, `status`, and `retryable`. When a failure comes from a remote OMS service response or transport failure, the error also includes `upstreamError` with normalized wallet API or indexer details for logging and service-specific troubleshooting. For `OMSWalletError` values, branch application logic on the SDK-level `code`.

For transaction writes, `OMS_TRANSACTION_EXECUTION_UNCONFIRMED` means the SDK has a `txnId` from preparation, but the execute request failed before the SDK could confirm whether the transaction was submitted; do not blindly resend the same write. `OMS_TRANSACTION_STATUS_LOOKUP_FAILED` means the transaction was submitted but status polling failed, so retry status lookup with the returned `txnId`. `retryable` describes the failed SDK operation, not the whole user intent.

Wallet import reports an already-managed address as `OMS_WALLET_ADDRESS_ALREADY_IMPORTED` and a
missing, malformed, stale, or untrusted enclave attestation as
`OMS_ATTESTATION_VERIFICATION_FAILED`. Do not retry or send key material after an attestation
failure until the SDK trust policy or backend attestation has been corrected.

```typescript
import { OMSWalletError } from '@polygonlabs/oms-wallet'

try {
  await omsWallet.wallet.startEmailAuth({ email: 'user@example.com' })
} catch (err) {
  if (err instanceof OMSWalletError) {
    console.log(err.code, err.operation, err.upstreamError)
  }
}
```

### Manage Access

`listAccess` returns a discriminated `AccessGrant` union. Narrow on `type` before using remote-only
session metadata, or pass `{ type: 'direct' }` / `{ type: 'remote' }` to filter the request.

```typescript
const grants = await omsWallet.wallet.listAccess()

for (const grant of grants) {
  console.log(grant.credentialId, grant.expiresAt, grant.isCaller)
  if (grant.type === 'remote') {
    console.log(grant.sessionId, grant.metadata, grant.grants)
  }
}

for await (const page of omsWallet.wallet.listAccessPages({ pageSize: 25 })) {
  console.log('Page:', page.grants)
}

await omsWallet.wallet.revokeAccess({ credentialId: grants[0].credentialId })
```

### Smart Sessions

The wallet owner can inspect a remote credential and authorize a bounded Ethereum session. The
authorization result (`walletId`, `sessionId`) is sent to the remote application, which uses it to
operate within the granted limits.

```typescript
const credentialId = 'remote-credential-id'
const metadata = await omsWallet.wallet.inspectRemoteCredential({ credentialId })

// Display `metadata` to the wallet owner and continue only after they approve.
console.log(metadata)

// After the owner approves:
const session = await omsWallet.wallet.authorizeRemoteAccess({
  credentialId,
  network: Networks.polygon,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  grants: [
    { kind: 'nativeTransfer', to: '0x1111111111111111111111111111111111111111', limit: 1_000_000_000_000_000n },
    { kind: 'erc20Transfer', token: '0x2222222222222222222222222222222222222222', limit: 10_000_000n, cumulative: true },
  ],
})

const sessionDetails = await omsWallet.wallet.getRemoteAccessSession({
  sessionId: session.sessionId,
})
const usage = await omsWallet.wallet.getRemoteAccessSessionUsage({
  sessionId: session.sessionId,
  network: Networks.polygon,
})

await omsWallet.wallet.revokeAccess({
  credentialId,
  sessionId: session.sessionId,
})
```

A backend uses `RemoteAccessClient` with its own persistent credential signer. Registration returns
the WaaS credential ID that the owner authorizes; it is distinct from the signer's public address.
The backend must store the owner's returned `walletId` and `sessionId` out of band.

```typescript
import {
  EthereumPrivateKeyCredentialSigner,
  Networks,
  RemoteAccessClient,
  feeOptionSelection,
} from '@polygonlabs/oms-wallet'
import { hexToBytes } from 'viem'

const signer = new EthereumPrivateKeyCredentialSigner(
  hexToBytes(process.env.RAC_PRIVATE_KEY as `0x${string}`),
)
const remoteAccess = new RemoteAccessClient({
  publishableKey: process.env.OMS_PUBLISHABLE_KEY!,
  credentialSigner: signer,
})

const registered = await remoteAccess.registerCredential({
  lifetimeSeconds: 7 * 24 * 60 * 60,
  metadata: {
    appName: 'Example admin',
    appUrl: 'https://admin.example',
    appLogoUrl: '',
    custom: {},
  },
})

// Send registered.credentialId to the owner, then receive and persist the
// walletId and sessionId returned by authorizeRemoteAccess.
// These reads are scoped by the backend credential: one RAC can only see
// sessions that owners authorized for that RAC.
const sessions = await remoteAccess.listSessions()
for await (const page of remoteAccess.listSessionPages({ pageSize: 25 })) {
  console.log(page.sessions)
}
const sessionDetails = await remoteAccess.getSession({ sessionId })
const usage = await remoteAccess.getSessionUsage({ sessionId, network: Networks.amoy })

const prepared = await remoteAccess.prepareTransaction({
  walletId,
  sessionId,
  network: Networks.amoy,
  to: '0x1111111111111111111111111111111111111111',
  value: 1_000_000_000_000_000n,
})

const feeOption = prepared.sponsored ? undefined : prepared.feeOptions[0]
if (!prepared.sponsored && !feeOption) throw new Error('No fee option available')

await remoteAccess.executeTransaction({
  txnId: prepared.txnId,
  feeOption: feeOption ? feeOptionSelection(feeOption, 0) : undefined,
})

const status = await remoteAccess.getTransactionStatus({ txnId: prepared.txnId })
```

The signer must allocate strictly increasing nonces across concurrent backend instances. A
long-running single process can reuse `EthereumPrivateKeyCredentialSigner`; distributed runtimes
should wrap `CredentialSigner` with a shared atomic nonce store. The
[`examples/smart-session`](../../examples/smart-session) Cloudflare example uses D1 for this.

## Examples

Runnable examples live in the
[repository](https://github.com/0xPolygon/oms-wallet-typescript-sdk/tree/master/examples):

| Example | What it shows | Live demo |
|---|---|---|
| [`react`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/tree/master/examples/react) | Email, Google, and Apple sign-in, signing, transactions, balances, wallet management, Privy wallet import, Solana, and Tron | [Live demo](https://0xpolygon.github.io/oms-wallet-typescript-sdk/react-example/) |
| [`wagmi`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/tree/master/examples/wagmi) | The wagmi connector with the MetaMask connector and the Trails widget | [Live demo](https://0xpolygon.github.io/oms-wallet-typescript-sdk/wagmi-example/) |
| [`trails-actions`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/tree/master/examples/trails-actions) | Trails swap, Earn deposit, and Earn withdrawal flows | [Live demo](https://0xpolygon.github.io/oms-wallet-typescript-sdk/trails-actions-example/) |
| [`custom-google-redirect`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/tree/master/examples/custom-google-redirect) | Google as a custom OIDC provider with a localhost redirect URI | Local only |
| [`custom-auth0-id-token`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/tree/master/examples/custom-auth0-id-token) | Passing an Auth0-issued ID token to `signInWithOidcIdToken` | Local only |
| [`node`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/tree/master/examples/node) | Email OTP sign-in and message signing from a terminal | Local only |
| [`node-contract-deploy-example`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/tree/master/examples/node-contract-deploy-example) | Compiling and deploying an ERC-20 on Polygon Amoy from Node | Local only |
| [`smart-session`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/tree/master/examples/smart-session) | Backend-owned RACs serving smart sessions approved by owner wallets, on a Cloudflare Worker | Local only |

See the [repository README](https://github.com/0xPolygon/oms-wallet-typescript-sdk#readme) for how
to run them.

## Wagmi connector

To use OMS Wallet with [wagmi](https://wagmi.sh), install
[`@polygonlabs/oms-wallet-wagmi-connector`](https://www.npmjs.com/package/@polygonlabs/oms-wallet-wagmi-connector)
from npm. It is an ESM-only package that adapts an active Ethereum wallet from this SDK to wagmi's
connector API.

## API Reference

See [API.md](./API.md) for the full method and type reference.

## License

Apache-2.0. See [LICENSE](./LICENSE).
