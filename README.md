# OMS Client TypeScript SDK

A TypeScript SDK for the OMS (Open Money Stack) platform. Provides email and OIDC redirect wallet authentication, on-chain transaction submission, message signing, and token balance queries — with automatic session persistence.

## Usage

Install the published SDK package in your application:

```bash
pnpm add @0xsequence/typescript-sdk
```

For npm or yarn projects:

```bash
npm install @0xsequence/typescript-sdk
yarn add @0xsequence/typescript-sdk
```

Then initialize the client with your OMS publishable key:

```typescript
import { OMSClient } from '@0xsequence/typescript-sdk'

const oms = new OMSClient({
  publishableKey: 'your-publishable-key',
})
```

The SDK derives the WaaS API and IndexerGateway endpoints from the publishable key prefix.

In Vite browser apps, keep the publishable key in local environment variables:

```typescript
function requiredEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing ${name}`)
  }
  return value
}

const oms = new OMSClient({
  publishableKey: requiredEnv('VITE_OMS_PUBLISHABLE_KEY', import.meta.env.VITE_OMS_PUBLISHABLE_KEY),
})
```

If your app imports utilities from `viem`, such as the `parseUnits` helper used in the quick start below, install it as a direct dependency too:

```bash
pnpm add viem
```

For local development in this repository, install dependencies and build the workspace package:

From the repository root:

```bash
pnpm install
pnpm build
```

## React Example

A deployed React example is available at [https://0xsequence.github.io/typescript-sdk/react-example/](https://0xsequence.github.io/typescript-sdk/react-example/).

To run it locally from the repository root:

```bash
cp examples/react/.env.example examples/react/.env.local
# Fill VITE_OMS_PUBLISHABLE_KEY in examples/react/.env.local
pnpm dev:example
```

## Wagmi Connector

This workspace also includes `@0xsequence/oms-wallet-wagmi-connector`, an ESM-only package that adapts an
active OMS client to wagmi's connector API.

```bash
pnpm --filter @0xsequence/oms-wallet-wagmi-connector build
pnpm --filter @0xsequence/oms-wallet-wagmi-connector test
```

See [packages/oms-wallet-wagmi-connector/README.md](./packages/oms-wallet-wagmi-connector/README.md) for usage.

## Wagmi React Example

The Wagmi example uses `@0xsequence/oms-wallet-wagmi-connector`, wagmi's MetaMask connector, and the Trails widget.

The deployed Wagmi example is available at [https://0xsequence.github.io/typescript-sdk/wagmi-example/](https://0xsequence.github.io/typescript-sdk/wagmi-example/).

To run it locally from the repository root:

```bash
cp examples/wagmi/.env.example examples/wagmi/.env.local
# Fill VITE_OMS_PUBLISHABLE_KEY in examples/wagmi/.env.local
# Replace VITE_TRAILS_API_KEY only if you need a different Trails project
pnpm dev:wagmi-example
```

## Trails Actions React Example

The Trails Actions example prepares and sends Polygon swap, Earn deposit, swap plus Earn deposit, and Earn withdrawal flows with `0xtrails/actions`.

The deployed Trails Actions example is available at [https://0xsequence.github.io/typescript-sdk/trails-actions-example/](https://0xsequence.github.io/typescript-sdk/trails-actions-example/).

To run it locally from the repository root:

```bash
cp examples/trails-actions/.env.example examples/trails-actions/.env.local
# Fill VITE_OMS_PUBLISHABLE_KEY in examples/trails-actions/.env.local
pnpm dev:trails-actions-example
```

## Node Example

The Node example walks through email OTP sign-in and message signing from a terminal.

To run it locally from the repository root:

```bash
OMS_PUBLISHABLE_KEY=your-publishable-key pnpm dev:node-example
```

## Node Contract Deploy Example

The Node contract deploy example compiles a small ERC-20 contract and submits a Polygon Amoy deployment transaction through the OMS wallet API.

To run it locally from the repository root:

```bash
cp examples/node-contract-deploy-example/.env.example examples/node-contract-deploy-example/.env.local
# Fill OMS_PUBLISHABLE_KEY in examples/node-contract-deploy-example/.env.local
pnpm dev:node-contract-deploy-example
```

## Quick Start

```typescript
import { FeeOptionSelector, Networks, OMSClient, WalletType } from '@0xsequence/typescript-sdk'
import { parseUnits } from 'viem'

