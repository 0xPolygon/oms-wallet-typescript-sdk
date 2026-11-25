# Backend swaps and recovery with `@polygonlabs/oms-server-wallet-sdk/trails`

`@polygonlabs/oms-server-wallet-sdk/trails` adds exact-input cross-chain swaps, durable sponsored funding, settlement verification, delayed-deposit repair, and separately reviewed recovery directly onto your server wallet via `swaps: trails(...)`.

Ordinary EVM debits (`wallet.evm.prepareTransfer`, `wallet.evm.prepareCall`, `wallet.evm.execute`, and `send*` when enabled) and swaps (`wallet.swaps.*`) automatically share **one identity executor** and **one debit coordination gate** — there is no second executor to manage and no separate wrapper to remember.

## 1. Enable swaps on a wallet or service

### Single-identity wallet (e.g. Cloudflare Durable Object)

```ts
import {
  createServerWallet,
  createSingleProcessExecutor,
  type StateStore
} from '@polygonlabs/oms-server-wallet-sdk';
import { trails, type SwapStore } from '@polygonlabs/oms-server-wallet-sdk/trails';

declare const stateStore: StateStore;
declare const swapStore: SwapStore;

const wallet = createServerWallet({
  publishableKey: env.OMS_PUBLISHABLE_KEY,
  origin: env.APP_ORIGIN,
  oidc: { issuer, audience, subject, getIdToken },
  storage: { adapter: stateStore, encryptionKey: env.ENCRYPTION_KEY },
  executor: createSingleProcessExecutor(),
  swaps: trails({
    apiKey: env.TRAILS_API_KEY,
    chains: {
      137: env.POLYGON_RPC_URL,
      8453: env.BASE_RPC_URL
    },
    assets: [
      { chainId: 137, asset: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6, symbol: 'USDC' },
      { chainId: 8453, asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, symbol: 'USDC' }
    ],
    storage: { scope: 'wallet', adapter: swapStore, encryptionKey: process.env.ENCRYPTION_KEY! },
    environment: 'my-trails-project'
  })
});
```

### Multi-tenant service (Node backend)

Pass `storage: { scope: 'service', adapter: namespacedSwapStore, encryptionKey }` to `trails(...)` and pass it to `createServerWalletService`:

```ts
import {
  createServerWalletService,
  createSingleProcessExecutorPool,
  type NamespacedStateStore
} from '@polygonlabs/oms-server-wallet-sdk';
import { trails, type NamespacedSwapStore } from '@polygonlabs/oms-server-wallet-sdk/trails';

declare const stateStorage: NamespacedStateStore;
declare const swapStorage: NamespacedSwapStore;

const wallets = createServerWalletService({
  publishableKey: process.env.OMS_PUBLISHABLE_KEY!,
  origin: process.env.APP_ORIGIN!,
  oidc: { issuer, audience, getIdToken },
  storage: { adapter: stateStorage, encryptionKey: process.env.ENCRYPTION_KEY! },
  executor: createSingleProcessExecutorPool(),
  swaps: trails({
    apiKey: process.env.TRAILS_API_KEY!,
    chains: { 137: process.env.POLYGON_RPC_URL!, 8453: process.env.BASE_RPC_URL! },
    assets: approvedAssets,
    storage: { scope: 'service', adapter: swapStorage, encryptionKey: process.env.ENCRYPTION_KEY! },
    environment: 'my-trails-project'
  })
});

const wallet = wallets.forSubject(authenticatedSubject);
```

- A `wallet`-scoped `trails(...)` handle cannot be passed to `createServerWalletService` or bound to a second wallet namespace (`CONFIGURATION`).
- Once a swap is confirmed on a wallet, the SDK persists a coordination marker in wallet state so a separately constructed plain `createServerWallet` pointing at the same state refuses EVM debits (`SWAPS_COORDINATION_REQUIRED`) instead of bypassing swap reservations.

## 2. Quote, review, confirm, and tick

