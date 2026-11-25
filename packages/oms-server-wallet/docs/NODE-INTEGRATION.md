# Node.js / TypeScript wallet integration walkthrough

This guide shows how to integrate `@polygonlabs/oms-server-wallet-sdk` (`0.3.0`) into a Node.js 22+ TypeScript backend: configure OpenID Connect (OIDC), create or restore a wallet, sign messages and typed data, and prepare, review, execute, and observe sponsored transfers and contract calls. For cross-chain swaps and recovery, continue with [the backend swaps guide](SWAPS-INTEGRATION.md).

**Your backend supplies a trusted identity; the SDK authenticates a credential for that identity; WaaS performs wallet signing.** Register your OIDC issuer and audience with OMS once, then supply fresh ES256 ID tokens through `oidc.getIdToken(subject)` whenever authentication or renewal is needed.

## 1. Install and configure

Requires **Node 22+**:

```sh
mkdir oms-node-example
cd oms-node-example
npm init -y
npm pkg set type=module
npm install @polygonlabs/oms-server-wallet-sdk@0.3.0 jose@6.2.10
npm install --save-dev typescript@5.9.3 tsx@4.23.15 @types/node@22
mkdir src
```

Generate local secrets once (`setup-secrets.mjs`):

```js
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { exportJWK, generateKeyPair } from 'jose';

const { privateKey } = await generateKeyPair('ES256', { extractable: true });
const jwk = await exportJWK(privateKey);
await writeFile(
  '.env',
  [
    `OIDC_PRIVATE_JWK='${JSON.stringify(jwk)}'`,
    `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
    'OIDC_ISSUER=https://wallet-api.example.com',
    'OIDC_AUDIENCE=replace-with-your-registered-audience',
    'OMS_PUBLISHABLE_KEY=replace-with-your-project-key',
    'APP_ORIGIN=https://wallet-api.example.com',
    'DATABASE_PATH=.data/wallets.sqlite',
    ''
  ].join('\n'),
  { flag: 'wx', mode: 0o600 }
);
```

## 2. Publish your OIDC discovery & JWKS endpoints

Create `src/oidc.ts` to publish `/.well-known/openid-configuration` and `/oidc/jwks` (public keys only — never expose private JWK `d` or a public token-minting endpoint) and mint ES256 ID tokens internally via `issueIdToken(subject)`:

```ts
import { randomUUID } from 'node:crypto';
import { SignJWT, calculateJwkThumbprint, importJWK, type JWK } from 'jose';

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

export const issuer = required('OIDC_ISSUER').replace(/\/$/, '');
export const audience = required('OIDC_AUDIENCE');

const privateJwk: JWK = JSON.parse(required('OIDC_PRIVATE_JWK'));
const signingKey = await importJWK(privateJwk, 'ES256');
const publicJwk = {
  kty: privateJwk.kty,
  crv: privateJwk.crv,
  x: privateJwk.x,
  y: privateJwk.y
};
const kid = await calculateJwkThumbprint(publicJwk);

export const jwks = { keys: [{ ...publicJwk, kid, use: 'sig', alg: 'ES256' }] };
export const discovery = {
  issuer,
  jwks_uri: `${issuer}/oidc/jwks`,
  id_token_signing_alg_values_supported: ['ES256'],
  subject_types_supported: ['public'],
  claims_supported: ['iss', 'aud', 'sub', 'iat', 'exp', 'jti']
};

export async function issueIdToken(subject: string) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 300;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .setJti(randomUUID())
    .sign(signingKey);
  return { token, expiresAt }; // Unix seconds
}
```

## 3. Wire durable storage with `createServerWalletService`

Create `src/wallets.ts`. For a single-process Node service, implement `NamespacedStateStore` over SQLite (with `PRAGMA synchronous = FULL`) and pass `createSingleProcessExecutorPool()`. For clustered Node backends, replace `executor` with a distributed per-namespace exclusive lock; for Cloudflare Durable Objects (one DO per identity), use `createServerWallet` with `createSingleProcessExecutor()`.

```ts
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createServerWalletService,
  createSingleProcessExecutorPool,
  type NamespacedStateStore
} from '@polygonlabs/oms-server-wallet-sdk';
import { audience, issuer, issueIdToken, required } from './oidc.js';

const filename = resolve(process.env.DATABASE_PATH ?? '.data/wallets.sqlite');
mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(filename);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  CREATE TABLE IF NOT EXISTS wallet_state (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (namespace, key)
  );
