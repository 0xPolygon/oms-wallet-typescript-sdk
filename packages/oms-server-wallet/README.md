# @polygonlabs/oms-server-wallet-sdk

Standalone ESM TypeScript SDK targeting WaaS v1.2.0 for attested OMS server wallets across **EVM**, **Solana**, and **Tron**, with OIDC authentication, encrypted durable state, verified signing, sponsored transfers and contract calls, and optional durable Trails swaps and recovery (`/trails`).

Requires Web Crypto and Fetch (**Node 22+** or Cloudflare Workers with `nodejs_compat`). Zero dashboard, Hono, D1, or browser wallet SDK dependencies.

- [Root TypeScript API Reference](API.md)
- [Trails Swaps TypeScript API Reference](TRAILS-API.md)
- [Node.js Integration Walkthrough](docs/NODE-INTEGRATION.md)
- [Backend Swaps & Recovery Guide](docs/SWAPS-INTEGRATION.md)

## Installation

```sh
npm install @polygonlabs/oms-server-wallet-sdk@0.3.0
```

## Quick start (single-identity wallet)

Use `createServerWallet` when each runtime instance owns one identity (such as one Cloudflare Durable Object per wallet):

```ts
import {
  createServerWallet,
  createSingleProcessExecutor,
  describeOperation,
  parseAmount,
  type StateStore
} from '@polygonlabs/oms-server-wallet-sdk';

declare const persistence: StateStore;

const wallet = createServerWallet({
  publishableKey: process.env.OMS_PUBLISHABLE_KEY!,
  origin: process.env.APP_ORIGIN!, // Allowed Origin for your OMS project
  oidc: {
    issuer: process.env.OIDC_ISSUER!,
    audience: process.env.OIDC_AUDIENCE!,
    subject: 'customer:12345',
    // Mint a new ID token on every call: WaaS rejects a token that was already used to sign in.
    getIdToken: () => issueIdToken('customer:12345') // { token, expiresAt (Unix seconds) }
  },
  storage: {
    // SDK encrypts state with AES-256-GCM bound to the canonical wallet namespace.
    adapter: persistence,
    encryptionKey: process.env.ENCRYPTION_KEY! // 32 random bytes, base64-encoded
  },
  // Required: reuse one executor per identity. Use a distributed lock in clustered Node.
  executor: createSingleProcessExecutor()
});

const snapshot = await wallet.createOrRestore({ families: ['evm', 'solana', 'tron'] });

// Sign and verify an EVM message
const signed = await wallet.evm.signMessage({
  idempotencyKey: crypto.randomUUID(),
  chainId: 137,
  message: 'Hello OMS'
});

// Two-phase sponsored transfer (default: `send*` shortcuts are omitted unless explicitly enabled)
const transferId = crypto.randomUUID(); // Persist and reuse on retries
const prepared = await wallet.evm.prepareTransfer({
  idempotencyKey: transferId,
  chainId: 137,
  to: '0x2222222222222222222222222222222222222222',
  asset: 'native', // or an ERC-20 contract address
  amount: parseAmount('0.001', 18)
});

// Present reviewed terms to your policy engine / operator, then execute bound to `reviewId`:
if (prepared.status === 'quoted' && prepared.reviewId) {
  await wallet.evm.execute({ idempotencyKey: transferId, reviewId: prepared.reviewId });
}

// Observe without holding the wallet lock across sleeps
const result = await wallet.evm.waitForOperation(transferId, { timeoutMs: 30_000 });
const guidance = describeOperation(result.operation);
```

## Multi-tenant backends (`createServerWalletService`)

For Node backends operating many identities, configure shared settings once with `createServerWalletService` and obtain a handle for each host-authenticated subject via `forSubject(subject)`:

