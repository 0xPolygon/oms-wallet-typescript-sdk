// Live acceptance for the server wallet SDK against a WaaS v1.2.0 deployment: sign-in, wallet
// restore across restarts, credential rotation and disabling, EVM signing and quoting, Solana
// devnet and Tron Nile wallets, and the attestation format WaaS sends.
//
//   node --import tsx --env-file=.env scripts/live-acceptance.ts
//
// Reads the same variables as the demo dashboard's acceptance: OMS_PUBLISHABLE_KEY,
// TRUSTED_PCR0S, ENCRYPTION_KEY, OIDC_PRIVATE_JWK, OIDC_ISSUER, OIDC_AUDIENCE and OMS_ORIGIN (the
// Origin the project allows). Secrets are never printed. By default nothing is sent: EVM transfers
// are only quoted (the SDK's EVM networks are mainnets), and Solana and Tron transfers are only
// quoted unless LIVE_EXECUTE=1, which sends to LIVE_SOLANA_RECIPIENT and LIVE_TRON_RECIPIENT; a
// Tron transfer pays TRX only up to LIVE_TRON_MAX_FEE sun. Credential rotation and disabling use a
// separate identity, so they never touch the main acceptance wallets.
//
// The report goes to .data/live-acceptance.json. Attested WaaS responses are recorded to
// .data/live-fixtures/ (never CommitVerifier or CompleteAuth, whose bodies hold the ID token);
// copy them to tests/fixtures/live/ to replay their attestation offline.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { Decoder, Tag } from 'cbor-x';

import {
  createServerWallet,
  createSingleProcessExecutor,
  WalletError,
  type StateStore
} from '../src/index.js';

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
const key = env('OMS_PUBLISHABLE_KEY');
const pcr0s = env('TRUSTED_PCR0S')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const allowDebugEnclave = pcr0s.includes('0'.repeat(96));
const issuer = env('OIDC_ISSUER').replace(/\/$/, '');
const audience = env('OIDC_AUDIENCE');
const origin = env('OMS_ORIGIN');
const subject = env('LIVE_SUBJECT', `acceptance-chains-${new Date().toISOString().slice(0, 10)}`);
const execute = process.env.LIVE_EXECUTE === '1';

