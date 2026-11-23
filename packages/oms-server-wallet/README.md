# @polygonlabs/oms-server-wallet-sdk

Standalone ESM TypeScript SDK targeting WaaS v1.2.0, with EVM, Solana and Tron wallets, OIDC authentication, encrypted credential persistence, attested responses, verified message signing, and sponsored native/ERC-20 transfers. Requires Web Crypto and Fetch (Node 22+ or Workers with `nodejs_compat`). It has no dashboard, Hono, D1, or embedded wallet SDK dependency.

## Installation

```sh
npm install @polygonlabs/oms-server-wallet-sdk@0.2.0
```

For a step-by-step guide to integrating this package into your own Node.js / TypeScript backend, see the [OIDC, wallet creation, signing, and transaction walkthrough](docs/NODE-INTEGRATION.md).

## Integration

```ts
import {
  ServerWallet,
  WaasTransport,
  EncryptedStore,
  SerialExecutor,
  IndexerClient,
  parseAmount,
  environmentFromKey,
  type StateStore,
} from '@polygonlabs/oms-server-wallet-sdk';

// Implement durable reads/writes in a namespace dedicated to this identity.
declare const persistence: StateStore;
declare const publishableKey: string;
declare const approvedPcr0s: string[];
declare const encryptionKeyBase64: string; // 32 random bytes, base64 encoded
declare const applicationOrigin: string; // Origin allowed for the OMS publishable key
declare const issuer: string;
declare const audience: string;
declare const subject: string;
declare function issueIdToken(): Promise<{ token: string; expiresAt: number }>;

// Reuse exactly one executor per identity in a single process/DO instance.
const executor = new SerialExecutor();
const environment = environmentFromKey(publishableKey);
const namespace = JSON.stringify([
  environment.origin,
  environment.projectId,
  issuer,
  audience,
  subject,
]);
// Server requests use the project's allowed Origin, just like the walkthrough.
const fetcher: typeof fetch = (input, init) => {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set('Origin', applicationOrigin);
  return fetch(input, { ...init, headers });
};
const wallet = new ServerWallet({
  subject,
  issuer,
  audience,
  tokenProvider: issueIdToken,
  transport: new WaasTransport(publishableKey, approvedPcr0s, fetcher),
  store: new EncryptedStore(persistence, encryptionKeyBase64, namespace),
  executor,
});

const snapshot = await wallet.createOrRestore();
const balances = await new IndexerClient(publishableKey, fetcher).getBalances(
  snapshot.wallet!.address,
);
const signed = await wallet.signMessage(crypto.randomUUID(), 137, 'Hello OMS');

const operationId = crypto.randomUUID(); // persist and reuse on retries
const prepared = await wallet.prepareTransfer(operationId, {
  chainId: 137,
  to: '0x2222222222222222222222222222222222222222',
  asset: 'native', // or an ERC-20 contract address
  amount: parseAmount('0.001', 18), // decimal string in base units
});
// Obtain application/operator confirmation of the prepared payload first.
if (prepared.status === 'quoted') await wallet.executeTransfer(operationId);
const status = await wallet.getOperation(operationId);
```

The token provider supplies an ES256 OIDC ID token accepted by the project's configured issuer/audience. `expiresAt` is Unix time in **seconds**. The SDK generates its own P-256 credential, commits the JWT hash, completes authentication, discovers/binds the same wallet, and renews credentials automatically. Default credential lifetime is six hours; expiry recovery starts within sixty seconds of expiration.

Verified unknown, expired, or revoked/unauthorized credential responses trigger one reauthentication attempt. Persistent authorization failures propagate without a retry loop. `WalletSnapshot.credentialId` is the WaaS SHA-256 credential identifier; the request signature uses the corresponding raw public key internally.

## Storage and concurrency contract

`StateStore.read(key)` returns a string or null; `write(key, value)` must finish durable persistence before resolving. The store namespace and encryption context must be stable, unique to the project/environment/issuer/audience/subject, and shared by every instance for that identity. Never share a namespace between identities. Credential keys must use encrypted persistence, as in the example.

`ExclusiveExecutor.run(task)` holds exclusive ownership for the **entire async task**, including remote I/O. All SDK instances using the same state must share that ownership. `SerialExecutor` is sufficient only within one Node process or a single per-wallet Durable Object. Clustered Node backends need a coordinator with equivalent exclusive ownership across processes, including crash recovery; allocating nonces alone is insufficient. The dashboard's Worker adapter supplies one Durable Object per wallet.