```ts
import {
  createServerWalletService,
  createSingleProcessExecutorPool,
  type NamespacedStateStore
} from '@polygonlabs/oms-server-wallet-sdk';

declare const storage: NamespacedStateStore;

const wallets = createServerWalletService({
  publishableKey: process.env.OMS_PUBLISHABLE_KEY!,
  origin: process.env.APP_ORIGIN!,
  oidc: {
    issuer: process.env.OIDC_ISSUER!,
    audience: process.env.OIDC_AUDIENCE!,
    getIdToken: (subject) => issueIdToken(subject)
  },
  storage: {
    adapter: storage,
    encryptionKey: process.env.ENCRYPTION_KEY!
  },
  // Single-process Node only; clustered deployments must supply a distributed ExecutorProvider.
  executor: createSingleProcessExecutorPool()
});

// `forSubject` is a lookup, not authorization — authenticate the caller first.
const wallet = wallets.forSubject(authenticatedUserId);
```

`forSubject` does no I/O, and `createOrRestore` makes no WaaS call once the identity holds a valid credential and the requested wallets (it reads stored state only); it signs in again when the credential is within a minute of expiry. Handles can be cached or created per request. Several handles for the same subject are safe as long as your `ExecutorProvider` serializes by namespace, so they all queue behind one lock: `createSingleProcessExecutorPool` does this within a process, and a distributed provider must lock per namespace too.

## Attestation & trust policy

Every WaaS response is verified against AWS Nitro attestation (root certificate, COSE signature, PCR0 allowlist, freshness, nonce, and request/response body binding). There is no skip-attestation switch.

- **Staging & production keys (`pk_live_*`, `pk_sdbx_*`, `pk_stg_*`)**: default to the SDK's stage-pinned PCR0 measurements. Passing `attestation: { trustedPcr0s }` **replaces** those defaults (empty or malformed lists fail closed). All-zero debug PCR0s are unconditionally rejected.
- **Local & dev keys (`pk_dev_*`, `pk_local_*`)**: require explicit `attestation: { allowDebugEnclave: true }` to accept an all-zero debug enclave measurement, or explicit non-debug `trustedPcr0s`.

## Approval modes & `reviewId`

By default (`approval: 'two-phase'`), one-shot `send*` shortcuts are omitted at **both the TypeScript type and runtime surface** so review-gated integrations cannot accidentally bypass approval.

- `execute({ idempotencyKey, reviewId })` requires the opaque `reviewId` returned by `prepare*`, binding execution to the exact reviewed terms, fee/sponsor policy, quote ID, and expiry. `reviewId` binds terms — it is **not** caller authorization; expose `execute` only to your trusted backend approver.
- Pass `approval: 'allow-immediate'` when your backend enforces authorization before calling one-shot `sendTransfer` / `sendCall` / `sendTransaction` / `sendContractCall`. Even in immediate mode, `submissionMode` is persisted before quoting so a `send*` call can never adopt or execute a quote prepared for manual review (`APPROVAL_REQUIRED`).

## Payout lifecycle: operations, attempts and approval

An operation's ID is the `idempotencyKey` you choose (`getOperation(idempotencyKey)`). Keys are 8–100 letters, digits, `_` or `-`. Retrying the same step with the same key and input is safe: `prepare*` returns the stored operation, and `execute` with the same `reviewId` returns its current state instead of submitting again.

Quotes are short-lived. Measured on WaaS v1.2.0:

| Chain | Quote lifetime |
| --- | --- |
| EVM (Polygon, Amoy and other EVM networks) | about 15 minutes |
| Tron | about 15 minutes |
| Solana | about 60 seconds (the blockhash lifetime) |

Model one business payout as a series of **attempts**, each with its own key, for example `payout-123-a1`, `payout-123-a2`:

1. `prepare*` under the current attempt key and store the `reviewId` and `quote.expiresAt` with your payout.
2. Approve, then `execute({ idempotencyKey, reviewId })` before the quote expires.
3. Wait with `waitForOperation`. Only the `'executed'` outcome means the transaction went through.
4. Start a new attempt only when `describeOperation(operation).action` is `'safe-to-reprepare'` (for example a quote that expired before `execute`, or a refusal with `provenUnsent: true`). For `'poll-original'` or `'reconcile-original'`, keep waiting on or reconciling the same operation: a new attempt could pay twice.