/** An ES256 ID token from the registered issuer key. */
async function idToken(identity: string) {
  const jwk = JSON.parse(env('OIDC_PRIVATE_JWK')) as JsonWebKey;
  const signer = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const encode = (value: unknown) =>
    Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
  const thumbprint = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const kid = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(thumbprint))
  ).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 300;
  const input = `${encode({ alg: 'ES256', kid, typ: 'JWT' })}.${encode({
    iss: issuer,
    aud: audience,
    sub: identity,
    iat: now,
    exp: expiresAt,
    jti: crypto.randomUUID()
  })}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signer,
    new TextEncoder().encode(input)
  );
  return { token: `${input}.${Buffer.from(signature).toString('base64url')}`, expiresAt };
}

mkdirSync('.data/live-fixtures', { recursive: true });
const statePath = '.data/live-state.json';
const data: Record<string, string> = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : {};
/** One local state file; each identity's keys get their own prefix. */
const disk = (prefix = ''): StateStore => ({
  async read(name) {
    return data[prefix + name] ?? null;
  },
  async write(name, value) {
    data[prefix + name] = value;
    writeFileSync(statePath, JSON.stringify(data), { mode: 0o600 });
  }
});

let recorded = 0;
const secretMethods = ['CommitVerifier', 'CompleteAuth'];
const calls: Record<string, number> = {};
const attestations: Record<string, number> = {};
const cbor = new Decoder({ mapsAsObjects: false, copyBuffers: true });
function attestationVersion(encoded: string): string {
  try {
    const signed = cbor.decode(Buffer.from(encoded, 'base64'));
    const payload = cbor.decode((signed instanceof Tag ? signed.value : signed)[2]);
    return new TextDecoder().decode(payload.get('user_data')).split(':')[0];
  } catch {
    return 'unreadable';
  }
}
const recording: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const path = new URL(String(input)).pathname;
  const method = path.split('/').pop()!;
  calls[method] = (calls[method] ?? 0) + 1;
  const document = response.headers.get('X-Attestation-Document');
  if (path.startsWith('/v1/Waas') && document) {
    const version = attestationVersion(document);
    attestations[version] = (attestations[version] ?? 0) + 1;
  }
  if (path.startsWith('/v1/Waas') && !secretMethods.includes(method)) {
    const headers = new Headers(init?.headers);
    const fixture = {
      method: 'POST',
      path,
      requestBody: String(init?.body),
      responseBody: await response.clone().text(),
      status: response.status,
      nonce: headers.get('X-Attestation-Nonce'),
      boundHeader: headers.get('OMS-Wallet-Signature') ?? '',
      encodedDocument: response.headers.get('X-Attestation-Document'),
      trustedPcr0s: pcr0s,
      now: new Date().toISOString()
    };
    writeFileSync(
      `.data/live-fixtures/${String(++recorded).padStart(3, '0')}-${method}.json`,
      `${JSON.stringify(fixture, null, 2)}\n`
    );
  }
  return response;
};

const open = (identity: string, prefix = '') =>
  createServerWallet({
    publishableKey: key,
    origin,
    oidc: {
      subject: identity,
      issuer,
      audience,
      getIdToken: () => idToken(identity)
    },
    store: { adapter: disk(prefix), encryptionKey: env('ENCRYPTION_KEY') },
    executor: createSingleProcessExecutor(),
    attestation: { trustedPcr0s: pcr0s, allowDebugEnclave },
    approval: 'allow-immediate',
    fetch: recording
  });
const wallet = open(subject);

const report: { check: string; result: 'passed' | 'failed' | 'skipped'; detail?: unknown }[] = [];
async function check(name: string, run: () => Promise<unknown>) {
  try {
    const detail = await run();
    report.push({ check: name, result: 'passed', detail });
  } catch (error) {
    const detail =
      error instanceof WalletError
        ? { ...error, code: error.code, message: error.message }
        : String(error);
    report.push({ check: name, result: 'failed', detail });
  }
  console.log(JSON.stringify(report.at(-1)));
}
const skip = (name: string, why: string) => {
  report.push({ check: name, result: 'skipped', detail: why });
  console.log(JSON.stringify(report.at(-1)));
};
const id = (name: string) => `${name}-${Date.now()}`;
const executed = async <T extends { status: string; txnHash?: string; error?: string }>(
  read: () => Promise<T | null>
) => {
  for (let i = 0; i < 30; i++) {
    const op = await read();
    if (!op) throw new Error('Operation not found');
    if (op.status === 'executed') {
      if (!op.txnHash) throw new Error('Executed without a transaction hash');
      return op;
    }
    if (!['pending', 'submitting', 'unknown'].includes(op.status))
      throw new Error(`Transfer ended ${op.status}${op.error ? ` (${op.error})` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
  throw new Error('Transfer did not execute within two minutes');
};
const balances = async <T extends { readonly errors: readonly unknown[] }>(result: Promise<T>) => {
  const value = await result;
  if (value.errors.length) throw new Error(`Balance errors: ${JSON.stringify(value.errors)}`);
  return value;
};

const snapshot = await wallet.createOrRestore({ families: ['evm', 'solana', 'tron'] });
const solana = snapshot.wallets.solana!.address;
const tron = snapshot.wallets.tron!.address;
await check('create and restore one wallet per family', async () => {
  const again = await wallet.createOrRestore({ families: ['evm', 'solana', 'tron'] });
  if (JSON.stringify(again.wallets) !== JSON.stringify(snapshot.wallets))
    throw new Error('Restore returned different wallets');
  return { evm: snapshot.wallet?.address, solana, tron };
});

await check(
  'restore after a restart reuses the wallets and credential without signing in',
  async () => {
    const before = (await wallet.inspect()).credentialId;
    const signIns = calls.CommitVerifier ?? 0;
    const restarted = open(subject);
    const restored = await restarted.createOrRestore({ families: ['evm', 'solana', 'tron'] });
    if (JSON.stringify(restored.wallets) !== JSON.stringify(snapshot.wallets))
      throw new Error('Restart restored different wallets');
    if (restored.credentialId !== before) throw new Error('Restart replaced the credential');
    if ((calls.CommitVerifier ?? 0) !== signIns) throw new Error('Restart signed in again');
    return { credentialId: restored.credentialId };
  }
);