`);

const storage: NamespacedStateStore = {
  async read(namespace, key) {
    const row = db
      .prepare('SELECT value FROM wallet_state WHERE namespace = ? AND key = ?')
      .get(namespace, key) as { value: string } | undefined;
    return row?.value ?? null;
  },
  async write(namespace, key, value) {
    db.prepare(
      `INSERT INTO wallet_state (namespace, key, value) VALUES (?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`
    ).run(namespace, key, value);
  }
};

export const wallets = createServerWalletService({
  publishableKey: required('OMS_PUBLISHABLE_KEY'),
  origin: required('APP_ORIGIN'),
  oidc: {
    issuer,
    audience,
    getIdToken: (subject) => issueIdToken(subject)
  },
  storage: {
    adapter: storage,
    encryptionKey: required('ENCRYPTION_KEY')
  },
  executor: createSingleProcessExecutorPool()
  // Staging & production keys use SDK stage-pinned PCR0s automatically.
  // For dev/local keys running a debug enclave, explicitly opt in:
  // attestation: { allowDebugEnclave: true }
});
```

The SDK automatically computes the canonical storage namespace (`[waasOrigin, projectId, issuer, audience, subject]`), encrypts every record with AES-256-GCM bound to that namespace and key, advances monotonic nonces before dispatch, and verifies AWS Nitro attestation on every WaaS response.

### Signing-only workers: `createEphemeralServerWallet`

A worker that only signs, such as a webhook signer or a login challenge, needs no storage or lock. Provision the identity's wallets with the durable service once, then sign from memory-only handles:

```ts
import { createEphemeralServerWallet } from '@polygonlabs/oms-server-wallet-sdk';

export async function signChallenge(subject: string, message: string) {
  const signer = createEphemeralServerWallet({
    publishableKey: required('OMS_PUBLISHABLE_KEY'),
    origin: required('APP_ORIGIN'),
    oidc: { issuer, audience, subject, getIdToken: () => issueIdToken(subject) }
  });
  try {
    await signer.restore({ families: ['evm'] });
    return await signer.evm.signMessage({ chainId: 137, message });
  } finally {
    await signer.close();
  }
}
```

Each handle signs in, so for steady traffic keep a small pool of long-lived handles instead of one per request. Ephemeral handles cannot send transactions; see the README section "Ephemeral signer" for the full contract.

## 4. Create, sign, prepare, review, execute, and observe

```ts
import {
  describeOperation,
  isWalletError,
  parseAmount
} from '@polygonlabs/oms-server-wallet-sdk';
import { wallets } from './wallets.js';

// Always obtain `subject` from your own authentication/authorization layer.
const wallet = wallets.forSubject('customer:12345');

// 1. Create or restore EVM (and optionally Solana/Tron)
const snapshot = await wallet.createOrRestore({ families: ['evm'] });
console.log('EVM address:', snapshot.wallets.evm?.address);

// 2. Plain-message & EIP-712 signing (verified with WaaS)
const signed = await wallet.evm.signMessage({
  idempotencyKey: 'demo-message-0001',
  chainId: 137,
  message: 'Hello from our backend'
});
console.log('Signed:', signed.status, signed.verified);

// 3. Prepare a sponsored transfer without submitting
const transferId = 'demo-transfer-0001'; // Persist before calling the SDK
const prepared = await wallet.evm.prepareTransfer({
  idempotencyKey: transferId,
  chainId: 137,
  to: snapshot.wallets.evm!.address,
  asset: 'native',
  amount: parseAmount('0.001', 18)
});

// 4. After operator / policy approval of the reviewed payload, execute bound to `reviewId`
if (prepared.status === 'quoted' && prepared.reviewId) {
  await wallet.evm.execute({
    idempotencyKey: transferId,
    reviewId: prepared.reviewId
  });
}

// 5. Observe settlement outside exclusive ownership
const waited = await wallet.evm.waitForOperation(transferId, { timeoutMs: 30_000 });
switch (waited.outcome) {
  case 'executed': // WaaS executed it; confirm the receipt on-chain before marking it paid
    break;
  case 'failed':
  case 'expired': // not executed; prepare a replacement only if describeOperation says safe-to-reprepare
    break;
  default: // reconciliation-required, timed-out, cancelled: keep the original operation open
    console.log(waited.outcome, describeOperation(waited.operation));
}

// 6. Unattested display balances (never use as proof of funds)
try {
  const balances = await wallet.indexer.getEvmBalances({ chainIds: [137] });
  console.log('Polygon balances:', balances.items);
} catch (error) {
  if (isWalletError(error)) console.error(error.code, error.message);
}
```

## 5. Failure & settlement contract

| Status / Error | Meaning | What to do |
| --- | --- | --- |
| `quoted` | Prepared and sponsored, not submitted | Review terms, then call `execute({ idempotencyKey, reviewId })` before expiry. |
| `submitting` / `pending` | Claimed or in flight | Call `refreshOperation(id)` or `waitForOperation(id, ...)`. Never issue a replacement transfer. |
| `unknown` (`SUBMISSION_UNCERTAIN`) | Response lost after submission | Keep refreshing the same operation ID. |
| `unknown` (`RECONCILIATION_REQUIRED`) | Unconfirmed past the 2-minute post-expiry grace window | Stays open; reconcile the original operation and WaaS `txnId` before authorizing any replacement. |
| `executed` | WaaS reported execution | Record `txnHash` and verify on-chain receipt/confirmations before treating payment as settled. |
| `expired` (`QUOTE_EXPIRED`, `provenUnsent: true`) | Quote expired locally before submission | Nothing was sent; prepare and review again under a new `idempotencyKey`. |
| `expired` (`QUOTE_EXPIRED`, `operatorResolved: true`) | An operator resolved it with `resolveReconciliation` | Treated as not sent on the operator's word; prepare and review again under a new `idempotencyKey`. |
| `failed` (`EXECUTE_REFUSED`, `provenUnsent: true`) | WaaS refused before claiming | Nothing was sent; inspect error and prepare under a new `idempotencyKey` if desired. |
| `STALE_REVIEW` | `reviewId` does not match the prepared operation | Re-read and review the current operation before executing. |
| `APPROVAL_REQUIRED` | Immediate `send*` called on an ID prepared for review | Review and call `execute({ idempotencyKey, reviewId })` instead. |

Use `describeOperation(operation)` to map any persisted operation to an explicit next action (`await-review`, `poll-original`, `reconcile-original`, `safe-to-reprepare`, or `done`).

See [API.md](../API.md) for the complete root API reference.