const oms = new OMSClient({
  publishableKey: 'your-publishable-key',
})

// 1. Send a one-time code to the user's email
await oms.wallet.startEmailAuth({ email: 'user@example.com' })

// 2. User enters the code — verifies it and sets up the wallet automatically
const { walletAddress, credential } = await oms.wallet.completeEmailAuth({ code: '123456' })

// 3. The wallet is ready
console.log('Wallet address:', walletAddress)
console.log('Credential:', credential.credentialId)

// 4. Send a transaction
const tx = await oms.wallet.sendTransaction({
  network: Networks.polygon,
  to: '0x1111111111111111111111111111111111111111',
  value: parseUnits('1', 18), // 1 POL
  // If this Polygon mainnet transaction is not sponsored, choose the first fee token the wallet can pay.
  selectFeeOption: FeeOptionSelector.firstAvailable,
})
console.log(tx.txnHash ?? tx.txnId)
```

## Overview

`OMSClient` exposes two sub-clients:

| Property | Type | Description |
|---|---|---|
| `oms.wallet` | `WalletClient` | Authentication, signing, and transaction submission. |
| `oms.indexer` | `IndexerClient` | Read token balances and on-chain state. |

## Authentication Flow

OMS supports email-based OTP and OIDC authorization-code redirect auth.

### Email OTP Auth

Email OTP is a two-step flow:

1. **`startEmailAuth({ email })`** — clears any active session and sends a one-time code to the user's inbox.
2. **`completeEmailAuth({ code })`** — verifies the code, then automatically loads an existing wallet or creates a new one if none exists. Returns `{ walletAddress, wallet, wallets, credential }`.

Use manual wallet selection when the app needs to present wallet choices:

```typescript
const selection = await oms.wallet.completeEmailAuth({
  code: '123456',
  walletType: WalletType.Ethereum,
  walletSelection: 'manual',
})

await selection.selectWallet({ walletId: selection.wallets[0].id })
// or:
await selection.createAndSelectWallet({ reference: 'main' })
```

The returned pending selection is bound to the verified auth flow and signer. Hold that object and complete selection through it instead of saving `{ wallets }` and later calling global wallet activation methods.

### OIDC Redirect Auth

Google and Apple redirect auth are configured by default. The redirect auth APIs are provider-neutral, so `auth.oidcProviders` can replace the configured provider set when you need custom providers.

```typescript
const oms = new OMSClient({
  publishableKey: 'your-publishable-key',
})
```

For router-driven apps, use the explicit start/complete methods:

```typescript
const { url } = await oms.wallet.startOidcRedirectAuth({
  provider: 'google',
  redirectUri: `${window.location.origin}/auth/callback`, // optional in browser apps
})

window.location.assign(url)

// On the callback route:
const result = await oms.wallet.completeOidcRedirectAuth()
if (result) {
  console.log('Wallet address:', result.walletAddress)
}
```

OIDC redirect auth also supports manual wallet selection by passing `walletSelection: 'manual'` to `startOidcRedirectAuth` or `completeOidcRedirectAuth`. Options passed at start are stored with the pending redirect state and used after the provider redirects back.

For simple browser apps, use `signInWithOidcRedirect` from a sign-in action. It calls `startOidcRedirectAuth`, derives the current page as `redirectUri`, and navigates with `window.location.assign`:

```typescript
void oms.wallet.signInWithOidcRedirect({ provider: 'google' })
void oms.wallet.signInWithOidcRedirect({ provider: 'apple' })