Each RPC nonce is durably advanced before dispatch. All WaaS responses must pass Nitro root/certificate/COSE/PCR0/freshness/nonce/body-binding checks. There is no attestation bypass. Transport uses bounded responses, 20-second request timeouts, and refuses redirects. An all-zero debug PCR0 can be explicitly configured for a nonproduction environment; production keys reject it.

## Wallet families and state migration

An identity holds at most one wallet per network family: `evm`, `solana` and `tron`. `createOrRestore()` creates or restores the EVM wallet, as before; `createOrRestore({ families: ['evm', 'solana', 'tron'] })` does so for each family listed. `WalletSnapshot.wallet` is still the EVM wallet, and `WalletSnapshot.wallets` holds every family's. Before creating a family's first wallet, the SDK lists the identity's wallets and adopts one it finds, so no family ever gets a second wallet. An identity that already has two wallets of a family in use fails with `WALLET_MISMATCH`; families it doesn't use are ignored. `rotate()` and `setDisabled(false)` restore every family held.

Wallet state written by 0.2.x is migrated the first time it is loaded, keeping its credential, nonce and operations, and rewritten in the new format through the same store. Stored state that matches neither format fails with `INVALID_STATE` before any request is made. Once migrated, state can't be read by an earlier version, so roll back only from a backup taken before upgrading.

## Operations and recovery

| Method                                  | Behavior                                                            |
| --------------------------------------- | ------------------------------------------------------------------- |
| `inspect()`                             | Public snapshot; does not authenticate or return private material.  |
| `createOrRestore({ families? })`        | Recover one wallet per requested family (default EVM); reauth.      |
| `rotate()`                              | Self-revoke the current credential, then authenticate a fresh one.  |
| `setDisabled(boolean)`                  | Disable before revocation; block auth until explicitly re-enabled.  |
| `signMessage(id, chainId, message)`     | Sign plain text and verify with WaaS wallet-aware verification.     |
| `signTypedData(id, chainId, typedData)` | Validate EIP-712 domain/data, sign, and verify with WaaS.           |
| `prepareTransfer(id, transfer)`         | Validate a native/ERC-20 transfer; require sponsored quote.         |
| `executeTransfer(id)`                   | Submit the stored quote once; reconcile repeated calls.             |
| `prepareUserOperation(id, operation)`   | Encode and quote one sponsored contract call for review.            |
| `executeUserOperation(id)`              | Submit the stored contract-call quote once.                         |
| `sendUserOperation(id, operation)`      | Prepare and submit a sponsored contract call in one step.           |
| `getOperation(id)`                      | Return persisted result; poll pending/uncertain transfer status.    |
| `listOpenOperations(legacyIds?)`        | Unsettled EVM operations, without authenticating or polling.        |
| `readOperations(ids)`                   | The stored EVM operations with these IDs, without polling.          |

Idempotency IDs must contain 8–100 letters, digits, underscores, or hyphens. Changed input under the same ID raises `IDEMPOTENCY_CONFLICT`. Reusing an ID never prepares another transfer, except one whose preparation was interrupted before its quote was stored: nothing was sent, so it is quoted again. A new quote after expiry requires a new ID and operator review. A signature that fails, or does not verify, is recorded as `failed`; signing again needs a new ID.

`unknown` is a meaningful state, including a lost execution response. Keep polling `getOperation`; never generate another send merely because the first response was lost. EVM operations settle like Solana and Tron ones (see below): refusals WaaS returns only before claiming the transaction mark the operation `failed` at once, and an operation WaaS still reports expired and unclaimed two minutes past its quote's expiry becomes `expired`. Executing a quote the SDK already knows has expired marks it `expired` and raises `QUOTE_EXPIRED`. `CREATION_UNCERTAIN` prevents blind replacement-wallet creation. Disabled wallets cannot reauthenticate even to poll a status; previously submitted transfers may still complete upstream.

`WalletError` exposes a safe code, message, and HTTP-oriented status. `UpstreamError` also exposes the numeric WaaS error code and RPC method. Raw tokens, private keys, and upstream response bodies are excluded. Validation failures, unsigned gateway failures, and attestation failures must be surfaced instead of weakening verification.

`IndexerClient.getBalances(address, page?)` returns base-unit strings, metadata, a fetch timestamp, per-chain errors, and `nextPage`. Keep errors separate from zero balances and follow pagination. Unknown token decimals stay unknown.