const evm = snapshot.wallet!.address;
await check('EVM message signing on Polygon, verified by WaaS', async () => {
  const op = await wallet.evm.signMessage({
    idempotencyKey: id('live-evm-sign'),
    chainId: 137,
    message: 'OMS server wallet acceptance'
  });
  if (op.status !== 'signed' || !op.verified) throw new Error(`Signing ended ${op.status}`);
  return { status: op.status, verified: op.verified };
});
await check('EVM EIP-712 signing on Polygon, verified by WaaS', async () => {
  const op = await wallet.evm.signTypedData({
    idempotencyKey: id('live-evm-712'),
    chainId: 137,
    typedData: {
      domain: { name: 'Acceptance', version: '1', chainId: 137, verifyingContract: evm },
      types: {
        Check: [
          { name: 'wallet', type: 'address' },
          { name: 'note', type: 'string' }
        ]
      },
      primaryType: 'Check',
      message: { wallet: evm, note: 'OMS server wallet acceptance' }
    }
  });
  if (op.status !== 'signed' || !op.verified) throw new Error(`Signing ended ${op.status}`);
  return { status: op.status, verified: op.verified };
});
await check('EVM operation ID retry returns the stored result without calling WaaS', async () => {
  const idempotencyKey = id('live-evm-retry');
  const first = await wallet.evm.signMessage({
    idempotencyKey,
    chainId: 137,
    message: 'OMS server wallet retry'
  });
  const signed = calls.SignMessage ?? 0;
  const again = await wallet.evm.signMessage({
    idempotencyKey,
    chainId: 137,
    message: 'OMS server wallet retry'
  });
  if (again.signature !== first.signature) throw new Error('Retry returned another signature');
  if ((calls.SignMessage ?? 0) !== signed) throw new Error('Retry signed again');
  return { signature: again.signature };
});
await check('EVM sponsored transfer quote on Polygon (never executed)', async () => {
  const op = await wallet.evm.prepareTransfer({
    idempotencyKey: id('live-evm-quote'),
    chainId: 137,
    to: evm,
    asset: 'native',
    amount: '1'
  });
  if (op.status !== 'quoted' || !op.quote?.sponsored) throw new Error(`Quote ended ${op.status}`);
  return { status: op.status, sponsored: op.quote.sponsored, expiresAt: op.quote.expiresAt };
});

const lifecycle = open(`${subject}-lifecycle`, 'lifecycle:');
const lifecycleWallet = (await lifecycle.createOrRestore()).wallet!;
await check('credential rotation keeps the wallet and replaces the credential', async () => {
  const before = (await lifecycle.inspect()).credentialId;
  const rotated = await lifecycle.rotateCredential();
  if (rotated.wallet?.address !== lifecycleWallet.address)
    throw new Error('Rotation changed the wallet');
  if (!rotated.credentialId || rotated.credentialId === before)
    throw new Error('Rotation kept the credential');
  return { wallet: rotated.wallet?.address };
});
await check('a disabled wallet refuses to sign; re-enabling restores the same wallet', async () => {
  await lifecycle.disable();
  const refused = await lifecycle.evm
    .signMessage({ idempotencyKey: id('live-disabled-sign'), chainId: 137, message: 'disabled' })
    .catch((error) => error);
  if (!(refused instanceof WalletError) || refused.code !== 'WALLET_DISABLED')
    throw new Error('A disabled wallet signed');
  const enabled = await lifecycle.enable();
  if (enabled.wallet?.address !== lifecycleWallet.address)
    throw new Error('Re-enabling returned another wallet');
  const op = await lifecycle.evm.signMessage({
    idempotencyKey: id('live-enabled-sign'),
    chainId: 137,
    message: 'enabled'
  });
  if (op.status !== 'signed') throw new Error(`Signing after re-enabling ended ${op.status}`);
  return { wallet: enabled.wallet?.address };
});