// On the callback page:
const result = await oms.wallet.completeOidcRedirectAuth()
if (result) {
  console.log('Wallet address:', result.walletAddress)
}
```

Pass `loginHint` only when you want to prefill or select a specific Google account, such as during session-expiry reauth. The SDK only sends `login_hint` for Google providers. When omitted, the SDK falls back to the previous active session email when one exists before the redirect auth attempt starts. After `signOut()`, that previous session email is cleared. To force no `login_hint` for a call, pass `loginHint: ''`.

Pending redirect state is stored in `sessionStorage` by default. Final wallet session metadata continues to use the configured SDK storage.

`googleOidcProvider()` uses the SDK default Google client ID, the SDK relay redirect URI, `openid email profile` scopes, and PKCE auth-code mode by default.

`appleOidcProvider()` uses the SDK default Apple Services ID, the SDK relay redirect URI, `openid email` scopes, `response_mode=form_post`, and PKCE auth-code mode by default.

### Session State

Email and OIDC auth both persist the active wallet session in the configured SDK storage. Browser storage defaults to `localStorage` when available; non-browser runtimes fall back to in-memory storage unless you provide a custom `StorageManager`. Browser signing defaults to a non-extractable WebCrypto P-256 credential using `ecdsa-p256-sha256`, so the private session key is not written to `localStorage`. Completed auth requests ask WaaS for a one-week session lifetime.

Pass `sessionLifetimeSeconds` to `completeEmailAuth`, `startOidcRedirectAuth`, `completeOidcRedirectAuth`, or `signInWithOidcRedirect` to request a different session lifetime. For OIDC redirects, values passed at start are stored with the pending redirect state and used on callback completion unless completion overrides them.

Use `oms.wallet.walletAddress` when you only need the active wallet address. Use `oms.wallet.session` when you also need credential expiry, login type, or the email returned by the wallet API.

```typescript
const walletAddress = oms.wallet.walletAddress
const { expiresAt, loginType, sessionEmail } = oms.wallet.session
```

Use `oms.wallet.getIdToken({ ttlSeconds, customClaims })` to request an ID token for the active wallet session.

Pending email OTP and OIDC redirect state are not exposed through `session`; use the auth method results to drive pending UI.

The SDK makes expired sessions inactive before protected wallet operations and throws `OmsSessionError` with code `OMS_SESSION_EXPIRED`. It clears the active signer/session state, but keeps the expired session metadata in storage until the app explicitly starts a new auth flow or calls `signOut()`. Subscribe with `oms.wallet.onSessionExpired` to route the user back to sign-in while preserving the expired session snapshot for email OTP reauth or Google account hints, including after a page refresh:

```typescript
const oms = new OMSClient({
  publishableKey: 'your-publishable-key',
})

const unsubscribe = oms.wallet.onSessionExpired(({ session }) => {
  showReauth(session)
})
```

To end the session, call:

```typescript
await oms.wallet.signOut()
```

## Errors

Public methods throw `OmsSdkError` subclasses with stable SDK fields such as `code`, `operation`, `status`, and `retryable`. When a failure comes from a remote OMS service response or transport failure, the error also includes `upstreamError` with normalized WaaS or indexer details for logging and service-specific troubleshooting. Application logic should usually branch on the SDK-level `code`.

For transaction writes, `OMS_TRANSACTION_EXECUTION_UNCONFIRMED` means the SDK has a `txnId` from preparation, but the execute request failed before the SDK could confirm whether the transaction was submitted; do not blindly resend the same write. `OMS_TRANSACTION_STATUS_LOOKUP_FAILED` means the transaction was submitted but status polling failed, so retry status lookup with the returned `txnId`. `retryable` describes the failed SDK operation, not the whole user intent.

```typescript
import { OmsSdkError } from '@0xsequence/typescript-sdk'

try {
  await oms.wallet.startEmailAuth({ email: 'user@example.com' })
} catch (err) {
  if (err instanceof OmsSdkError) {
    console.log(err.code, err.operation, err.upstreamError)
  }
}
```

## Networks

The SDK exports `Networks`, `supportedNetworks`, `findNetworkById(id)`, and `findNetworkByName(name)` for the networks currently configured by OMS. Each network has `id`, `name`, `nativeTokenSymbol`, `explorerUrl`, and `displayName`. `name` is the registry/routing slug, while `displayName` is the user-facing label.

The `network` parameter on all transaction and signing methods accepts a `Network` from the SDK registry:

```typescript
import { Networks, findNetworkById, supportedNetworks } from '@0xsequence/typescript-sdk'