## Solana wallets

`wallet.solana` is the identity's Solana wallet, an Ed25519 account on `solana:mainnet` or `solana:devnet`. It shares the `ServerWallet`'s credential, store and executor, and is created on first use. Transfers are sponsored by the project's Solana fee payer; a transfer that would not be sponsored fails with `SPONSORSHIP_REQUIRED`.

```ts
const transferId = crypto.randomUUID(); // persist and reuse on retries
const sent = await wallet.solana.sendTransfer(transferId, {
  network: 'solana:devnet',
  to: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  asset: 'native', // or an SPL or Token-2022 mint address
  amount: '1000000' // base units: 0.001 SOL in lamports
});
const settled = await wallet.solana.getOperation(transferId); // pending, executed or failed
```

| Method                              | Behavior                                                         |
| ----------------------------------- | ---------------------------------------------------------------- |
| `solana.prepareTransfer(id, input)` | Validate a SOL or token transfer and quote it; nothing is sent.  |
| `solana.executeTransfer(id)`        | Submit the stored quote once.                                    |
| `solana.sendTransfer(id, input)`    | Prepare and submit in one turn of the executor.                  |
| `solana.signMessage(id, message)`   | Sign a Solana off-chain message and verify it with WaaS.         |
| `solana.getOperation(id)`           | Return the persisted operation, polling a transfer in flight.    |
| `solana.listOperations()`           | Persisted Solana operations, without authenticating or polling.  |

**Quotes expire in about a minute**, with the blockhash they are built on. Review has to be quick or automated; `sendTransfer` prepares and submits without releasing the executor in between. Executing a quote the SDK already knows has expired fails with `TRANSACTION_EXPIRED` and marks the operation `expired` without calling WaaS: nothing was sent, so prepare it again under a new ID. Once Execute has been called, WaaS answers `TransactionExpired` both for an expired quote and for a transaction already claimed for broadcast, and its status reads are not strongly consistent, so the SDK keeps the operation `unknown` until a status shows the claim or, two minutes past the quote's expiry, WaaS still reports it expired unclaimed. Only then does it become `expired`. Refusals WaaS returns only before claiming, such as an invalid fee option, mark it `failed` at once.

Solana and Tron operations share the store and ID space with EVM ones, so an ID can't be reused across families. `listOperations()` and `getOperation(id)` on the `ServerWallet` still return EVM operations only.

`IndexerClient.getSolanaBalances(address, networks?)` returns SOL (9 decimals) and SPL/Token-2022 balances in base units, with the token program, plus per-network errors. Balances come from the indexer, not the attested enclave: use them for display and preflight checks, not as proof of funds.

## Tron wallets

`wallet.tron` is the identity's Tron wallet, a secp256k1 account with a Base58Check (`T…`) address on `tron:mainnet` or `tron:nile`. Tron has no relayer: a transaction spends the wallet's bandwidth and energy and burns TRX for whatever its delegated resources don't cover.

**Fees are sponsored-only by default.** A transaction is sent without TRX only when delegated resources cover it; otherwise preparing it fails with `SPONSORSHIP_REQUIRED`. To let the wallet pay, set `maxFee` in sun: the quoted fee is paid if it is at most `maxFee`, or preparing fails with `FEE_LIMIT_EXCEEDED`. WaaS prices the transaction again when it executes and refuses it, with nothing sent, if the cost rose above the quote (`failed`, `FEE_ABOVE_QUOTE`). `maxFee` is part of the request, so changing it needs a new ID.

**These limits apply to the quote, not to the chain.** The signed transaction carries no `maxFee`. A TRX transfer can only burn bandwidth (and the account activation fee) that the quote already priced. A contract call is capped on chain only by the fee limit WaaS seals into it, 1.2 times the estimated energy of the whole call, and the quote does not expose that limit. If the wallet's delegated resources are used up or withdrawn between the execution-time re-check and inclusion, or the call needs more energy than estimated, the wallet can burn TRX up to that limit, even on a sponsored quote.

```ts
const callId = crypto.randomUUID(); // persist and reuse on retries
await wallet.tron.sendContractCall(callId, {
  network: 'tron:nile',
  contract: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
  method: 'transfer', // the name only; WaaS builds the signature from the argument types
  args: [
    { type: 'address', value: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8' },
    { type: 'uint256', value: '2500000' }
  ],
  maxFee: '30000000' // allow up to 30 TRX in fees; omit to require delegated resources
});
```