Approval that can take longer than the quote lifetime should approve the business terms (recipient, asset, amount, limits) rather than a specific quote: after approval, prepare and execute right away, re-approving only if the new terms differ. On Solana this is the only practical pattern.

## Uniform wallet grammar

| Surface | Methods |
| --- | --- |
| `wallet` | `inspect()`, `createOrRestore({ families? })`, `rotateCredential()`, `disable()`, `enable()` |
| `wallet.evm` | `prepareTransfer`, `prepareCall`, `execute`, `signMessage`, `signTypedData`, `getOperation`, `refreshOperation`, `waitForOperation`, `resolveReconciliation`, `listOperations`, `getTransactionStatus` (+ `sendTransfer`, `sendCall` in `allow-immediate` mode) |
| `wallet.solana` | `prepareTransfer`, `execute`, `signMessage`, `getOperation`, `refreshOperation`, `waitForOperation`, `resolveReconciliation`, `listOperations`, `getTransactionStatus` (+ `sendTransfer` in `allow-immediate` mode) |
| `wallet.tron` | `prepareTransaction`, `prepareContractCall`, `execute`, `signMessage`, `signTypedData`, `getOperation`, `refreshOperation`, `waitForOperation`, `resolveReconciliation`, `listOperations`, `getTransactionStatus` (+ `sendTransaction`, `sendContractCall` in `allow-immediate` mode) |
| `wallet.indexer` | Unattested `getEvmBalances({ chainIds?, page? })`, `getSolanaBalances({ networks? })`, `getTronBalances({ networks? })` |
| `wallet.swaps` | Present only when `swaps: trails(...)` is passed: `quote`, `confirm`, `get`, `list`, `reconcile`, `tick`, `prepareRecovery`, `confirmRecovery`, `resolveReconciliation` |

### EVM networks

Every EVM network the client SDK (`@polygonlabs/oms-wallet`) supports is accepted, mainnets and testnets: Ethereum and Sepolia, Polygon and Polygon Amoy (`80002`), Arbitrum, Arbitrum Sepolia and Arbitrum Nova, Optimism and Optimism Sepolia, Base and Base Sepolia, BNB Chain and its testnet, Avalanche and its testnet, and Katana. `SupportedEvmChainId` lists their chain IDs, and `EVM_NETWORKS`, `SOLANA_NETWORKS` and `TRON_NETWORKS` list the supported networks at runtime. Sponsorship is configured per project and network in WaaS; an unsponsored network quotes with `SPONSORSHIP_REQUIRED`.

EVM `chainId` inputs are typed `SupportedEvmChainId`, so an unsupported chain fails to compile. A literal inside an object you build first widens to `number`; write `chainId: 137 as const`, annotate the object (`const transfer: EvmTransferInput = { … }`), or narrow a configured value with `isSupportedEvmChainId(chainId)`.

### EVM contract calls (`wallet.evm.prepareCall` / `sendCall`)

