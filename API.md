# OMS Wallet TypeScript SDK — API Reference

## Table of Contents

- [OMSWallet](#omswallet)
  - [Constructor](#constructor)
- [WalletClient](#walletclient)
  - [walletAddress](#walletaddress)
  - [session](#session)
  - [onSessionExpired](#onsessionexpired)
  - [startEmailAuth](#startemailauth)
  - [completeEmailAuth](#completeemailauth)
  - [signInWithOidcIdToken](#signinwithoidcidtoken)
  - [startOidcRedirectAuth](#startoidcredirectauth)
  - [completeOidcRedirectAuth](#completeoidcredirectauth)
  - [signInWithOidcRedirect](#signinwithoidcredirect)
  - [signOut](#signout)
  - [listWallets](#listwallets)
  - [useWallet](#usewallet)
  - [createWallet](#createwallet)
  - [getIdToken](#getidtoken)
  - [signMessage](#signmessage)
  - [signTypedData](#signtypeddata)
  - [isValidMessageSignature](#isvalidmessagesignature)
  - [isValidTypedDataSignature](#isvalidtypeddatasignature)
  - [getTransactionStatus](#gettransactionstatus)
  - [sendTransaction](#sendtransaction)
    - [Native token transfer](#native-token-transfer)
    - [Raw data transaction](#raw-data-transaction)
    - [ABI-encoded contract call](#abi-encoded-contract-call)
  - [callContract](#callcontract)
  - [listAccess](#listaccess)
  - [listAccessPages](#listaccesspages)
  - [revokeAccess](#revokeaccess)
- [IndexerClient](#indexerclient)
  - [getBalances](#getbalances)
  - [getTransactionHistory](#gettransactionhistory)
- [Errors](#errors)
- [Types](#types)
  - [Network](#network)
  - [OMSWalletAuthConfig](#omswalletauthconfig)
  - [OidcProviderConfig](#oidcproviderconfig)
  - [OIDC Provider Helpers](#oidc-provider-helpers)
  - [Auth Method Types](#auth-method-types)
  - [StorageManager](#storagemanager)
  - [Storage Helpers](#storage-helpers)
  - [CredentialSigner](#credentialsigner)
  - [Credential Signing Helpers](#credential-signing-helpers)
  - [Session Listener Types](#session-listener-types)
  - [Signing and Validation Method Types](#signing-and-validation-method-types)
  - [WalletAccount](#walletaccount)
  - [PendingWalletSelection](#pendingwalletselection)
  - [WalletSelectionBehavior](#walletselectionbehavior)
  - [WalletCredential](#walletcredential)
  - [AccessGrant](#accessgrant)
  - [ListAccessParams](#listaccessparams)
  - [AccessGrantPage](#accessgrantpage)
  - [WalletActivationResult](#walletactivationresult)
  - [Native Transaction Parameters](#native-transaction-parameters)
  - [Raw Data Transaction Parameters](#raw-data-transaction-parameters)
  - [ABI-Encoded Transaction Parameters](#abi-encoded-transaction-parameters)
  - [SendTransactionResponse](#sendtransactionresponse)
  - [TransactionStatusResponse](#transactionstatusresponse)
  - [TransactionStatusPollingOptions](#transactionstatuspollingoptions)
  - [TransactionMode](#transactionmode)
  - [TransactionStatus](#transactionstatus)
  - [FeeOptionSelector](#feeoptionselector)
  - [FeeOption](#feeoption)
  - [FeeOptionSelection](#feeoptionselection)
  - [FeeOptionWithBalance](#feeoptionwithbalance)
  - [GetBalancesParams](#getbalancesparams)
  - [GetTransactionHistoryParams](#gettransactionhistoryparams)
  - [IndexerNetworkType](#indexernetworktype)
  - [ContractVerificationStatus](#contractverificationstatus)
  - [MetadataOptions](#metadataoptions)
  - [SortBy](#sortby)
  - [BalancesResult](#balancesresult)
  - [TransactionHistoryResult](#transactionhistoryresult)
  - [Transaction](#transaction)
  - [TransactionTransfer](#transactiontransfer)
  - [TokenBalancesPage](#tokenbalancespage)
  - [TokenBalance](#tokenbalance)
  - [TokenContractInfo](#tokencontractinfo)
  - [TokenMetadata](#tokenmetadata)
  - [TokenMetadataAsset](#tokenmetadataasset)
  - [Contract Call Arguments](#contract-call-arguments)
  - [AuthMode](#authmode)
  - [WalletType](#wallettype)

---

## OMSWallet

The top-level entry point for the SDK.

```typescript
import { OMSWallet } from '@polygonlabs/oms-wallet'

const omsWallet = new OMSWallet({
  publishableKey: 'your-publishable-key',
})
```

### Constructor

```typescript
new OMSWallet(params: {
  publishableKey: string
  auth?: OMSWalletAuthConfig
  storage?: StorageManager
  redirectAuthStorage?: StorageManager
  credentialSigner?: CredentialSigner
})
```

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `publishableKey` | `string` | Yes | Your OMS publishable key. |
| `auth` | `OMSWalletAuthConfig` | No | OIDC provider configuration. Defaults to the built-in Google and Apple providers. |
| `storage` | `StorageManager` | No | Storage backend for wallet metadata. Defaults to `LocalStorageManager` when browser `localStorage` is available, otherwise `MemoryStorageManager`. |
| `redirectAuthStorage` | `StorageManager` | No | Transient storage for OIDC redirect auth state. Defaults to `sessionStorage` when available. |
| `credentialSigner` | `CredentialSigner` | No | Request credential signer. Defaults to a non-extractable WebCrypto P-256 signer (`ecdsa-p256-sha256`) where WebCrypto is available. |

**Properties**

| Name | Type | Description |
|---|---|---|
| `wallet` | `WalletClient` | Handles authentication, signing, and transactions. |
| `indexer` | `IndexerClient` | Queries on-chain state and token balances. |

## WalletClient

Accessed via `omsWallet.wallet`. Manages the full wallet lifecycle: authentication, session persistence, signing, and transaction submission.

### walletAddress

```typescript
walletAddress: Address | undefined
```

The on-chain address of the active wallet (`Address` is the viem/abitype hex address type). Undefined until email or OIDC auth completes successfully, or a persisted session is restored.

### session

```typescript
interface OMSWalletEmailSessionAuth {
  readonly type: 'email'
  readonly email: string | undefined
}

type OMSWalletOidcSessionAuthFlow = 'redirect' | 'id-token'

interface OMSWalletOidcSessionAuth {
  readonly type: 'oidc'
  readonly flow: OMSWalletOidcSessionAuthFlow
  readonly issuer: string
  readonly provider: string | undefined
  readonly providerLabel: string | undefined
  readonly email: string | undefined
}

type OMSWalletSessionAuth =
  | OMSWalletEmailSessionAuth
  | OMSWalletOidcSessionAuth

interface OMSWalletSessionState {
  readonly walletAddress: Address | undefined
  readonly expiresAt: string | undefined
  readonly auth: OMSWalletSessionAuth | undefined
}

interface OMSWalletSessionExpiredEvent {
  readonly session: OMSWalletSessionState
  readonly expiredAt: string
}

wallet.session: OMSWalletSessionState
```

Completed wallet sessions persist `walletAddress`, credential expiry, and structured auth metadata in the configured `storage`. Pending email OTP and OIDC redirect state are not exposed through `session`; use the auth method results to drive pending UI.

OIDC redirect auth stores `flow: 'redirect'`. OIDC ID-token auth stores `flow: 'id-token'`. Session values returned by `wallet.session` and `wallet.onSessionExpired` are readonly snapshots; mutating them does not update SDK state or storage.

Expired sessions are made inactive before protected wallet operations and throw `OMSWalletSessionError` with code `OMS_SESSION_EXPIRED`. The SDK clears the active signer/session state, but keeps the expired session metadata in storage until the app explicitly starts a new auth flow or calls `signOut()`. Use `wallet.onSessionExpired` to update app state or route back to sign-in; the event includes the expired session snapshot so apps can reuse `session.auth.email` for email OTP reauth or provider-specific account hints, including Google `loginHint`, after a page refresh.

### onSessionExpired

```typescript
const unsubscribe = wallet.onSessionExpired((event) => {
  showReauth(event.session)
})
```

Registers a listener for expired wallet sessions and returns an unsubscribe function. Calling `unsubscribe()` removes that listener from future expiry notifications. The wallet client stores the latest expired-session event and replays it to each new listener until a new auth flow, new wallet session, or `signOut()` clears it.

---

### startEmailAuth

```typescript
startEmailAuth(params: { email: string }): Promise<void>
```

Sends a one-time passcode to the provided email address to begin authentication. If a wallet session is already active, it is cleared before the new auth attempt starts.

After this resolves, display an OTP input and pass the code to [`completeEmailAuth`](#completeemailauth).

**Parameters**

| Name | Type | Description |
|---|---|---|
| `email` | `string` | The email address to send the one-time passcode to. |

**Returns** `Promise<void>`

**Throws** if the network request fails or the email is invalid.

**Example**

```typescript
await omsWallet.wallet.startEmailAuth({ email: 'user@example.com' })
```

---

### completeEmailAuth

```typescript
completeEmailAuth(params: {
  code: string
  walletType?: WalletType
  walletSelection?: 'automatic' | 'manual'
  sessionLifetimeSeconds?: number
}): Promise<
  | { readonly walletAddress: Address; readonly wallet: WalletAccount; readonly wallets: ReadonlyArray<WalletAccount>; readonly credential: Readonly<WalletCredential> }
  | PendingWalletSelection
>
```

Verifies the OTP code and activates a wallet. Must be called after [`startEmailAuth`](#startemailauth).

This method verifies the code with a one-week session lifetime by default, loads all wallet pages, then automatically selects an existing wallet matching `walletType`, or creates a new one if none exists. Wallet metadata is persisted to storage. Pass `sessionLifetimeSeconds` to request a shorter or longer session lifetime, from `1` through `2592000` seconds (30 days). Pass `walletSelection: 'manual'` to return a [`PendingWalletSelection`](#pendingwalletselection) bound to the verified auth flow; complete selection through that object.

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `code` | `string` | Yes | The one-time passcode entered by the user. |
| `walletType` | `WalletType` | No | The wallet type to load or create. Defaults to `WalletType.Ethereum`. |
| `walletSelection` | `'automatic' \| 'manual'` | No | Defaults to `'automatic'`. Set to `'manual'` to let the app choose an existing wallet or create one through the returned pending selection. |
| `sessionLifetimeSeconds` | `number` | No | Requested session lifetime in seconds, from `1` through `2592000` (30 days). Defaults to one week. |

**Returns** `Promise<{ readonly walletAddress: Address; readonly wallet: WalletAccount; readonly wallets: ReadonlyArray<WalletAccount>; readonly credential: Readonly<WalletCredential> }>` by default, or `Promise<PendingWalletSelection>` when `walletSelection` is `'manual'`.

**Throws** if the code is incorrect, expired, or the network request fails.

**Example**

```typescript
try {
  const { walletAddress, credential } = await omsWallet.wallet.completeEmailAuth({ code: '123456' })
  console.log('Wallet ready:', walletAddress, credential.credentialId)
} catch (err) {
  // Handle wrong or expired code
}
```

Manual selection:

```typescript
const selection = await omsWallet.wallet.completeEmailAuth({
  code: '123456',
  walletType: WalletType.Ethereum,
  walletSelection: 'manual',
})

await selection.selectWallet({ walletId: selection.wallets[0].id })
// or:
await selection.createAndSelectWallet({ reference: 'main' })
```

---

### signInWithOidcIdToken

```typescript
signInWithOidcIdToken(params: {
  idToken: string
  issuer: string
  audience: string
  walletType?: WalletType
  walletSelection?: 'automatic' | 'manual'
  sessionLifetimeSeconds?: number
  provider?: string
  providerLabel?: string
}): Promise<
  | { readonly walletAddress: Address; readonly wallet: WalletAccount; readonly wallets: ReadonlyArray<WalletAccount>; readonly credential: Readonly<WalletCredential> }
  | PendingWalletSelection
>
```

Signs in with an OIDC ID token that your app already obtained from an identity provider, such as Google Identity Services, Firebase, Auth0, Cognito, Clerk, or a server/device-code flow. The SDK does not fetch provider tokens. Pass the token plus the `issuer` and `audience` used to mint it; WaaS validates the token during auth completion.

The SDK reads the token `exp` claim, commits a WaaS `id-token` verifier, completes auth with the token, then loads or creates a wallet using the same wallet-selection behavior as email auth. Pass `provider` and `providerLabel` when you want custom session metadata for non-built-in identity providers. When omitted, Google and Apple are derived from the issuer and custom issuers leave those fields `undefined`.

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `idToken` | `string` | Yes | Provider-issued OIDC ID token. |
| `issuer` | `string` | Yes | Expected token issuer, such as `https://accounts.google.com`. |
| `audience` | `string` | Yes | Expected token audience/client ID. |
| `walletType` | `WalletType` | No | The wallet type to load or create. Defaults to `WalletType.Ethereum`. |
| `walletSelection` | `'automatic' \| 'manual'` | No | Defaults to `'automatic'`. Set to `'manual'` to let the app choose an existing wallet or create one through the returned pending selection. |
| `sessionLifetimeSeconds` | `number` | No | Requested session lifetime in seconds, from `1` through `2592000` (30 days). Defaults to one week. |
| `provider` | `string` | No | Stable app-facing provider key stored in `session.auth.provider`. |
| `providerLabel` | `string` | No | Display label stored in `session.auth.providerLabel`. |

```typescript
const result = await omsWallet.wallet.signInWithOidcIdToken({
  idToken: googleIdToken,
  issuer: 'https://accounts.google.com',
  audience: 'YOUR_WEB_CLIENT_ID',
})

if ('walletAddress' in result) {
  console.log('Wallet ready:', result.walletAddress)
}
```

Manual selection:

```typescript
const selection = await omsWallet.wallet.signInWithOidcIdToken({
  idToken,
  issuer: 'https://idp.example',
  audience: 'custom-client-id',
  provider: 'enterprise',
  providerLabel: 'Enterprise SSO',
  walletSelection: 'manual',
})

await selection.selectWallet({ walletId: selection.wallets[0].id })
```

---

### startOidcRedirectAuth

```typescript
startOidcRedirectAuth(params: {
  provider: string | OidcProviderConfig
  omsRelayReturnUri?: string
  walletType?: WalletType
  walletSelection?: 'automatic' | 'manual'
  sessionLifetimeSeconds?: number
  authorizeParams?: Record<string, string>
  loginHint?: string
}): Promise<{ authorizationUrl: string; state: string; challenge: string }>
```

Starts an OIDC authorization-code redirect flow and returns the provider authorization URL. If a wallet session is already active, it is cleared before the new auth attempt starts. The SDK stores transient redirect auth state so the callback can complete after a full-page redirect with the same credential signer, credential id, and signing algorithm.

If `provider` is a string, it must match a configured `auth.oidcProviders` key. Passing an `OidcProviderConfig` object directly is also supported.

Custom OIDC providers must configure `providerRedirectUri`. That value is sent to the provider as OAuth/OIDC `redirect_uri`, and the callback must arrive at the same scheme, authority, and path. Custom providers do not use `omsRelayReturnUri`.

For SDK built-in Google and Apple providers, the SDK sends the provider to the OMS relay callback URL. `omsRelayReturnUri` is the URL where the OMS relay returns the user after that callback. In browser environments, `omsRelayReturnUri` defaults to the current page URL without query or hash. Outside a browser, pass `omsRelayReturnUri`.

Pass `walletSelection` or `sessionLifetimeSeconds` at start to store completion preferences in the pending redirect state. `sessionLifetimeSeconds` must be from `1` through `2592000` seconds (30 days). `completeOidcRedirectAuth` uses those stored values after the provider redirects back unless completion params override them.

Pass `loginHint` for Google redirect flows to set the Google `login_hint` authorization parameter, which can prefill or select the expected account. The SDK only sends `login_hint` for providers whose issuer is `https://accounts.google.com`. If omitted, the SDK falls back to the previous active session email when one exists before the redirect auth attempt starts. After `signOut()`, that previous session email is cleared. To force no `login_hint` for a call, pass `loginHint: ''`.

```typescript
const { authorizationUrl } = await omsWallet.wallet.startOidcRedirectAuth({
  provider: 'google',
  omsRelayReturnUri: `${window.location.origin}/auth/callback`,
})

window.location.assign(authorizationUrl)
```

---

### completeOidcRedirectAuth

```typescript
completeOidcRedirectAuth(params: {
  callbackUrl?: string
  cleanUrl?: boolean
  replaceUrl?: (url: string) => void
  walletSelection?: 'automatic' | 'manual'
  sessionLifetimeSeconds?: number
} = {}): Promise<
  | { readonly walletAddress: Address; readonly wallet: WalletAccount; readonly wallets: ReadonlyArray<WalletAccount>; readonly credential: Readonly<WalletCredential> }
  | PendingWalletSelection
  | void
>
```

Completes an OIDC redirect flow by validating the callback, completing auth with a one-week session lifetime by default, and activating an existing wallet or creating one. Completion must run with the same credential signer, credential id, and signing algorithm that started the redirect. In browser environments, `callbackUrl` defaults to `window.location.href`; if the current URL has no OIDC callback params, the method returns `undefined` without requiring pending redirect storage.

Pass `sessionLifetimeSeconds` to request a shorter or longer session lifetime, from `1` through `2592000` seconds (30 days). Pass `walletSelection: 'manual'` to return a [`PendingWalletSelection`](#pendingwalletselection) for app-driven wallet selection. If omitted, completion uses values stored by `startOidcRedirectAuth` or `signInWithOidcRedirect`, then falls back to automatic wallet selection and the default one-week lifetime.

When `callbackUrl` is omitted, OAuth query parameters are cleaned by default. Explicit `callbackUrl` calls clean only when `cleanUrl: true`; outside a browser, pass `replaceUrl` when cleaning.

```typescript
const result = await omsWallet.wallet.completeOidcRedirectAuth()
if (result) {
  console.log(result.walletAddress)
}
```

---

### signInWithOidcRedirect

```typescript
signInWithOidcRedirect(params: {
  provider: string | OidcProviderConfig
  omsRelayReturnUri?: string
  walletType?: WalletType
  walletSelection?: 'automatic' | 'manual'
  authorizeParams?: Record<string, string>
  loginHint?: string
  sessionLifetimeSeconds?: number
  currentUrl?: string
  assignUrl?: (url: string) => void
}): Promise<void>
```

Browser convenience method for regular web apps. It starts OIDC redirect auth, stores pending redirect state, redirects with `window.location.assign`, and returns `void`. Use [`completeOidcRedirectAuth`](#completeoidcredirectauth) on the callback page to finish auth.

For SDK built-in Google and Apple providers, `omsRelayReturnUri` defaults to the current page URL without query or hash. Pass `currentUrl` to derive that value from a specific URL, and pass `assignUrl` outside a browser or when testing. Custom providers use their configured `providerRedirectUri` directly. `walletSelection` and `sessionLifetimeSeconds` are stored with the pending redirect state and used by `completeOidcRedirectAuth` after the provider redirects back. `sessionLifetimeSeconds` must be from `1` through `2592000` seconds (30 days).

```typescript
void omsWallet.wallet.signInWithOidcRedirect({ provider: 'google' })
void omsWallet.wallet.signInWithOidcRedirect({ provider: 'apple' })

const result = await omsWallet.wallet.completeOidcRedirectAuth()
if (result) {
  console.log(result.walletAddress)
}
```

---

### signOut

```typescript
signOut(): Promise<void>
```

Clears the wallet session metadata from storage and clears the active credential signer where supported. After calling this, `walletAddress` and `session` metadata are no longer available and the user must authenticate again through email auth or OIDC redirect auth.

**Returns** `Promise<void>`

**Example**

```typescript
await omsWallet.wallet.signOut()
```

---

### listWallets

```typescript
listWallets(): Promise<WalletAccount[]>
```

Returns all wallets available to an authenticated active or pending wallet-selection session.

---

### useWallet

```typescript
useWallet(params: { walletId: string }): Promise<{ walletAddress: Address; wallet: WalletAccount }>
```

Activates an existing wallet by server-side wallet id and persists it as the current wallet session. Requires an active wallet session; pending manual auth flows must use [`PendingWalletSelection.selectWallet`](#pendingwalletselection).

---

### createWallet

```typescript
createWallet(params?: { type?: WalletType; reference?: string }): Promise<{ walletAddress: Address; wallet: WalletAccount }>
```

Creates a new wallet, activates it, and persists it as the current wallet session. Requires an active wallet session. `type` defaults to `WalletType.Ethereum`. Pending manual auth flows must use [`PendingWalletSelection.createAndSelectWallet`](#pendingwalletselection), which uses the auth-requested wallet type automatically.

---

### getIdToken

```typescript
getIdToken(params?: {
  ttlSeconds?: number
  customClaims?: Record<string, unknown>
}): Promise<string>
```

Requests an ID token for the active wallet session. The SDK uses the active wallet id automatically.

**Parameters**

| Name | Type | Description |
|---|---|---|
| `ttlSeconds` | `number` | Optional token lifetime in seconds. |
| `customClaims` | `Record<string, unknown>` | Optional custom claims to include in the token. |

**Returns** `Promise<string>` — the issued ID token.

---

### signMessage

```typescript
signMessage(params: {
  network: Network
  message: string
}): Promise<string>
```

Signs an arbitrary message using the active wallet session credential.

**Parameters**

| Name | Type | Description |
|---|---|---|
| `network` | `Network` | The network for the signing context. Use an exported registry value such as `Networks.polygon`. See [Network](#network). |
| `message` | `string` | The message to sign. |

**Returns** `Promise<string>` — a hex-encoded signature.

**Example**

```typescript
import { Networks } from '@polygonlabs/oms-wallet'
const sigFromNetwork = await omsWallet.wallet.signMessage({ network: Networks.polygon, message: 'some message to sign' })
```

---

### signTypedData

```typescript
signTypedData(params: {
  network: Network
  typedData: unknown
}): Promise<string>
```

Signs EIP-712 typed data using the active wallet session credential.

**Returns** `Promise<string>` — a hex-encoded signature.

---

### isValidMessageSignature

```typescript
isValidMessageSignature(params: {
  network?: Network
  walletAddress?: Address
  walletId?: string
  message: string
  signature: string
}): Promise<boolean>
```

Validates a message signature. If neither `walletAddress` nor `walletId` is provided, the active wallet session id is used when available.

---

### isValidTypedDataSignature

```typescript
isValidTypedDataSignature(params: {
  network?: Network
  walletAddress?: Address
  walletId?: string
  typedData: unknown
  signature: string
}): Promise<boolean>
```

Validates an EIP-712 typed data signature. If neither `walletAddress` nor `walletId` is provided, the active wallet session id is used when available.

---

### getTransactionStatus

```typescript
getTransactionStatus(params: { txnId: string }): Promise<TransactionStatusResponse>
```

Fetches the latest status for a prepared/executed transaction. This is useful after calling [`sendTransaction`](#sendtransaction) with `waitForStatus: false`.

---

### sendTransaction

`sendTransaction` is overloaded with three signatures depending on the type of transaction.

#### Native Token Transfer

```typescript
sendTransaction(params: {
  network: Network
  to: Address
  value: bigint
  mode?: TransactionMode
  selectFeeOption?: FeeOptionSelector
  waitForStatus?: boolean
  statusPolling?: TransactionStatusPollingOptions
}): Promise<SendTransactionResponse>
```

Sends native tokens (ETH, POL, etc.) to an address.

```typescript
import { parseUnits } from 'viem'

const tx = await omsWallet.wallet.sendTransaction({
  network: Networks.polygon,
  to: '0x1111111111111111111111111111111111111111',
  value: parseUnits('1', 18), // 1 POL
})
```

#### Raw Data Transaction

```typescript
sendTransaction(params: {
  network: Network
  to: Address
  data: Hex
  value?: bigint
  mode?: TransactionMode
  selectFeeOption?: FeeOptionSelector
  waitForStatus?: boolean
  statusPolling?: TransactionStatusPollingOptions
}): Promise<SendTransactionResponse>
```

Sends a transaction with arbitrary calldata as a hex string. Use this when you have pre-encoded calldata.

```typescript
const tx = await omsWallet.wallet.sendTransaction({
  network: Networks.polygon,
  to: '0x2222222222222222222222222222222222222222',
  data: '0x12345678',
})
```

#### ABI-Encoded Contract Call

```typescript
sendTransaction(params: {
  network: Network
  to: Address
  abi: Abi | readonly unknown[]
  functionName: string
  args?: unknown[]
  value?: bigint
  mode?: TransactionMode
  selectFeeOption?: FeeOptionSelector
  waitForStatus?: boolean
  statusPolling?: TransactionStatusPollingOptions
}): Promise<SendTransactionResponse>
```

Sends a contract interaction with ABI encoding via viem. The calldata is encoded automatically from `abi`, `functionName`, and `args`. When `abi` is passed as a const ABI, TypeScript narrows valid `functionName` values and infers `args`.

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
  network: Networks.polygon,
  to: '0x3333333333333333333333333333333333333333',
  abi: erc20Abi,
  functionName: 'transfer',
  args: ['0x1111111111111111111111111111111111111111', parseUnits('1', 18)],
})
```

The transaction variants share these common fields. `value` is required for native token transfers and optional for raw-data and ABI-encoded contract calls.

| Name | Type | Description |
|---|---|---|
| `value` | `bigint` | Native token value to attach (in wei). |
| `mode` | `TransactionMode` | Transaction execution mode. Defaults to `TransactionMode.Relayer`. |
| `selectFeeOption` | `FeeOptionSelector` | Optional callback for choosing a fee option. |
| `waitForStatus` | `boolean` | Set to `false` to return immediately after execute without polling transaction status. |
| `statusPolling` | `TransactionStatusPollingOptions` | Optional post-execute polling configuration. |

**Returns** `Promise<SendTransactionResponse>` — the prepared transaction ID, latest status, and transaction hash when available.

**Throws** if no session is active, local validation or fee selection fails, or a prepare/execute/status request fails. On-chain failed transaction statuses are returned as transaction status responses.

When fee options are returned, `selectFeeOption` receives `FeeOptionWithBalance[]`.
Each entry includes the `FeeOption` plus the selected wallet's balance
for that fee token when the indexer can load it. Use
`FeeOptionSelector.firstAvailable` to choose the first option the wallet can pay,
or return `option.selection` from a custom selector.

---

### callContract

```typescript
callContract(params: {
  network: Network
  contractAddress: Address
  method: string
  args?: Array<{ type: string; value: unknown }>
  mode?: TransactionMode
  selectFeeOption?: FeeOptionSelector
  waitForStatus?: boolean
  statusPolling?: TransactionStatusPollingOptions
}): Promise<SendTransactionResponse>
```

Calls a state-changing smart contract function using a method signature string and loosely-typed argument list. For fully-typed ABI encoding, prefer the ABI overload of [`sendTransaction`](#abi-encoded-contract-call).

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `network` | `Network` | Yes | Network identifier. See [Network](#network). |
| `contractAddress` | `Address` | Yes | Address of the target contract. |
| `method` | `string` | Yes | ABI function signature, e.g. `"transfer(address,uint256)"`. |
| `args` | `Array<{ type: string; value: unknown }>` | No | Ordered list of typed arguments. See [Contract Call Arguments](#contract-call-arguments). |
| `mode` | `TransactionMode` | No | Transaction execution mode. Defaults to `TransactionMode.Relayer`. |
| `selectFeeOption` | `FeeOptionSelector` | No | Optional callback for choosing a fee option. |
| `waitForStatus` | `boolean` | No | Set to `false` to return immediately after execute without polling transaction status. |
| `statusPolling` | `TransactionStatusPollingOptions` | No | Optional post-execute polling configuration. |

**Returns** `Promise<SendTransactionResponse>` — the prepared transaction ID, latest status, and transaction hash when available.

**Example**

```typescript
import { parseUnits } from 'viem'

const tx = await omsWallet.wallet.callContract({
  network: Networks.polygon,
  contractAddress: '0x3333333333333333333333333333333333333333',
  method: 'transfer(address,uint256)',
  args: [
    { type: 'address', value: '0x1111111111111111111111111111111111111111' },
    { type: 'uint256', value: parseUnits('1', 18).toString() },
  ],
})
```

---

### listAccess

```typescript
listAccess(params?: ListAccessParams): Promise<AccessGrant[]>
```

Returns all credentials that currently have access to this wallet across all pages.

**Returns** `Promise<AccessGrant[]>` — see [AccessGrant](#accessgrant).

**Example**

```typescript
const grants = await omsWallet.wallet.listAccess()
console.log(grants.filter(g => g.isCaller)) // current session
```

---

### listAccessPages

```typescript
listAccessPages(params?: ListAccessParams): AsyncIterable<AccessGrantPage>
```

Yields credential pages for callers that want page-at-a-time rendering or explicit backpressure.

**Example**

```typescript
for await (const page of omsWallet.wallet.listAccessPages({ pageSize: 25 })) {
  console.log(page.grants)
}
```

---

### revokeAccess

```typescript
revokeAccess(params: { targetCredentialId: string }): Promise<void>
```

Permanently revokes a credential's access to this wallet. Cannot be undone.

**Parameters**

| Name | Type | Description |
|---|---|---|
| `targetCredentialId` | `string` | The ID of the credential to revoke. Obtain from [`listAccess`](#listaccess). |

**Example**

```typescript
const grants = await omsWallet.wallet.listAccess()
const other = grants.find(g => !g.isCaller)
if (other) {
  await omsWallet.wallet.revokeAccess({ targetCredentialId: other.credentialId })
}
```

---

## IndexerClient

Accessed via `omsWallet.indexer`. Queries on-chain balances and transaction history.

### getBalances

```typescript
getBalances(params: {
  walletAddress: string
  networks?: Network[]
  networkType?: 'MAINNETS' | 'TESTNETS' | 'ALL'
  contractAddresses?: string[]
  includeMetadata?: boolean
  omitPrices?: boolean
  tokenIds?: string[]
  contractStatus?: ContractVerificationStatus
  page?: TokenBalancesPage
}): Promise<BalancesResult>
```

Fetches native and token balances for a wallet. Pass `networks` to query explicit SDK network objects. If `networks` is omitted, the request defaults to `networkType: 'MAINNETS'`. The default request returns page `0` with up to `40` entries. `includeMetadata` defaults to `true`; token display data is returned on `contractInfo` and `tokenMetadata`, and ERC-20 decimals are available as `contractInfo.decimals`.

**Parameters**

| Name | Type | Description |
|---|---|---|
| `walletAddress` | `string` | The wallet address whose balances to fetch. Use `omsWallet.wallet.walletAddress` after checking it is defined. |
| `networks` | `Network[]` | Optional explicit networks to query. Use exported registry values such as `Networks.polygon`. |
| `networkType` | `'MAINNETS' \| 'TESTNETS' \| 'ALL'` | Optional gateway network group when `networks` is omitted. Defaults to `'MAINNETS'`. |
| `contractAddresses` | `string[]` | Optional token contract filter. Omit to query balances across contracts. |
| `includeMetadata` | `boolean` | Optional metadata flag. Defaults to `true`. |
| `omitPrices` | `boolean` | Optional price exclusion flag. |
| `tokenIds` | `string[]` | Optional token ID filter. |
| `contractStatus` | `ContractVerificationStatus` | Optional contract verification filter. |
| `page` | `TokenBalancesPage` | Optional pagination request. Defaults to `{ page: 0, pageSize: 40 }`. |

**Returns** `Promise<BalancesResult>` — see [BalancesResult](#balancesresult).

**Example**

```typescript
const { walletAddress } = omsWallet.wallet
if (!walletAddress) throw new Error('No active wallet session')

const result = await omsWallet.indexer.getBalances({
  networks: [Networks.polygon],
  walletAddress,
  includeMetadata: true,
})

for (const b of result.nativeBalances) {
  console.log(b.symbol, b.balance)
}

for (const b of result.balances) {
  console.log(b.contractAddress, b.balance, b.tokenId)
}
```

---

### getTransactionHistory

```typescript
getTransactionHistory(params: {
  walletAddress: string
  networks?: Network[]
  networkType?: 'MAINNETS' | 'TESTNETS' | 'ALL'
  contractAddresses?: string[]
  transactionHashes?: string[]
  metaTransactionIds?: string[]
  fromBlock?: number
  toBlock?: number
  tokenId?: string
  includeMetadata?: boolean
  omitPrices?: boolean
  metadataOptions?: MetadataOptions
  page?: TokenBalancesPage
}): Promise<TransactionHistoryResult>
```

Fetches mined transaction history for a wallet. Pass `networks` to query explicit SDK network objects. If `networks` is omitted, the request defaults to `networkType: 'MAINNETS'`. `includeMetadata` defaults to `true`. Use `metadataOptions` to tune returned token and contract metadata.

**Parameters**

| Name | Type | Description |
|---|---|---|
| `walletAddress` | `string` | The wallet address whose transaction history to fetch. Use `omsWallet.wallet.walletAddress` after checking it is defined. |
| `networks` | `Network[]` | Optional explicit networks to query. Use exported registry values such as `Networks.polygon`. |
| `networkType` | `'MAINNETS' \| 'TESTNETS' \| 'ALL'` | Optional network group when `networks` is omitted. Defaults to `'MAINNETS'`. |
| `contractAddresses` | `string[]` | Optional token contract filter. |
| `transactionHashes` | `string[]` | Optional transaction hash filter. |
| `metaTransactionIds` | `string[]` | Optional meta-transaction ID filter. |
| `fromBlock` | `number` | Optional starting block number. |
| `toBlock` | `number` | Optional ending block number. |
| `tokenId` | `string` | Optional token ID filter. |
| `includeMetadata` | `boolean` | Optional metadata flag. Defaults to `true`. |
| `omitPrices` | `boolean` | Optional price exclusion flag. |
| `metadataOptions` | `MetadataOptions` | Optional metadata enrichment filters. See [MetadataOptions](#metadataoptions). |
| `page` | `TokenBalancesPage` | Optional pagination request. |

**Returns** `Promise<TransactionHistoryResult>` — see [TransactionHistoryResult](#transactionhistoryresult).

---

## Errors

Public methods throw `OMSWalletError` subclasses for SDK-level failures.

```typescript
class OMSWalletError extends Error {
  code: OMSWalletErrorCode
  operation?: string
  status?: number
  txnId?: string
  retryable?: boolean
  upstreamError?: OMSWalletUpstreamError
  cause?: unknown
}
```

```typescript
interface OMSWalletUpstreamError {
  service: 'waas' | 'indexer'
  name?: string
  code?: number | string
  message?: string
  status?: number
}
```

```typescript
type OMSWalletErrorCode =
  | 'OMS_HTTP_ERROR'
  | 'OMS_INVALID_RESPONSE'
  | 'OMS_REQUEST_FAILED'
  | 'OMS_AUTH_COMMITMENT_CONSUMED'
  | 'OMS_SESSION_MISSING'
  | 'OMS_SESSION_EXPIRED'
  | 'OMS_WALLET_SELECTION_STALE'
  | 'OMS_WALLET_SELECTION_UNAVAILABLE'
  | 'OMS_WALLET_SELECTION_IN_FLIGHT'
  | 'OMS_TRANSACTION_EXECUTION_UNCONFIRMED'
  | 'OMS_TRANSACTION_STATUS_LOOKUP_FAILED'
  | 'OMS_VALIDATION_ERROR'
  | 'OMS_STORAGE_ERROR'
```

`OMS_AUTH_COMMITMENT_CONSUMED` means the OTP/OIDC auth commitment has already been used. Restart the auth flow before retrying.

`OMS_TRANSACTION_EXECUTION_UNCONFIRMED` means transaction preparation succeeded, but the execute request failed before the SDK could confirm whether the transaction was submitted. The error includes `txnId` when available; do not blindly resend the same write solely because the upstream failure looked temporary.

`OMS_TRANSACTION_STATUS_LOOKUP_FAILED` means the transaction was submitted, but post-submit status polling failed. The error includes `txnId` and is retryable by checking status again with `getTransactionStatus`.

`upstreamError` is normalized diagnostic detail from a remote OMS service response or transport failure. Use the SDK-level `code` for application branching; use `upstreamError` for logging and service-specific troubleshooting.

`retryable` describes the failed SDK operation, not the whole user intent. For example, a retryable transaction status lookup failure means retry `getTransactionStatus`; it does not mean blindly resend the original transaction write.

| Class | Typical use |
|---|---|
| `OMSWalletSessionError` | Missing, expired, or stale wallet session. |
| `OMSWalletRequestError` | Network, fetch, or non-2xx HTTP failures. |
| `OMSWalletResponseError` | Invalid JSON or malformed API responses. |
| `OMSWalletTransactionError` | Transaction execution could not be confirmed or submitted transaction status polling failed; includes `txnId` when available. |
| `OMSWalletSelectionError` | Manual wallet selection is stale, invalid, or already processing an action. |
| `OMSWalletValidationError` | SDK-side validation failures before a request is sent. |
| `OMSWalletStorageError` | Local SDK storage failures, such as OIDC redirect-state persistence failures. |

Use `isOMSWalletError(err)` or `err instanceof OMSWalletError` to branch on structured error fields.

---

## Types

### Network

```typescript
interface Network {
  readonly id: number
  readonly name: string
  readonly nativeTokenSymbol: string
  readonly explorerUrl: string
  readonly displayName: string
}
```

A supported OMS network entry. The SDK exports `Networks`, `supportedNetworks`, `findNetworkById(id)`, and `findNetworkByName(name)`.
`name` is the registry/routing slug for indexer URLs, while `displayName` is the user-facing label.

```typescript
findNetworkById(id: number): Network | undefined
findNetworkByName(name: string): Network | undefined
```

| Key | id | name | displayName | nativeTokenSymbol | explorerUrl |
|---|---:|---|---|---|---|
| `Networks.mainnet` | 1 | `mainnet` | `Ethereum` | `ETH` | `https://etherscan.io` |
| `Networks.sepolia` | 11155111 | `sepolia` | `Sepolia` | `ETH` | `https://sepolia.etherscan.io` |
| `Networks.polygon` | 137 | `polygon` | `Polygon` | `POL` | `https://polygonscan.com` |
| `Networks.amoy` | 80002 | `amoy` | `Polygon Amoy` | `POL` | `https://amoy.polygonscan.com` |
| `Networks.arbitrum` | 42161 | `arbitrum` | `Arbitrum` | `ETH` | `https://arbiscan.io` |
| `Networks.arbitrumSepolia` | 421614 | `arbitrum-sepolia` | `Arbitrum Sepolia` | `ETH` | `https://sepolia.arbiscan.io` |
| `Networks.optimism` | 10 | `optimism` | `Optimism` | `ETH` | `https://optimistic.etherscan.io` |
| `Networks.optimismSepolia` | 11155420 | `optimism-sepolia` | `Optimism Sepolia` | `ETH` | `https://sepolia-optimism.etherscan.io` |
| `Networks.base` | 8453 | `base` | `Base` | `ETH` | `https://basescan.org` |
| `Networks.baseSepolia` | 84532 | `base-sepolia` | `Base Sepolia` | `ETH` | `https://sepolia.basescan.org` |
| `Networks.bsc` | 56 | `bsc` | `BSC` | `BNB` | `https://bscscan.com` |
| `Networks.bscTestnet` | 97 | `bsc-testnet` | `BSC Testnet` | `BNB` | `https://testnet.bscscan.com` |
| `Networks.arbitrumNova` | 42170 | `arbitrum-nova` | `Arbitrum Nova` | `ETH` | `https://nova.arbiscan.io` |
| `Networks.avalanche` | 43114 | `avalanche` | `Avalanche` | `AVAX` | `https://subnets.avax.network/c-chain` |
| `Networks.avalancheTestnet` | 43113 | `avalanche-testnet` | `Avalanche Testnet` | `AVAX` | `https://subnets-test.avax.network/c-chain` |
| `Networks.katana` | 747474 | `katana` | `Katana` | `ETH` | `https://katanascan.com` |

### OMSWalletAuthConfig

```typescript
interface OMSWalletAuthConfig {
  oidcProviders?: Record<string, OidcProviderConfig>
}
```

| Field | Type | Description |
|---|---|---|
| `oidcProviders` | `Record<string, OidcProviderConfig>` | OIDC provider configurations addressable by provider key. |

When `auth` is omitted, the SDK configures the built-in `google` and `apple` providers. Passing `auth` replaces the configured provider set.

Use `defineOMSWalletAuthConfig` to preserve typed custom OIDC provider keys:

```typescript
const auth = defineOMSWalletAuthConfig({
  oidcProviders: {
    custom: customOidcProvider,
  },
})

const omsWallet = new OMSWallet({
  publishableKey: 'your-publishable-key',
  auth,
})
```

---

### OidcProviderConfig

```typescript
type OidcProviderConfig = CustomOidcProviderConfig | HelperOidcProviderConfig

interface OidcProviderConfigBase {
  clientId: string
  issuer: string
  authorizationUrl: string
  provider?: string
  providerLabel?: string
  scopes?: string[]
  authorizeParams?: Record<string, string>
  authMode?: AuthMode.AuthCode | AuthMode.AuthCodePKCE
}

interface CustomOidcProviderConfig extends OidcProviderConfigBase {
  providerRedirectUri: string
}

// Returned by googleOidcProvider() and appleOidcProvider().
interface HelperOidcProviderConfig extends OidcProviderConfigBase {
  providerRedirectUri?: string
}
```

Provider configs are the source of truth for authorization scopes and optional provider display metadata. If `scopes` is omitted or empty, the SDK does not send a `scope` authorization parameter. `authMode` defaults to `AuthMode.AuthCodePKCE`. `provider` is a stable app-facing provider key, and `providerLabel` is display text stored in `session.auth` after redirect auth completes.

Custom providers must provide `providerRedirectUri`; the SDK sends it as the OAuth/OIDC `redirect_uri`. A manual provider keyed `google`, or using the Google issuer, is still custom unless it was created by `googleOidcProvider()`.

Google can be configured with the `googleOidcProvider` helper. The default Google provider uses the SDK default client ID, `openid email profile` scopes, PKCE auth-code mode, and Google authorization parameters `access_type=offline` and `prompt=consent`. Unless `providerRedirectUri` is supplied, the SDK derives the OMS relay callback URL from the publishable key environment as `{apiBase}/auth/waas/callback/google`. If you pass `providerRedirectUri` and still use an intermediate relay, pass `omsRelayReturnUri` when starting auth so the relay can return to your app. To bypass the relay, omit `omsRelayReturnUri`.

```typescript
// Uses the SDK default Google client id and derived relay redirect URI.
googleOidcProvider()

// Override defaults when needed.
googleOidcProvider({
  clientId: 'your-google-client-id',
  providerRedirectUri: 'http://localhost:8090/callback',
})
```

Apple can be configured with the `appleOidcProvider` helper. The default Apple provider uses `openid email` scopes, `response_mode=form_post`, and PKCE auth-code mode. Unless `providerRedirectUri` is supplied, the SDK derives the OMS relay callback URL from the publishable key environment as `{apiBase}/auth/waas/callback/apple`. If you pass `providerRedirectUri` and still use an intermediate relay, pass `omsRelayReturnUri` when starting auth so the relay can return to your app. To bypass the relay, omit `omsRelayReturnUri`.

```typescript
// Uses the SDK default Apple Services ID and derived relay redirect URI.
appleOidcProvider()

// Override defaults when needed.
appleOidcProvider({
  clientId: 'your-apple-services-id',
  providerRedirectUri: 'https://app.example/auth/callback',
})
```

---

### OIDC Provider Helpers

```typescript
type OidcProviderName<Env> =
  keyof NonNullable<NonNullable<Env['auth']>['oidcProviders']> & string
type OidcProviderInput<Env> = OidcProviderName<Env> | OidcProviderConfig

interface GoogleOidcProviderParams {
  clientId?: string
  providerRedirectUri?: string
  provider?: string
  providerLabel?: string
  scopes?: string[]
  authorizeParams?: Record<string, string>
  authMode?: AuthMode.AuthCode | AuthMode.AuthCodePKCE
}

interface AppleOidcProviderParams {
  clientId?: string
  providerRedirectUri?: string
  provider?: string
  providerLabel?: string
  scopes?: string[]
  authorizeParams?: Record<string, string>
  authMode?: AuthMode.AuthCode | AuthMode.AuthCodePKCE
}

const defaultOMSWalletAuthConfig: OMSWalletAuthConfig
```

`OidcProviderName` is narrowed from the configured `auth.oidcProviders` keys when `OMSWallet` is constructed with `defineOMSWalletAuthConfig`. `googleOidcProvider(params)` and `appleOidcProvider(params)` return `OidcProviderConfig` values. `defaultOMSWalletAuthConfig` contains the SDK's built-in Google and Apple provider configuration.

---

### Auth Method Types

```typescript
interface CompleteEmailAuthParams {
  code: string
  walletType?: WalletType
  walletSelection?: WalletSelectionBehavior
  sessionLifetimeSeconds?: number
}

interface CompleteEmailAuthResult {
  readonly walletAddress: Address
  readonly wallet: WalletAccount
  readonly wallets: ReadonlyArray<WalletAccount>
  readonly credential: Readonly<WalletCredential>
}

interface SignInWithOidcIdTokenParams {
  idToken: string
  issuer: string
  audience: string
  walletType?: WalletType
  walletSelection?: WalletSelectionBehavior
  sessionLifetimeSeconds?: number
  provider?: string
  providerLabel?: string
}

interface CompleteOidcIdTokenAuthResult {
  readonly walletAddress: Address
  readonly wallet: WalletAccount
  readonly wallets: ReadonlyArray<WalletAccount>
  readonly credential: Readonly<WalletCredential>
}

interface StartOidcRedirectAuthParams<Env> {
  provider: OidcProviderInput<Env>
  omsRelayReturnUri?: string
  walletType?: WalletType
  walletSelection?: WalletSelectionBehavior
  sessionLifetimeSeconds?: number
  authorizeParams?: Record<string, string>
  loginHint?: string
}

interface StartOidcRedirectAuthResult {
  authorizationUrl: string
  state: string
  challenge: string
}

interface CompleteOidcRedirectAuthParams {
  callbackUrl?: string
  cleanUrl?: boolean
  replaceUrl?: (url: string) => void
  walletSelection?: WalletSelectionBehavior
  sessionLifetimeSeconds?: number
}

interface CompleteOidcRedirectAuthResult {
  readonly walletAddress: Address
  readonly wallet: WalletAccount
  readonly wallets: ReadonlyArray<WalletAccount>
  readonly credential: Readonly<WalletCredential>
}

interface SignInWithOidcRedirectParams<Env> {
  provider: OidcProviderInput<Env>
  omsRelayReturnUri?: string
  walletType?: WalletType
  walletSelection?: WalletSelectionBehavior
  authorizeParams?: Record<string, string>
  loginHint?: string
  sessionLifetimeSeconds?: number
  currentUrl?: string
  assignUrl?: (url: string) => void
}
```

Exported parameter and result interfaces for the email OTP and OIDC methods documented above. All `sessionLifetimeSeconds` values must be integer seconds from `1` through `2592000` (30 days), and default to one week when omitted.

---

### StorageManager

```typescript
interface StorageManager {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
}
```

Interface for wallet metadata storage. Implement this to use a custom backend. The SDK defaults to `LocalStorageManager` when browser `localStorage` is available and `MemoryStorageManager` otherwise.

---

### Storage Helpers

```typescript
class LocalStorageManager implements StorageManager
class SessionStorageManager implements StorageManager
class MemoryStorageManager implements StorageManager

function createDefaultStorage(): StorageManager
```

`createDefaultStorage()` returns `LocalStorageManager` when browser `localStorage` is available, otherwise `MemoryStorageManager`. OIDC redirect state defaults to `SessionStorageManager` when browser `sessionStorage` is available.

---

### CredentialSigner

```typescript
type CredentialSigningAlgorithm = 'ecdsa-p256k-eip191' | 'ecdsa-p256-sha256'

interface CredentialSigner {
  readonly signingAlgorithm: CredentialSigningAlgorithm
  credentialId(): Promise<string>
  nextNonce(): Promise<string>
  sign(preimage: string): Promise<string>
  hasCredential?(): Promise<boolean>
  clear?(): Promise<void>
}
```

Interface for request credential signing. The default implementation is `WebCryptoP256CredentialSigner`, which uses `ecdsa-p256-sha256` and a non-extractable WebCrypto private key.

---

### Credential Signing Helpers

```typescript
class WebCryptoP256CredentialSigner implements CredentialSigner {
  constructor(id?: string)
}

class EthereumPrivateKeyCredentialSigner implements CredentialSigner {
  constructor(privateKey: Uint8Array)
}
```

`WebCryptoP256CredentialSigner` is the browser default. `EthereumPrivateKeyCredentialSigner` signs credential requests with an EVM private key and is useful for Node.js or server-side usage where the caller provides key material directly.

---

### Session Listener Types

```typescript
interface OMSWalletEmailSessionAuth {
  readonly type: 'email'
  readonly email: string | undefined
}

type OMSWalletOidcSessionAuthFlow = 'redirect' | 'id-token'

interface OMSWalletOidcSessionAuth {
  readonly type: 'oidc'
  readonly flow: OMSWalletOidcSessionAuthFlow
  readonly issuer: string
  readonly provider: string | undefined
  readonly providerLabel: string | undefined
  readonly email: string | undefined
}

type OMSWalletSessionAuth =
  | OMSWalletEmailSessionAuth
  | OMSWalletOidcSessionAuth

interface OMSWalletSessionState {
  readonly walletAddress: Address | undefined
  readonly expiresAt: string | undefined
  readonly auth: OMSWalletSessionAuth | undefined
}

interface OMSWalletSessionExpiredEvent {
  readonly session: OMSWalletSessionState
  readonly expiredAt: string
}

type OMSWalletSessionExpiredListener = (
  event: OMSWalletSessionExpiredEvent
) => void | Promise<void>
```

Session state and listener types used by [`session`](#session) and [`onSessionExpired`](#onsessionexpired).

---

### Signing and Validation Method Types

```typescript
interface SignMessageParams {
  network: Network
  message: string
}

interface SignTypedDataParams {
  network: Network
  typedData: unknown
}

interface GetIdTokenParams {
  ttlSeconds?: number
  customClaims?: Record<string, unknown>
}

interface IsValidMessageSignatureParams {
  network?: Network
  walletAddress?: Address
  walletId?: string
  message: string
  signature: string
}

interface IsValidTypedDataSignatureParams {
  network?: Network
  walletAddress?: Address
  walletId?: string
  typedData: unknown
  signature: string
}
```

Exported parameter interfaces for signing, ID token, and signature validation methods.

---

### WalletAccount

```typescript
interface WalletAccount {
  readonly id: string
  readonly type: WalletType
  readonly address: Address
  readonly reference?: string
}
```

Wallet metadata returned by auth and wallet listing APIs.

---

### PendingWalletSelection

```typescript
interface PendingWalletSelection {
  readonly walletType: WalletType
  readonly wallets: ReadonlyArray<WalletAccount>
  readonly credential: Readonly<WalletCredential>

  selectWallet(params: { walletId: string }): Promise<WalletActivationResult>
  createAndSelectWallet(params?: { reference?: string }): Promise<WalletActivationResult>
}
```

Returned by manual email or OIDC auth completion. The selection is bound to the verified auth flow and signer that created it. It can be used once to select one of the returned `wallets` or to create and select a new wallet of `walletType`.

---

### WalletSelectionBehavior

```typescript
type WalletSelectionBehavior = 'automatic' | 'manual'
```

Controls whether auth completion immediately activates a wallet or returns a [`PendingWalletSelection`](#pendingwalletselection).

---

### WalletCredential

```typescript
interface WalletCredential {
  credentialId: string
  expiresAt: string
  isCaller: boolean
}
```

| Field | Type | Description |
|---|---|---|
| `credentialId` | `string` | Unique identifier. Pass to `revokeAccess` to remove this credential. |
| `expiresAt` | `string` | ISO 8601 timestamp for credential expiry. |
| `isCaller` | `boolean` | `true` if this credential belongs to the current active session. |

`AccessGrant` has the same shape and represents a credential with access to the active wallet.

---

### AccessGrant

```typescript
type AccessGrant = WalletCredential
```

---

### ListAccessParams

```typescript
interface ListAccessParams {
  pageSize?: number
}
```

| Field | Type | Description |
|---|---|---|
| `pageSize` | `number` | Requested page size. The service applies its own default and maximum. |

---

### AccessGrantPage

```typescript
interface AccessGrantPage {
  grants: AccessGrant[]
}
```

| Field | Type | Description |
|---|---|---|
| `grants` | `AccessGrant[]` | Credentials yielded for this page. |

---

### WalletActivationResult

```typescript
interface WalletActivationResult {
  readonly walletAddress: Address
  readonly wallet: WalletAccount
}
```

Returned when an existing wallet is selected or a new wallet is created and activated.

---

### Native Transaction Parameters

```typescript
{
  network: Network
  to: Address
  value: bigint
  mode?: TransactionMode
  selectFeeOption?: FeeOptionSelector
  waitForStatus?: boolean
  statusPolling?: TransactionStatusPollingOptions
}
```

Used when sending a native token transfer. `value` is required and `data`/`abi` must not be set.

---

### Raw Data Transaction Parameters

```typescript
{
  network: Network
  to: Address
  data: Hex
  value?: bigint
  mode?: TransactionMode
  selectFeeOption?: FeeOptionSelector
  waitForStatus?: boolean
  statusPolling?: TransactionStatusPollingOptions
}
```

Used when sending a transaction with raw calldata. `abi` must not be set.

---

### ABI-Encoded Transaction Parameters

```typescript
{
  network: Network
  to: Address
  abi: Abi | readonly unknown[]
  functionName: string
  args?: unknown[]
  value?: bigint
  mode?: TransactionMode
  selectFeeOption?: FeeOptionSelector
  waitForStatus?: boolean
  statusPolling?: TransactionStatusPollingOptions
}
```

Used for ABI-encoded contract calls. `abi` and `functionName` are required; `args` types are inferred from const ABIs. `data` must not be set. Calldata is encoded automatically using viem's `encodeFunctionData`.

---

### SendTransactionResponse

```typescript
type SendTransactionResponse = {
  txnId: string
  status: TransactionStatus
  txnHash?: string
}
```

`txnHash` is present once the transaction is published. If polling times out while the transaction is still pending, use `txnId` to check status later.

---

### TransactionStatusResponse

```typescript
interface TransactionStatusResponse {
  status: TransactionStatus
  txnHash?: string
}
```

Returned by [`getTransactionStatus`](#gettransactionstatus).

---

### TransactionStatusPollingOptions

```typescript
type TransactionStatusPollingOptions = {
  timeoutMs?: number
  intervalMs?: number
  fastIntervalMs?: number
  fastPollCount?: number
}
```

Controls how `sendTransaction` polls transaction status after execute when `waitForStatus` is not `false`.

Defaults: `timeoutMs` is `60000`, `intervalMs` is `2000`, `fastIntervalMs` is `400`, and `fastPollCount` is `5`.

---

### TransactionMode

```typescript
enum TransactionMode {
  Native = 'native',
  Relayer = 'relayer'
}
```

Controls how the SDK prepares a wallet transaction. Transaction methods default to `TransactionMode.Relayer`.

---

### TransactionStatus

```typescript
enum TransactionStatus {
  Quoted = 'quoted',
  Pending = 'pending',
  Executed = 'executed',
  Failed = 'failed'
}
```

Returned in transaction execution and status responses.

---

### FeeOptionSelector

```typescript
type FeeOptionSelector = (
  feeOptions: FeeOptionWithBalance[]
) => FeeOptionSelection | undefined | Promise<FeeOptionSelection | undefined>

const FeeOptionSelector: {
  firstAvailable: FeeOptionSelector
}
```

When no selector is provided, the SDK uses the first required fee option, or no
fee option for sponsored transactions. `FeeOptionSelector.firstAvailable` uses
enriched balances to skip underfunded fee options and selects the first option
the wallet can pay. For custom selectors, return `option.selection` to select
that fee option.

---

### FeeOption

```typescript
interface FeeOption {
  token: {
    network: string
    name: string
    symbol: string
    type: string
    decimals?: number
    logoURL?: string
    contractAddress?: string
    tokenID?: string
  }
  value: string
  displayValue: string
}
```

A fee token option returned during transaction preparation. `value` is the token amount in base units.

---

### FeeOptionSelection

```typescript
interface FeeOptionSelection {
  token: string
}
```

The selector payload for a fee option. In custom selectors, return the `selection` field from `FeeOptionWithBalance`.

---

### FeeOptionWithBalance

```typescript
type FeeOptionWithBalance = {
  feeOption: FeeOption
  selection: FeeOptionSelection
  balance?: TokenBalance
  available?: string
  availableRaw?: string
  decimals?: number
}
```

Fee option plus the active wallet's indexer balance for that token, when the SDK can load it.

---

### GetBalancesParams

```typescript
interface GetBalancesParams {
  walletAddress: string
  networks?: Network[]
  networkType?: IndexerNetworkType
  contractAddresses?: string[]
  includeMetadata?: boolean
  omitPrices?: boolean
  tokenIds?: string[]
  contractStatus?: ContractVerificationStatus
  page?: TokenBalancesPage
}
```

Parameters for [`getBalances`](#getbalances).

---

### GetTransactionHistoryParams

```typescript
interface GetTransactionHistoryParams {
  walletAddress: string
  networks?: Network[]
  networkType?: IndexerNetworkType
  contractAddresses?: string[]
  transactionHashes?: string[]
  metaTransactionIds?: string[]
  fromBlock?: number
  toBlock?: number
  tokenId?: string
  includeMetadata?: boolean
  omitPrices?: boolean
  metadataOptions?: MetadataOptions
  page?: TokenBalancesPage
}
```

Parameters for [`getTransactionHistory`](#gettransactionhistory).

---

### IndexerNetworkType

```typescript
type IndexerNetworkType = 'MAINNETS' | 'TESTNETS' | 'ALL'
```

Network group used when explicit `networks` are not provided.

---

### ContractVerificationStatus

```typescript
type ContractVerificationStatus = 'VERIFIED' | 'UNVERIFIED' | 'ALL'
```

Optional contract verification filter for balance queries.

---

### MetadataOptions

```typescript
interface MetadataOptions {
  verifiedOnly?: boolean
  unverifiedOnly?: boolean
  includeContracts?: string[]
}
```

Options for transaction metadata enrichment. Use `contractStatus` on [`getBalances`](#getbalances) to filter balance queries by contract verification status; use `metadataOptions` on [`getTransactionHistory`](#gettransactionhistory) to tune metadata returned with transaction history.

| Field | Type | Description |
|---|---|---|
| `verifiedOnly` | `boolean` | Request metadata for verified contracts only. |
| `unverifiedOnly` | `boolean` | Request metadata for unverified contracts only. |
| `includeContracts` | `string[]` | Limit metadata enrichment to specific contract addresses. |

---

### SortBy

```typescript
interface SortBy {
  column: string
  order: 'DESC' | 'ASC'
}
```

Sort descriptor used in indexer pagination requests.

---

### BalancesResult

```typescript
interface BalancesResult {
  status: number
  page?: TokenBalancesPage
  nativeBalances: TokenBalance[]
  balances: TokenBalance[]
}
```

| Field | Type | Description |
|---|---|---|
| `status` | `number` | Response status code. |
| `page` | `TokenBalancesPage` | Pagination metadata, if present. |
| `nativeBalances` | `TokenBalance[]` | Native token balances for the requested address. |
| `balances` | `TokenBalance[]` | Array of token balance entries for the requested address. |

---

### TransactionHistoryResult

```typescript
interface TransactionHistoryResult {
  status: number
  page?: TokenBalancesPage
  transactions: Transaction[]
}
```

| Field | Type | Description |
|---|---|---|
| `status` | `number` | Response status code. |
| `page` | `TokenBalancesPage` | Pagination metadata, if present. |
| `transactions` | `Transaction[]` | Flattened transaction entries across the requested networks. |

---

### Transaction

```typescript
interface Transaction {
  txnHash: string
  blockNumber: number
  blockHash: string
  chainId: number
  metaTxnId?: string
  transfers?: TransactionTransfer[]
  timestamp: string
}
```

Indexer transaction entry returned by [`getTransactionHistory`](#gettransactionhistory).

---

### TransactionTransfer

```typescript
interface TransactionTransfer {
  transferType?: string
  contractAddress?: string
  contractType?: string
  from?: string
  to?: string
  tokenIds?: string[]
  amounts?: string[]
  logIndex?: number
  amountsUSD?: string[]
  pricesUSD?: string[]
  contractInfo?: TokenContractInfo
  tokenMetadata?: Record<string, TokenMetadata>
}
```

Token or native transfer details associated with an indexer transaction entry.

---

### TokenBalancesPage

```typescript
interface TokenBalancesPage {
  page?: number
  column?: string
  pageSize?: number
  more?: boolean
  before?: unknown
  after?: unknown
  sort?: SortBy[]
}
```

| Field | Type | Description |
|---|---|---|
| `page` | `number` | Current page index (zero-based). |
| `column` | `string` | Pagination column, when returned or requested. |
| `pageSize` | `number` | Number of entries per page. |
| `more` | `boolean` | `true` if additional pages are available. |
| `before` | `unknown` | Cursor before the current page, when returned. |
| `after` | `unknown` | Cursor after the current page, when returned. |
| `sort` | `SortBy[]` | Optional sort descriptors. |

---

### TokenBalance

```typescript
interface TokenBalance {
  contractType?: string
  contractAddress?: string
  accountAddress?: string
  tokenId?: string
  name?: string
  symbol?: string
  balance?: string
  balanceUSD?: string
  priceUSD?: string
  priceUpdatedAt?: string
  blockHash?: string
  blockNumber?: number
  chainId?: number
  uniqueCollectibles?: string
  isSummary?: boolean
  contractInfo?: TokenContractInfo
  tokenMetadata?: TokenMetadata
}
```

| Field | Type | Description |
|---|---|---|
| `contractType` | `string` | Token standard, e.g. `"ERC20"`, `"ERC721"`, `"ERC1155"`. |
| `contractAddress` | `string` | Address of the token contract. |
| `accountAddress` | `string` | Wallet address this balance belongs to. |
| `tokenId` | `string` | For ERC-721/ERC-1155 tokens, the token ID. |
| `name` | `string` | Token name, when returned directly on the balance row. |
| `symbol` | `string` | Token symbol, when returned directly on the balance row. |
| `balance` | `string` | Balance in the token's smallest denomination. |
| `balanceUSD` | `string` | USD value when returned by the Indexer. |
| `priceUSD` | `string` | Token price in USD when returned by the Indexer. |
| `priceUpdatedAt` | `string` | Timestamp for the returned USD price. |
| `blockHash` | `string` | Block hash at which this balance was recorded. |
| `blockNumber` | `number` | Block number at which this balance was recorded. |
| `chainId` | `number` | Numeric chain ID. |
| `uniqueCollectibles` | `string` | Number of unique collectibles represented by a summary row. |
| `isSummary` | `boolean` | Whether the row represents an aggregated collection summary. |
| `contractInfo` | `TokenContractInfo` | Contract display metadata. ERC-20 decimals are exposed as `contractInfo.decimals`. |
| `tokenMetadata` | `TokenMetadata` | Token-level metadata for NFT/collection entries when returned. |

---

### TokenContractInfo

```typescript
interface TokenContractInfo {
  chainId?: number
  address?: string
  source?: string
  name?: string
  type?: string
  symbol?: string
  decimals?: number
  logoURI?: string
  deployed?: boolean
  bytecodeHash?: string
  extensions?: Record<string, unknown>
  updatedAt?: string
  queuedAt?: string | null
  status?: string
}
```

Contract-level metadata returned by the Indexer when `includeMetadata` is `true`.

---

### TokenMetadata

```typescript
interface TokenMetadata {
  chainId?: number
  contractAddress?: string
  tokenId?: string
  source?: string
  name?: string
  description?: string
  image?: string
  video?: string
  audio?: string
  properties?: Record<string, unknown>
  attributes?: Record<string, unknown>[]
  image_data?: string
  external_url?: string
  background_color?: string
  animation_url?: string
  decimals?: number
  updatedAt?: string
  assets?: TokenMetadataAsset[]
  status?: string
  queuedAt?: string | null
  lastFetched?: string
}
```

Token-level metadata returned by the Indexer when available.

---

### TokenMetadataAsset

```typescript
interface TokenMetadataAsset {
  id?: number
  collectionId?: number
  tokenId?: string
  url?: string
  metadataField?: string
  name?: string
  filesize?: number
  mimeType?: string
  width?: number
  height?: number
  updatedAt?: string
}
```

Media asset metadata associated with token metadata when returned.

---

### Contract Call Arguments

```typescript
{
  type: string
  value: unknown
}
```

A loosely-typed ABI argument object used by [`callContract`](#callcontract). For fully-typed encoding, use the ABI overload of [`sendTransaction`](#abi-encoded-contract-call) instead.

| Field | Type | Description |
|---|---|---|
| `type` | `string` | Solidity type string, e.g. `"address"`, `"uint256"`, `"bytes32"`, `"bool"`. |
| `value` | `unknown` | The argument value. Use a string for large integers to avoid precision loss. |

---

### AuthMode

```typescript
enum AuthMode {
  OTP = 'otp',
  IDToken = 'id-token',
  AuthCode = 'auth-code',
  AuthCodePKCE = 'auth-code-pkce'
}
```

OIDC provider configs support `AuthMode.AuthCode` and `AuthMode.AuthCodePKCE`. Redirect auth defaults to `AuthMode.AuthCodePKCE` when a provider does not specify `authMode`.

---

### WalletType

```typescript
enum WalletType {
  Ethereum = 'ethereum'
}
```

Identifies the wallet type to load or create. Accepted by wallet creation and auth completion flows, including [`completeEmailAuth`](#completeemailauth), [`signInWithOidcIdToken`](#signinwithoidcidtoken), [`startOidcRedirectAuth`](#startoidcredirectauth), [`signInWithOidcRedirect`](#signinwithoidcredirect), and [`createWallet`](#createwallet). Defaults to `WalletType.Ethereum`.