| Method                                     | Behavior                                                            |
| ------------------------------------------ | ------------------------------------------------------------------- |
| `tron.prepareTransaction(id, input)`       | Quote a TRX transfer, or a call with pre-encoded `data`.            |
| `tron.prepareContractCall(id, input)`      | Quote a contract call that WaaS ABI-encodes from typed arguments.   |
| `tron.execute(id)`                         | Submit the stored quote once, paying the accepted fee if any.       |
| `tron.sendTransaction(id, input)`          | Prepare and submit a transaction in one turn of the executor.       |
| `tron.sendContractCall(id, input)`         | Prepare and submit a contract call in one turn of the executor.     |
| `tron.signMessage(id, message)`            | Sign a TIP-191 message and verify it with WaaS.                     |
| `tron.signTypedData(id, network, data)`    | Validate TIP-712 data for the network, sign and verify it.          |
| `tron.getOperation(id)` / `listOperations` | As for Solana.                                                      |

Omitting `data` sends TRX (`value` must be positive); any `data`, even `0x`, makes it a contract call. Amounts are in sun as decimal strings. TIP-712 data must name the network's chain ID (`TRON_CHAIN_IDS`) and a verifying contract; `T…` and hex addresses are both accepted and hash the same. Quotes last 15 minutes, and expiry is handled as for Solana.

`IndexerClient.getTronBalances(address, networks?)` returns TRX (6 decimals, in sun) and TRC-20 balances, with the same caveat as other indexer balances.

## Contract calls