Describe a sponsored EVM contract call with a typed ABI (`as const` or viem's `erc20Abi`) or pre-encoded hex `data`:

```ts
import { erc20Abi } from 'viem';

const prepared = await wallet.evm.prepareCall({
  idempotencyKey: crypto.randomUUID(),
  chainId: 137,
  to: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC on Polygon
  abi: erc20Abi,
  functionName: 'transfer',
  args: ['0x2222222222222222222222222222222222222222', 2_500_000n]
});
```

Never build `to`, `data`, `abi`, `functionName`, `args`, or `typedData` from untrusted browser input; validate targets and arguments server-side.

### Solana & Tron

- **Solana** (`solana:mainnet`, `solana:devnet`): Ed25519 account with mandatory fee-payer sponsorship (`SPONSORSHIP_REQUIRED`). Quotes expire in ~1 minute with their blockhash.
- **Tron** (`tron:mainnet`, `tron:nile`): secp256k1 account (`T…`). Sponsored-only by default (delegated resources); set `maxFee` in sun to allow paying up to a quoted TRX cap (`FEE_LIMIT_EXCEEDED` / `FEE_ABOVE_QUOTE`). Note that `maxFee` applies to the quote and execution-time re-check; on-chain contract calls are capped by WaaS's sealed energy limit (1.2× estimate).

A TRC-20 transfer, such as USDT, is a contract call. `method` is the bare function name, and each argument is an ABI type with its value; pass integers as decimal strings in base units:

```ts
const prepared = await wallet.tron.prepareContractCall({
  idempotencyKey: 'payout-123-a1',
  network: 'tron:mainnet',
  contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // USDT on Tron
  method: 'transfer', // not 'transfer(address,uint256)'
  args: [
    { type: 'address', value: recipient }, // T… address
    { type: 'uint256', value: parseAmount('25', 6) } // '25000000'
  ],
  maxFee: '20000000' // pay up to 20 TRX when delegated energy does not cover it
});
```

WaaS simulates the call while quoting; a call that would revert (for example, an insufficient token balance) is refused with `UPSTREAM_ERROR` (`upstreamCode` 7200).

### Observation, settlement & `describeOperation`

- `getOperation(id)` is a **local read** (never authenticates or polls WaaS). Use `refreshOperation(id)` for one remote status poll, or `waitForOperation(id, { timeoutMs, pollIntervalMs?, signal? })` to poll outside exclusive ownership with distinct outcomes: a finished operation reports its terminal status (`'executed' | 'failed' | 'expired' | 'signed'`), and `'reconciliation-required' | 'timed-out' | 'cancelled'` mean the wait ended first. Only `'executed'` means the transaction went through.
- **Pre-submit quote expiry** marks the operation terminal `expired` (`QUOTE_EXPIRED`, `provenUnsent: true`) and never calls WaaS `Execute`.
- **Ambiguous `Execute` (lost response)** stays **open** (`status: 'unknown'`). If WaaS still answers `TransactionExpired` two minutes past quote expiry without claim evidence, the operation escalates to `error: 'RECONCILIATION_REQUIRED'` while remaining open (`status: 'unknown'`) and retaining swap debit reservations — because an eventually-consistent negative read is a heuristic, not proof nothing was broadcast. Once an operator verifies out of band that nothing was broadcast, call `resolveReconciliation({ idempotencyKey, txnId, resolution: 'not-broadcast' })` (or `wallet.swaps.resolveReconciliation({ swapId, txnId, resolution: 'not-broadcast' })` for swap funding/recovery), which re-checks WaaS under lock before releasing reservations and marks the operation `expired` with `operatorResolved: true`. A stale `TransactionExpired` read inside the grace window leaves the operation unchanged, so `waitForOperation` keeps polling.
- `getTransactionStatus(txnId)` reads the current WaaS status of a transaction by the `txnId` from its quote, for operators reconciling from their own records. It never changes a stored operation and never creates a wallet. Like any status read, a `quoted` or `TransactionExpired` answer is not proof that nothing was broadcast while WaaS is still catching up after the quote expired.
- `describeOperation(op)` derives a pure next-action recommendation (`await-review`, `poll-original`, `reconcile-original`, `safe-to-reprepare`, or `done`) strictly from validated evidence, with original IDs.

### Unattested indexer reads (`wallet.indexer` / `service.indexer`)

Indexer balances are **not attested by the WaaS enclave**; use them for display and preflight checks only, never as proof of funds. `wallet.indexer.*` snapshots the initialized address under lock, releases the lock before HTTP I/O, never authenticates or creates a wallet, and throws `WALLET_NOT_INITIALIZED` (distinct from a zero balance) if that family has not been created or restored yet.

## Trails swaps & recovery (`@polygonlabs/oms-server-wallet-sdk/trails`)

Enable swaps on a server wallet with `swaps: trails(...)`. Use the same wallet for ordinary EVM debits and swaps — both automatically share one executor and one debit coordination gate.

```ts
import { createServerWallet, createSingleProcessExecutor } from '@polygonlabs/oms-server-wallet-sdk';
import { trails, type SwapStore } from '@polygonlabs/oms-server-wallet-sdk/trails';

declare const swapStore: SwapStore;

const wallet = createServerWallet({
  publishableKey: process.env.OMS_PUBLISHABLE_KEY!,
  origin: process.env.APP_ORIGIN!,
  oidc: { issuer, audience, subject, getIdToken },
  storage: { adapter: persistence, encryptionKey: process.env.ENCRYPTION_KEY! },
  executor: createSingleProcessExecutor(),
  swaps: trails({
    apiKey: process.env.TRAILS_API_KEY!,
    chains: { 137: process.env.POLYGON_RPC_URL!, 8453: process.env.BASE_RPC_URL! },
    assets: [
      { chainId: 137, asset: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6, symbol: 'USDC' },
      { chainId: 8453, asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, symbol: 'USDC' }
    ],
    storage: { scope: 'wallet', adapter: swapStore, encryptionKey: process.env.ENCRYPTION_KEY! },
    environment: 'my-trails-project'
  })
});

const quoted = await wallet.swaps.quote({
  idempotencyKey: crypto.randomUUID(),
  originChainId: 137,
  originAsset: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  destinationChainId: 8453,
  destinationAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  amount: '10000000',
  slippageBps: 50
});
await wallet.swaps.confirm({ swapId: quoted.id, reviewId: quoted.quote.reviewId });
await wallet.swaps.tick();
```

See [docs/SWAPS-INTEGRATION.md](docs/SWAPS-INTEGRATION.md) and [TRAILS-API.md](TRAILS-API.md) for service-scoped stores (`scope: 'service'`), durable alarm scheduling, and separately reviewed recovery.

## Ephemeral signer (`createEphemeralServerWallet`)

A memory-only signer for one identity: no storage, encryption key or distributed lock. Each handle signs in with its own credential, so run one handle per concurrent worker for parallel signing.

```ts
import { createEphemeralServerWallet } from '@polygonlabs/oms-server-wallet-sdk';

const signer = createEphemeralServerWallet({
  publishableKey,
  origin: appOrigin,
  oidc: { issuer, audience, subject, getIdToken } // sessionLifetimeSeconds defaults to 900
});
try {
  await signer.restore(); // binds wallets that already exist; never creates one
  const { signature } = await signer.evm.signMessage({ chainId: 80002, message: 'hello' });
} finally {
  await signer.close(); // revokes this handle's credential
}
```

- **Signing and balances only.** There is no prepare, execute or send, and no operation records or `idempotencyKey`. Transfers, contract calls and swaps need `createServerWallet`, whose records survive a restart.
- **Never creates wallets.** Provision each identity once with `createServerWallet(...).createOrRestore(...)`. `restore()` binds what exists and throws `WALLET_NOT_INITIALIZED` otherwise; call it before signing or reading balances.
- **`close()`** revokes the credential and makes every later or queued call throw `WALLET_CLOSED`. It is idempotent, and calling it again retries a revoke that failed. A crashed process cannot close, so keep `sessionLifetimeSeconds` short.
- **No kill switch per identity.** There is no `disable()`: it would only affect one handle. To stop an identity, block it at your OIDC issuer and let credentials expire, or close every handle.
- **Typed data:** `evm.signTypedData` refuses Sequence wallet `Calls` and typed data whose `verifyingContract` is the wallet. Other typed data, such as an ERC-20 permit, can still authorize spending, and an ephemeral handle cannot see swap reservations held by a durable wallet for the same identity. Do not sign spending authorizations for an identity with swaps in flight.
- **Fresh ID tokens.** Every handle signs in, and WaaS rejects an ID token that another sign-in already used, so `getIdToken` must mint a new token on each call; never share a cached token between handles.
- Every handle signs in, which counts against OIDC and WaaS rate limits. Reuse a small pool of handles rather than creating one per request.

## Errors

Every thrown error is a `WalletError` with a stable `code`, a safe `message` and an HTTP-style `status`. WaaS refusals are `UpstreamError` (`upstreamCode`, `method`), Trails refusals are `TrailsError` from `/trails`, and malformed upstream responses are `INVALID_RESPONSE`, never a raw validation error. Use `isWalletError` / `isUpstreamError` and branch on `code`. [docs/ERRORS.md](docs/ERRORS.md) lists every code with what it means and what to do.

## Storage & concurrency

- `StateStore.write` / `NamespacedStateStore.write` must complete durable persistence before resolving.
- `ExclusiveExecutor.run` must hold exclusive ownership for the entire async task, including remote I/O. `createSingleProcessExecutor` / `createSingleProcessExecutorPool` are sufficient only within one Node process or a single per-wallet Durable Object. Construct one wallet (and executor) per Durable Object instance — never a fresh `createSingleProcessExecutor()` per HTTP request — and never call back into the wallet from `getIdToken`, store adapters, or custom `fetch` hooks (which would deadlock the executor).
- Once swaps are enabled and confirmed on a wallet, keep `swaps: trails({ ..., enabled: false })` if you later pause new swaps rather than removing `swaps` entirely, so existing reservations stay coordinated.
- The SDK computes the canonical namespace (`JSON.stringify([waasOrigin, projectId, issuer, audience, subject])`) from the routed **WaaS API origin** (never `APP_ORIGIN`), ignoring a trailing slash on the issuer, and binds AES-256-GCM AAD to it. Unrecognized or corrupted state fails closed with `INVALID_STATE` or `STORAGE_INTEGRITY`.
- Restoring a database backup after newer nonces or submissions have been sent requires upstream reconciliation — a backup alone is not a safe rollback.

### Distributed executors

A clustered backend supplies an `ExecutorProvider` backed by a distributed lock, one lock per namespace. One `run` can make several sequential WaaS requests, each with a 20-second timeout (for example, a sign-in and wallet discovery followed by `Execute`), so:

- Hold the lock for the whole task and renew it while the task runs (a heartbeat), with a lease of minutes, not seconds.
- If the lease is lost, stop the task and fail the call; never let two holders run tasks for the same namespace at once. The store contract has no compare-and-set, so the lock is the only guard against two workers interleaving credential nonces and operation records.
- Never run wallet calls from inside `getIdToken`, a store adapter or a custom `fetch`: the lock is not re-entrant.

## Custody: protect the OIDC signing key

WaaS trusts ID tokens from your registered issuer. Whoever can mint an ID token for a subject, together with your publishable key (which is not a secret), controls that subject's wallet. Treat the issuer's signing key as the custody key for every wallet:

- Keep it in a KMS or HSM and sign ID tokens there; never ship it in application config or images.
- Mint tokens only inside the backend path that has already authorized the end user, and only for that user's subject.
- Rotate it by publishing the new key in your JWKS under a new `kid` before switching, then retire the old one.
- Mint a fresh token on every `getIdToken` call: WaaS rejects a token that was already used to sign in.

## Development

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm --filter @polygonlabs/oms-server-wallet-sdk typecheck
pnpm --filter @polygonlabs/oms-server-wallet-sdk test:coverage
pnpm --filter @polygonlabs/oms-server-wallet-sdk test:package
pnpm --filter @polygonlabs/oms-server-wallet-sdk check:api
```

Licensed under [Apache-2.0](LICENSE-APACHE-2.0); see [NOTICE](NOTICE) for verifier provenance.