await check('Solana message signing, verified by WaaS', () =>
  wallet.solana.signMessage({
    idempotencyKey: id('live-sol-sign'),
    message: 'OMS server wallet acceptance'
  })
);
await check('Solana devnet balances', () =>
  balances(wallet.indexer.getSolanaBalances({ networks: ['solana:devnet'] }))
);
const solanaRecipient = process.env.LIVE_SOLANA_RECIPIENT;
if (!solanaRecipient) skip('Solana transfer quote', 'Set LIVE_SOLANA_RECIPIENT.');
else {
  const transfer = {
    network: 'solana:devnet',
    to: solanaRecipient,
    asset: 'native',
    amount: '1000'
  } as const;
  await check('Solana sponsored transfer quote expires within about a minute', async () => {
    const op = await wallet.solana.prepareTransfer({
      idempotencyKey: id('live-sol-quote'),
      ...transfer
    });
    const lifetime = Date.parse(op.quote!.expiresAt) - Date.now();
    if (!op.quote!.sponsored || lifetime > 65_000) throw new Error('Unexpected quote');
    return { sponsored: op.quote!.sponsored, lifetimeMs: lifetime };
  });
  await check('Solana expired quote is refused with nothing sent', async () => {
    const op = await wallet.solana.prepareTransfer({
      idempotencyKey: id('live-sol-expiry'),
      ...transfer
    });
    await new Promise((resolve) =>
      setTimeout(resolve, Date.parse(op.quote!.expiresAt) - Date.now() + 2_000)
    );
    const result = await wallet.solana
      .execute({ idempotencyKey: op.id, reviewId: op.reviewId! })
      .catch((error) => error);
    if (!(result instanceof WalletError) || result.code !== 'QUOTE_EXPIRED')
      throw new Error('Expired quote was not refused');
    const status = (await wallet.solana.getOperation(op.id))?.status;
    if (status !== 'expired') throw new Error(`Expired quote left the operation ${status}`);
    return status;
  });
  if (!execute) skip('Solana transfer execution', 'Set LIVE_EXECUTE=1 to send 1000 lamports.');
  else
    await check('Solana sponsored transfer executes', async () => {
      const op = await wallet.solana.sendTransfer({
        idempotencyKey: id('live-sol-send'),
        ...transfer
      });
      return executed(() => wallet.solana.refreshOperation(op.id));
    });
}

await check('Tron message signing, verified by WaaS', () =>
  wallet.tron.signMessage({
    idempotencyKey: id('live-trx-sign'),
    message: 'OMS server wallet acceptance'
  })
);
await check('Tron TIP-712 signing, verified by WaaS', () =>
  wallet.tron.signTypedData({
    idempotencyKey: id('live-trx-712'),
    network: 'tron:nile',
    typedData: {
      domain: { name: 'Acceptance', version: '1', chainId: 3448148188, verifyingContract: tron },
      types: {
        Check: [
          { name: 'wallet', type: 'address' },
          { name: 'note', type: 'string' }
        ]
      },
      primaryType: 'Check',
      message: { wallet: tron, note: 'OMS server wallet acceptance' }
    }
  })
);
await check('Tron Nile balances', () =>
  balances(wallet.indexer.getTronBalances({ networks: ['tron:nile'] }))
);
const tronRecipient = process.env.LIVE_TRON_RECIPIENT;
if (!tronRecipient) skip('Tron transfer quote', 'Set LIVE_TRON_RECIPIENT.');
else {
  const transfer = { network: 'tron:nile', to: tronRecipient, value: '1' } as const;
  await check('Tron quote without maxFee is sent only when sponsored', async () => {
    const result = await wallet.tron
      .prepareTransaction({ idempotencyKey: id('live-trx-quote'), ...transfer })
      .catch((error) => error);
    if (result instanceof WalletError && result.code === 'SPONSORSHIP_REQUIRED')
      return 'not covered by delegated resources: refused as expected';
    if (result instanceof Error) throw result;
    return { sponsored: result.quote?.sponsored };
  });
  const maxFee = process.env.LIVE_TRON_MAX_FEE;
  if (!execute) skip('Tron transfer execution', 'Set LIVE_EXECUTE=1 to send 1 sun.');
  else
    await check('Tron transfer executes within maxFee', async () => {
      const op = await wallet.tron.sendTransaction({
        idempotencyKey: id('live-trx-send'),
        ...transfer,
        maxFee
      });
      return executed(() => wallet.tron.refreshOperation(op.id));
    });
}

await check('every WaaS response carried a known attestation format', async () => {
  const unknown = Object.keys(attestations).filter(
    (version) => version !== 'Sequence/1' && version !== 'Sequence/2'
  );
  if (unknown.length) throw new Error(`Unexpected attestation formats: ${unknown.join(', ')}`);
  return attestations;
});

writeFileSync(
  '.data/live-acceptance.json',
  `${JSON.stringify({ subject, at: new Date().toISOString(), report }, null, 2)}\n`
);
const failed = report.filter((entry) => entry.result === 'failed').length;
console.log(`${report.length} checks, ${failed} failed, ${recorded} attested responses recorded.`);
process.exitCode = failed ? 1 : 0;