`sendUserOperation`, `prepareUserOperation` and `executeUserOperation` are not in 0.2.0; they ship in the next release. `sendUserOperation` calls any contract from the wallet with sponsored gas. Describe the call with an ABI, the name of a function in it and its arguments, which the SDK encodes with viem, or pass pre-encoded `data`. With a typed ABI (`as const`, or viem's `erc20Abi`), function names and arguments are type-checked:

```ts
const erc20Abi = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

const paymentId = crypto.randomUUID(); // persist and reuse on retries
const payment = await wallet.sendUserOperation(paymentId, {
  chainId: 137,
  calls: [
    {
      to: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC on Polygon
      abi: erc20Abi,
      functionName: 'transfer',
      args: ['0x2222222222222222222222222222222222222222', 2_500_000n],
      // value: '0', // optional native amount in base units
    },
  ],
});
// Poll getOperation(payment.id) until it is executed or failed.
```

Use `prepareUserOperation`, then `executeUserOperation` with the same ID, when an operator should review the encoded `transaction` before it is sent. The same idempotency rules apply: retrying an ID returns the stored operation and never submits the call again. WaaS executes one call per transaction, so `calls` must contain exactly one call; calls to the wallet's own address are refused.

This is the SDK's only path for arbitrary contract calls. Never build `to`, `data`, `abi`, `functionName` or `args` from untrusted input such as a browser request; decide the target, function, arguments and value on your server and check them there. Approvals, allowances and operator rights that a call grants outlast the operation, and `WalletSwaps` does not track them. Do not expose arbitrary contract calls as a dashboard endpoint.

## Trails swaps and recovery

The optional `@polygonlabs/oms-server-wallet-sdk/trails` entry point, added in **0.2.0**, provides `WalletSwaps`, `TrailsClient`, `EvmChainReader`, quote/recovery validation and persistent execution contracts. See the [standalone backend swaps guide](docs/SWAPS-INTEGRATION.md) for complete orchestration and host storage/scheduling requirements.

```ts
import {
  TrailsClient,
  buildSwapRequest,
  validateSwapQuote,
} from '@polygonlabs/oms-server-wallet-sdk/trails';

const trails = new TrailsClient({
  apiKey: trailsApiKey, // Separate from the OMS publishable key; backend only.
  origin: applicationOrigin, // Exact origin, without a trailing slash.
});
const { TrailsContracts } = await trails.readiness();
const assets = [
  { chainId: 137, asset: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 },
  { chainId: 8453, asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
]; // Host-approved asset policy, not input supplied by a dashboard request.
const request = buildSwapRequest(
  snapshot.wallet!.address,
  {
    originChainId: 137,
    originAsset: assets[0].asset,
    destinationChainId: 8453,
    destinationAsset: assets[1].asset,
    amount: '10000000', // Base units; never pass a floating-point token amount.
  },
  assets,
);
const { intent } = await trails.quoteIntent(request);
const reviewed = await validateSwapQuote(intent, request, TrailsContracts);
// Persist and review the snapshot/digest before any funding workflow.
// This quote-only example does not activate or fund the swap.
// Use WalletSwaps for durable execution, reconciliation and recovery.
```

`TrailsClient` supports `readiness`, `getChains`, `getTokenList`, `getExactInputRoutes`, `quoteIntent`, `executeIntent`, `getIntent` and `prepareIntentRecovery`. Calls are bounded, reject redirects and unsafe integer JSON, support caller cancellation, and never automatically retry. `TrailsError` contains the method, HTTP status and numeric upstream code without upstream bodies or keys. There is no `CommitIntent` call. Readiness requires the **wire value `v1.5`**; `v1_5` is only an upstream enum identifier.

Quote validation binds the owner/recipient, chains, assets, budget, slippage, expiry, contracts and deposit precondition. It reconstructs native/ERC-20 funding calldata locally and returns an independent snapshot plus a base64url SHA-256 digest. Keep the snapshot and digest in authoritative storage; the digest is not an authentication token. The host must review any changed quote and require WaaS sponsorship when it eventually prepares the funding transfer.

`validateRecoveryPayload(prepared, intent, owner, balances)` decodes Sequence v3 calls, binds the recorded intent address/chain, restricts native/ERC-20 transfers and TrailsUtils sweeps to the owner and reviewed assets, and checks the EIP-712 hash. Supply fresh, host-observed `{asset, amount}` balances **on that intent chain**, never balances supplied by a browser. The returned `typedData` can be passed to `wallet.signTypedData`; that generic primitive validates the domain and encoding, while the caller remains responsible for the authorization's meaning. Do not expose arbitrary typed-data signing as a dashboard endpoint.

`WalletSwaps` implements durable activation, sponsored funding, settlement, delayed-deposit repair and separately confirmed source/destination recovery. Route ordinary transfers through the same coordinator; persist encrypted private records and durable wake-ups before external mutations. Recovery includes sponsored owner deployment when needed, verified typed-data signing and validation of the returned intent execution/deployment envelope. See [rollout and acceptance](https://github.com/0xsequence-demos/waas-server-wallets/blob/master/docs/SWAPS-ROLLOUT.md) for the live scenarios verified so far and recovery checks still pending.

For explicit live discovery checks, set `TRAILS_API_KEY` and run `pnpm test:trails` in the [demo repository](https://github.com/0xsequence-demos/waas-server-wallets). Setting `TRAILS_TEST_WALLET` additionally requests Polygon USDC → Base USDC and Polygon POL → USDC quotes without funding or executing them. Ordinary tests use synthetic fixtures and make no network calls.

Version `0.2.0` adds swap/recovery capabilities; the API is not yet declared stable. Pin the version and review changes before upgrading. Licensed under [Apache-2.0](LICENSE-APACHE-2.0); see [NOTICE](NOTICE) for verifier provenance. Both files are included in the npm package.

## Development

This package lives in the [`oms-wallet-typescript-sdk`](https://github.com/0xPolygon/oms-wallet-typescript-sdk) workspace. Use the Node and pnpm versions pinned at the repository root, and run commands from the root:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm --filter @polygonlabs/oms-server-wallet-sdk typecheck
pnpm --filter @polygonlabs/oms-server-wallet-sdk test:coverage
pnpm --filter @polygonlabs/oms-server-wallet-sdk test:package # pack, then install into a clean consumer with install scripts disabled
```

`pnpm --filter @polygonlabs/oms-server-wallet-sdk test:live` runs live acceptance with the variables listed in `scripts/live-acceptance.ts`: sign-in, restoring wallets after a restart, credential rotation and disabling, EVM signing and a sponsored transfer quote on Polygon, Solana devnet and Tron Nile wallets, and the attestation format WaaS sends, read from `packages/oms-server-wallet/.env`. EVM transfers are only quoted; Solana and Tron transfers are only quoted unless `LIVE_EXECUTE=1`. It writes its report to `.data/live-acceptance.json`, and records attested WaaS responses that can be copied to `tests/fixtures/live/` for offline verification. Each recording includes the request's signature header, which a `Sequence/2` attestation binds: keep raw recordings private, and use a disposable credential for fixtures you commit.

Every pull request needs a changeset (`pnpm exec changeset`, or `pnpm exec changeset add --empty` for CI, docs and tooling changes). Releases are CI-only; see the repository's [PUBLISHING.md](../../PUBLISHING.md).