await oms.wallet.signMessage({ network: Networks.polygon, message: 'some message to sign' })

console.log(supportedNetworks)
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

## Sending Transactions

`sendTransaction` has three overloaded signatures to cover the most common patterns.

### Native Token Transfer

```typescript
import { parseUnits } from 'viem'

const tx = await oms.wallet.sendTransaction({
  network: Networks.polygon,
  to: '0x1111111111111111111111111111111111111111',
  value: parseUnits('1', 18), // 1 POL
})
```

### Raw Data Transaction

```typescript
const tx = await oms.wallet.sendTransaction({
  network: Networks.polygon,
  to: '0x2222222222222222222222222222222222222222',
  data: '0x12345678',
})
```

### ABI-Encoded Contract Call (via viem)

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

const tx = await oms.wallet.sendTransaction({
  network: Networks.polygon,
  to: '0x3333333333333333333333333333333333333333',
  abi: erc20Abi,
  functionName: 'transfer',
  args: ['0x1111111111111111111111111111111111111111', parseUnits('1', 18)],
})
```

`sendTransaction` prepares and executes the transaction, then polls WaaS for
the latest transaction status. The response includes `txnId`, `status`, and `txnHash`
when the transaction has been published.

To return immediately after execute without status polling, pass
`waitForStatus: false`. You can then call `getTransactionStatus` with the
returned `txnId`.

```typescript
import { parseUnits } from 'viem'

const tx = await oms.wallet.sendTransaction({
  network: Networks.polygon,
  to: '0x1111111111111111111111111111111111111111',
  value: parseUnits('0.001', 18),
  waitForStatus: false,
})

const status = await oms.wallet.getTransactionStatus({ txnId: tx.txnId })
```

To tune polling, pass `statusPolling`:

```typescript
import { parseUnits } from 'viem'

await oms.wallet.sendTransaction({
  network: Networks.polygon,
  to: '0x1111111111111111111111111111111111111111',
  value: parseUnits('0.001', 18),
  statusPolling: {
    timeoutMs: 30_000,
    intervalMs: 1_000,
  },
})
```

If WaaS returns fee options, pass a selector to choose one. The selector receives
fee options enriched with the current wallet balance for each token when
available. Use `FeeOptionSelector.firstAvailable` to choose the first option the
wallet can pay, or return `option.selection` from a custom selector.

```typescript
const tx = await oms.wallet.sendTransaction({
  network: Networks.polygon,
  to: '0x3333333333333333333333333333333333333333',
  data: '0x12345678',
  selectFeeOption: async (feeOptions) => {
    const selected = feeOptions.find(option => option.feeOption.token.symbol === 'USDC')
    return selected?.selection
  },
})
```

## Configuration

### Publishable-Key Routing

`OMSClient` derives service endpoints from the publishable key. WaaS requests use the API base URL directly; indexer requests use the same base URL with `/v1/IndexerGateway/`.

| Publishable key prefix | API base URL |
|---|---|
| `pk_dev_sdbx_` | `https://sandbox-api.dev.polygon-dev.technology` |
| `pk_dev_live_` | `https://api.dev.polygon-dev.technology` |
| `pk_stg_sdbx_` | `https://sandbox-api.stg.polygon-dev.technology` |
| `pk_stg_live_` | `https://api.stg.polygon-dev.technology` |
| `pk_sdbx_` | `https://sandbox-api.polygon.technology` |
| `pk_live_` | `https://api.polygon.technology` |

### Custom OIDC Providers

```typescript
const oms = new OMSClient({
  publishableKey: 'your-publishable-key',
  auth: {
    oidcProviders: {
      custom: {
        clientId: 'custom-client-id',
        issuer: 'https://issuer.example',
        authorizationUrl: 'https://issuer.example/oauth/authorize',
        scopes: ['openid', 'email', 'profile'],
      },
    },
  },
})
```