```ts
const quoted = await wallet.swaps.quote({
  idempotencyKey: crypto.randomUUID(),
  originChainId: 137,
  originAsset: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  destinationChainId: 8453,
  destinationAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  amount: '10000000', // 10 USDC in base units
  slippageBps: 50
});

// Present expected/minimum output, fees, providers, and expiry to your approver.
// Only after approval:
await wallet.swaps.confirm({
  swapId: quoted.id,
  reviewId: quoted.quote.reviewId
});

// Drive durable progress from your scheduler / Durable Object alarm:
const { nextAt } = await wallet.swaps.tick({ limit: 3 });
// If nextAt !== null, schedule your next alarm/timer for nextAt.

const current = await wallet.swaps.get(quoted.id);
const page = await wallet.swaps.list({ limit: 25 });
```

`succeeded` and `refunded` carry `outcomeEvidence`. `'provider-reported'` means the Trails receipt
reports the outcome and its recipient, token and amount match the quote, but the SDK did not read
the destination or refund transfer on chain: verify it on chain before treating funds as
delivered. `'chain-verified'` (a completed recovery) means the SDK read the received amounts on
chain itself.

## 3. Persistence & alarm scheduling contract

Implement `SwapStore` (or `NamespacedSwapStore`) over `StoredSwapEntry`:

| Field on `StoredSwapEntry` | Purpose |
| --- | --- |
| `id` | Primary key (local swap ID). |
| `intentId` | Unique upstream Trails intent ID (indexed for `findIntent`). |
| `version` | Monotonically increasing record version. |
| `active` | Whether the swap has a pending workflow action (indexed for `list({ active: true })`). |
| `nextAt` | Epoch ms timestamp for the next scheduled `tick()` alarm, or `null` when idle. |
| `createdAt` | ISO-8601 creation timestamp (sort descending in `list`). |
| `payload` | Opaque string the SDK has already encrypted (AES-256-GCM) and authenticated with the metadata fields above and the wallet namespace. Store it as given; an edited entry fails with `STORAGE_INTEGRITY`. |

`storage.encryptionKey` is 32 base64-encoded bytes. It may be the wallet state key: swap records use a key derived separately for each wallet namespace. The SDK cannot detect a store that returns an older authentic version of an entry, so `save` must never be rolled back (restore a backup only together with the matching wallet state). A wallet-state debit reservation is released only by a swap record newer than the reservation, so a rolled-back swap store keeps the wallet's EVM debits blocked (`DEBIT_PENDING`) until the swap step is retried.

Always arrange a durable wake-up (`nextAt`) before committing an action that can reach an external service. On Cloudflare Workers, use one SQLite Durable Object per wallet with one alarm set to the earliest active `nextAt`, and never hold `blockConcurrencyWhile` open across network I/O.

## 4. Separately reviewed recovery

When a funded swap terminates without settling or stalls past the progress threshold:

```ts
const recoveryKey = `${quoted.id}-recovery-1`; // store it before calling, like any idempotency key
const prepared = await wallet.swaps.prepareRecovery({
  swapId: quoted.id,
  idempotencyKey: recoveryKey,
  source: 'destination' // or 'origin'
});
// A recovery's id is its idempotency key. Find it by key: the list also holds earlier recoveries.
const recovery = prepared.recoveries.find((r) => r.id === recoveryKey);
if (!recovery) throw new Error(`Recovery ${recoveryKey} missing from swap ${quoted.id}`);
// Show recovery.assets, recovery.chainId, and recovery.requiresOwnerDeployment before confirming:
await wallet.swaps.confirmRecovery({
  swapId: quoted.id,
  recoveryId: recovery.id,
  reviewId: recovery.reviewId
});
// Continue driving progress with `wallet.swaps.tick()`.
```

- Pre-submit local quote expiry on funding marks the swap `expired` (`QUOTE_EXPIRED`) and releases the origin-chain debit reservation.
- Ambiguous funding or recovery submissions that remain unconfirmed past the post-expiry grace window escalate to `RECONCILIATION_REQUIRED` while staying open and **retaining** the debit reservation until reconciled. After out-of-band verification that nothing was broadcast, call `wallet.swaps.resolveReconciliation({ swapId, txnId, resolution: 'not-broadcast' })` to re-check WaaS under lock and release the reservation.
- To pause new swaps on a wallet that already has `swapsCoordinated` active, keep passing `swaps: trails({ ..., enabled: false })` instead of omitting `swaps`.

See [TRAILS-API.md](../TRAILS-API.md) for the complete Trails API reference.
