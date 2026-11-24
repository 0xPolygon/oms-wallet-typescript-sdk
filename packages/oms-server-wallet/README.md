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
    getIdToken: () => issueIdToken('customer:12345') // { token, expiresAt (Unix seconds) }
  },
  store: {
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

## Attestation & trust policy

Every WaaS response is verified against AWS Nitro attestation (root certificate, COSE signature, PCR0 allowlist, freshness, nonce, and request/response body binding). There is no skip-attestation switch.

- **Staging & production keys (`pk_live_*`, `pk_sdbx_*`, `pk_stg_*`)**: default to the SDK's stage-pinned PCR0 measurements. Passing `attestation: { trustedPcr0s }` **replaces** those defaults (empty or malformed lists fail closed). All-zero debug PCR0s are unconditionally rejected.
- **Local & dev keys (`pk_dev_*`, `pk_local_*`)**: require explicit `attestation: { allowDebugEnclave: true }` to accept an all-zero debug enclave measurement, or explicit non-debug `trustedPcr0s`.

## Approval modes & `reviewId`

By default (`approval: 'two-phase'`), one-shot `send*` shortcuts are omitted at **both the TypeScript type and runtime surface** so review-gated integrations cannot accidentally bypass approval.

- `execute({ idempotencyKey, reviewId })` requires the opaque `reviewId` returned by `prepare*`, binding execution to the exact reviewed terms, fee/sponsor policy, quote ID, and expiry. `reviewId` binds terms — it is **not** caller authorization; expose `execute` only to your trusted backend approver.
- Pass `approval: 'allow-immediate'` when your backend enforces authorization before calling one-shot `sendTransfer` / `sendCall` / `sendTransaction` / `sendContractCall`. Even in immediate mode, `submissionMode` is persisted before quoting so a `send*` call can never adopt or execute a quote prepared for manual review (`APPROVAL_REQUIRED`).

## Uniform wallet grammar

| Surface | Methods |
| --- | --- |
| `wallet` | `inspect()`, `createOrRestore({ families? })`, `rotateCredential()`, `disable()`, `enable()` |
| `wallet.evm` | `prepareTransfer`, `prepareCall`, `execute`, `signMessage`, `signTypedData`, `getOperation`, `refreshOperation`, `waitForOperation`, `resolveReconciliation`, `listOperations` (+ `sendTransfer`, `sendCall` in `allow-immediate` mode) |
| `wallet.solana` | `prepareTransfer`, `execute`, `signMessage`, `getOperation`, `refreshOperation`, `waitForOperation`, `resolveReconciliation`, `listOperations` (+ `sendTransfer` in `allow-immediate` mode) |
| `wallet.tron` | `prepareTransaction`, `prepareContractCall`, `execute`, `signMessage`, `signTypedData`, `getOperation`, `refreshOperation`, `waitForOperation`, `resolveReconciliation`, `listOperations` (+ `sendTransaction`, `sendContractCall` in `allow-immediate` mode) |
| `wallet.indexer` | Unattested `getEvmBalances({ chainIds?, page? })`, `getSolanaBalances({ networks? })`, `getTronBalances({ networks? })` |
| `wallet.swaps` | Present only when `swaps: trails(...)` is passed: `quote`, `confirm`, `get`, `list`, `reconcile`, `tick`, `prepareRecovery`, `confirmRecovery`, `resolveReconciliation` |

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

### Observation, settlement & `describeOperation`

- `getOperation(id)` is a **local read** (never authenticates or polls WaaS). Use `refreshOperation(id)` for one remote status poll, or `waitForOperation(id, { timeoutMs, pollIntervalMs?, signal? })` to poll outside exclusive ownership with distinct `'settled' | 'reconciliation-required' | 'timed-out' | 'cancelled'` outcomes.
- **Pre-submit quote expiry** marks the operation terminal `expired` (`QUOTE_EXPIRED`, `provenUnsent: true`) and never calls WaaS `Execute`.
- **Ambiguous `Execute` (lost response)** stays **open** (`status: 'unknown'`). If WaaS still answers `TransactionExpired` two minutes past quote expiry without claim evidence, the operation escalates to `error: 'RECONCILIATION_REQUIRED'` while remaining open (`status: 'unknown'`) and retaining swap debit reservations — because an eventually-consistent negative read is a heuristic, not proof nothing was broadcast. Once an operator verifies out of band that nothing was broadcast, call `resolveReconciliation({ idempotencyKey, txnId, resolution: 'not-broadcast' })` (or `wallet.swaps.resolveReconciliation({ swapId, txnId, resolution: 'not-broadcast' })` for swap funding/recovery), which re-checks WaaS under lock before releasing reservations.
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
  store: { adapter: persistence, encryptionKey: process.env.ENCRYPTION_KEY! },
  executor: createSingleProcessExecutor(),
  swaps: trails({
    apiKey: process.env.TRAILS_API_KEY!,
    chains: { 137: process.env.POLYGON_RPC_URL!, 8453: process.env.BASE_RPC_URL! },
    assets: [
      { chainId: 137, asset: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6, symbol: 'USDC' },
      { chainId: 8453, asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, symbol: 'USDC' }
    ],
    store: { scope: 'wallet', adapter: swapStore },
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

## Storage & concurrency

- `StateStore.write` / `NamespacedStateStore.write` must complete durable persistence before resolving.
- `ExclusiveExecutor.run` must hold exclusive ownership for the entire async task, including remote I/O. `createSingleProcessExecutor` / `createSingleProcessExecutorPool` are sufficient only within one Node process or a single per-wallet Durable Object. Construct one wallet (and executor) per Durable Object instance — never a fresh `createSingleProcessExecutor()` per HTTP request — and never call back into the wallet from `getIdToken`, store adapters, or custom `fetch` hooks (which would deadlock the executor).
- Once swaps are enabled and confirmed on a wallet, keep `swaps: trails({ ..., enabled: false })` if you later pause new swaps rather than removing `swaps` entirely, so existing reservations stay coordinated.
- The SDK computes the canonical namespace (`JSON.stringify([waasOrigin, projectId, issuer, audience, subject])`) from the routed **WaaS API origin** (never `APP_ORIGIN`) and binds AES-256-GCM AAD to it. Unrecognized or corrupted state fails closed with `INVALID_STATE` or `STORAGE_INTEGRITY`.
- Restoring a database backup after newer nonces or submissions have been sent requires upstream reconciliation — a backup alone is not a safe rollback.

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