Provider configs are the source of truth for OIDC scopes. If `scopes` is omitted or empty, the SDK does not send a `scope` authorization parameter. OIDC auth mode defaults to PKCE; pass `authMode` when a provider needs a different WaaS auth-code mode.

### Custom Storage and Signing

The default storage backend is browser `localStorage` when available, otherwise in-memory storage for wallet metadata only. The default browser signer stores its non-extractable key reference separately through WebCrypto-compatible browser storage. Provide a custom `StorageManager` for persistent Node.js, React Native, or testing sessions:

```typescript
import { MemoryStorageManager, OMSClient } from '@0xsequence/typescript-sdk'

const oms = new OMSClient({
  publishableKey: 'your-publishable-key',
  storage: new MemoryStorageManager(),
})
```

OIDC redirect auth uses separate transient storage for verifier/state data. In browsers it defaults to `sessionStorage`; pass `redirectAuthStorage` to override it. Final wallet session metadata continues to use the configured `storage`.

## More Examples

### Sign and Validate Message

```typescript
const signature = await oms.wallet.signMessage({
  network: Networks.polygon,
  message: 'some message to sign',
})

const isValid = await oms.wallet.isValidMessageSignature({
  network: Networks.polygon,
  walletAddress: oms.wallet.walletAddress,
  message: 'some message to sign',
  signature,
})
```

### Sign and Validate Typed Data

```typescript
const signature = await oms.wallet.signTypedData({
  network: Networks.polygon,
  typedData,
})

const isValid = await oms.wallet.isValidTypedDataSignature({
  network: Networks.polygon,
  walletAddress: oms.wallet.walletAddress,
  typedData,
  signature,
})
```

### Call a Contract (method string + args)

```typescript
import { parseUnits } from 'viem'

const tx = await oms.wallet.callContract({
  network: Networks.polygon,
  contractAddress: '0x3333333333333333333333333333333333333333',
  method: 'transfer(address,uint256)',
  args: [
    { type: 'address', value: '0x1111111111111111111111111111111111111111' },
    { type: 'uint256', value: parseUnits('1', 18).toString() },
  ],
})
```

### Query Balances

```typescript
const { walletAddress } = oms.wallet
if (!walletAddress) throw new Error('No active wallet session')

const result = await oms.indexer.getBalances({
  networks: [Networks.polygon],
  walletAddress,
  includeMetadata: true,
})

for (const b of result.nativeBalances) {
  console.log(b.symbol, b.balance)
}

for (const b of result.balances) {
  console.log(b.contractInfo?.symbol, b.balance, b.contractInfo?.decimals)
}
```

Pass `contractAddresses` to filter balances to specific token contracts. Omit `networks` to query mainnets by default, or pass `networkType: 'TESTNETS'` / `'ALL'`. With `includeMetadata: true`, ERC-20 decimals are available as `contractInfo.decimals`. The response is paginated; pass `page` when requesting later pages.

### Manage Access

```typescript
const grants = await oms.wallet.listAccess()

for (const grant of grants) {
  console.log(grant.credentialId, grant.expiresAt, grant.isCaller)
}

for await (const page of oms.wallet.listAccessPages({ pageSize: 25 })) {
  console.log('Page:', page.grants)
}

await oms.wallet.revokeAccess({ targetCredentialId: grants[0].credentialId })
```

## API Reference

See [API.md](./API.md) for the full method and type reference.

## Publishing

See [PUBLISHING.md](./PUBLISHING.md) for release and npm publishing steps.

## Contributing

1. **Read [`AGENTS.md`](./AGENTS.md)** — covers repo layout, coding rules, and the agent workflow.
2. **Install dependencies:** `pnpm install`
3. **Verify your change:** `pnpm exec tsc --noEmit && pnpm test`
4. **Branch naming:** use plain descriptive names like `fix-login-timeout` (no `codex/` prefix).
5. **Open a PR** — the PR template will walk you through the checklist.

See [`TESTING.md`](./TESTING.md) for full testing conventions and commands.
