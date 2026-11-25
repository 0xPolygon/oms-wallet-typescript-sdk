// Live acceptance for the server wallet SDK against a WaaS v1.2.0 deployment: sign-in, wallet
// restore across restarts, credential rotation and disabling, EVM signing and quoting, Solana
// devnet, Tron Nile and Polygon Amoy wallets, ephemeral signers, and the attestation format WaaS
// sends.
//
//   node --import tsx --env-file=.env scripts/live-acceptance.ts
//
// Reads the same variables as the demo dashboard's acceptance: OMS_PUBLISHABLE_KEY,
// TRUSTED_PCR0S, ENCRYPTION_KEY, OIDC_PRIVATE_JWK, OIDC_ISSUER, OIDC_AUDIENCE and OMS_ORIGIN (the
// Origin the project allows). Secrets are never printed. Set LIVE_SUBJECT to a fixed identity to
// keep funded testnet wallets across runs (the default subject changes daily).
//
// By default nothing is sent: transfers are only quoted. LIVE_EXECUTE=1 sends small testnet
// transactions only: a sponsored zero-value call on Polygon Amoy (plus LIVE_EVM_AMOUNT wei of POL
// when set),
// LIVE_SOLANA_AMOUNT lamports on Solana devnet (default 0.001 SOL, enough to open a new account)
// and LIVE_TRON_AMOUNT sun on Tron Nile (default 1 sun, paying TRX only up to LIVE_TRON_MAX_FEE),
// plus LIVE_TRC20_AMOUNT base units of Nile USDT (default 1, fee cap LIVE_TRC20_MAX_FEE sun).
// Recipients default to the separate lifecycle identity's wallets, so funds stay in test wallets;
// LIVE_EVM_RECIPIENT, LIVE_SOLANA_RECIPIENT and LIVE_TRON_RECIPIENT override them. Mainnet
// transfers are never sent. Credential rotation and disabling use the lifecycle identity, so they
// never touch the main acceptance wallets.
//
// The report goes to .data/live-acceptance.json. Attested WaaS responses are recorded to
// .data/live-fixtures/ (never CommitVerifier or CompleteAuth, whose bodies hold the ID token);
// copy them to tests/fixtures/live/ to replay their attestation offline.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { Decoder, Tag } from 'cbor-x';

import {
  createEphemeralServerWallet,
  createServerWallet,
  createSingleProcessExecutor,
  WalletError,
  type StateStore,
  type TypedDataSigningRequest
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

// Typed-data signing is opt-in. This policy approves only the acceptance run's own 'Check' payloads.
const signing = {
  authorizeTypedData: (request: TypedDataSigningRequest) =>
    request.typedData.primaryType === 'Check'
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
    storage: { adapter: disk(prefix), encryptionKey: env('ENCRYPTION_KEY') },
    executor: createSingleProcessExecutor(),
    attestation: { trustedPcr0s: pcr0s, allowDebugEnclave },
    approval: 'allow-immediate',
    signing,
    fetch: recording
  });
// Each identity's records live under its own key prefix, so a different subject never reads them.
const wallet = open(subject, `${subject}:`);

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
  return { evm: snapshot.wallets.evm?.address, solana, tron };
});

await check(
  'restore after a restart reuses the wallets and credential without signing in',
  async () => {
    const before = (await wallet.inspect()).credentialId;
    const signIns = calls.CommitVerifier ?? 0;
    const restarted = open(subject, `${subject}:`);
    const restored = await restarted.createOrRestore({ families: ['evm', 'solana', 'tron'] });
    if (JSON.stringify(restored.wallets) !== JSON.stringify(snapshot.wallets))
      throw new Error('Restart restored different wallets');
    if (restored.credentialId !== before) throw new Error('Restart replaced the credential');
    if ((calls.CommitVerifier ?? 0) !== signIns) throw new Error('Restart signed in again');
    return { credentialId: restored.credentialId };
  }
);

const evm = snapshot.wallets.evm!.address;
await check('EVM message signing on Polygon, verified by WaaS', async () => {
  const op = await wallet.evm.signMessage({
    idempotencyKey: id('live-evm-sign'),
    chainId: 137,
    message: 'OMS server wallet acceptance'
  });
  if (op.status !== 'signed' || !op.verified) throw new Error(`Signing ended ${op.status}`);
  return { status: op.status, verified: op.verified };
});
/** EIP-712 acceptance payload; the verifying contract is any address other than the wallet. */
const acceptanceTypedData = (verifyingContract: string) => ({
  domain: { name: 'Acceptance', version: '1', chainId: 137, verifyingContract },
  types: {
    Check: [
      { name: 'wallet', type: 'address' },
      { name: 'note', type: 'string' }
    ]
  },
  primaryType: 'Check',
  message: { wallet: evm, note: 'OMS server wallet acceptance' }
});
await check('EVM EIP-712 signing on Polygon, verified by WaaS', async () => {
  const op = await wallet.evm.signTypedData({
    idempotencyKey: id('live-evm-712'),
    chainId: 137,
    typedData: acceptanceTypedData('0x000000000000000000000000000000000000dEaD')
  });
  if (op.status !== 'signed' || !op.verified) throw new Error(`Signing ended ${op.status}`);
  return { status: op.status, verified: op.verified };
});
await check(
  'EVM EIP-712 with the wallet as verifyingContract is refused without signing',
  async () => {
    const signed = calls.SignTypedData ?? 0;
    try {
      await wallet.evm.signTypedData({
        idempotencyKey: id('live-evm-712-self'),
        chainId: 137,
        typedData: acceptanceTypedData(evm)
      });
    } catch (error) {
      if (!(error instanceof WalletError) || error.code !== 'INVALID_TYPED_DATA') throw error;
      if ((calls.SignTypedData ?? 0) !== signed) throw new Error('SignTypedData was called.');
      return { code: error.code };
    }
    throw new Error('Self-domain typed data was signed.');
  }
);
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
  return {
    status: op.status,
    sponsored: op.quote.sponsored,
    quoteLifetimeMs: Date.parse(op.quote.expiresAt) - Date.parse(op.createdAt)
  };
});

const lifecycle = open(`${subject}-lifecycle`, `${subject}-lifecycle:`);
const lifecycleWallets = (await lifecycle.createOrRestore({ families: ['evm', 'solana', 'tron'] }))
  .wallets;
const lifecycleWallet = lifecycleWallets.evm!;
await check('credential rotation keeps the wallet and replaces the credential', async () => {
  const before = (await lifecycle.inspect()).credentialId;
  const rotated = await lifecycle.rotateCredential();
  if (rotated.wallets.evm?.address !== lifecycleWallet.address)
    throw new Error('Rotation changed the wallet');
  if (!rotated.credentialId || rotated.credentialId === before)
    throw new Error('Rotation kept the credential');
  return { wallet: rotated.wallets.evm?.address };
});
await check('a disabled wallet refuses to sign; re-enabling restores the same wallet', async () => {
  await lifecycle.disable();
  const refused = await lifecycle.evm
    .signMessage({ idempotencyKey: id('live-disabled-sign'), chainId: 137, message: 'disabled' })
    .catch((error) => error);
  if (!(refused instanceof WalletError) || refused.code !== 'WALLET_DISABLED')
    throw new Error('A disabled wallet signed');
  const enabled = await lifecycle.enable();
  if (enabled.wallets.evm?.address !== lifecycleWallet.address)
    throw new Error('Re-enabling returned another wallet');
  const op = await lifecycle.evm.signMessage({
    idempotencyKey: id('live-enabled-sign'),
    chainId: 137,
    message: 'enabled'
  });
  if (op.status !== 'signed') throw new Error(`Signing after re-enabling ended ${op.status}`);
  return { wallet: enabled.wallets.evm?.address };
});

const amoy = 80002;
await check('EVM message signing on Polygon Amoy, verified by WaaS', async () => {
  const op = await wallet.evm.signMessage({
    idempotencyKey: id('live-amoy-sign'),
    chainId: amoy,
    message: 'OMS server wallet acceptance'
  });
  if (op.status !== 'signed' || !op.verified) throw new Error(`Signing ended ${op.status}`);
  return { status: op.status, verified: op.verified };
});
await check('Polygon Amoy balances', () =>
  balances(wallet.indexer.getEvmBalances({ chainIds: [amoy] }))
);
const amoyRecipient = process.env.LIVE_EVM_RECIPIENT ?? lifecycleWallet.address;
const amoyAmount = process.env.LIVE_EVM_AMOUNT;
await check('EVM sponsored transfer quote on Polygon Amoy', async () => {
  const op = await wallet.evm.prepareTransfer({
    idempotencyKey: id('live-amoy-quote'),
    chainId: amoy,
    to: amoyRecipient,
    asset: 'native',
    amount: amoyAmount ?? '1'
  });
  if (op.status !== 'quoted' || !op.quote?.sponsored) throw new Error(`Quote ended ${op.status}`);
  return {
    status: op.status,
    sponsored: op.quote.sponsored,
    quoteLifetimeMs: Date.parse(op.quote.expiresAt) - Date.parse(op.createdAt)
  };
});
if (!execute)
  skip('EVM zero-value call on Polygon Amoy', 'Set LIVE_EXECUTE=1 to send a sponsored call.');
else
  await check(
    'EVM sponsored zero-value call executes on Polygon Amoy (prepare, review, execute); getTransactionStatus agrees',
    async () => {
      const prepared = await wallet.evm.prepareCall({
        idempotencyKey: id('live-amoy-call'),
        chainId: amoy,
        to: amoyRecipient,
        value: '0',
        data: '0x'
      });
      if (prepared.status !== 'quoted' || !prepared.reviewId)
        throw new Error(`Prepare ended ${prepared.status}`);
      await wallet.evm.execute({ idempotencyKey: prepared.id, reviewId: prepared.reviewId });
      const done = await executed(() => wallet.evm.refreshOperation(prepared.id));
      const status = await wallet.evm.getTransactionStatus(prepared.quote!.txnId);
      if (
        status.status !== 'executed' ||
        status.txnHash?.toLowerCase() !== done.txnHash?.toLowerCase()
      )
        throw new Error(`getTransactionStatus returned ${JSON.stringify(status)}`);
      return {
        to: amoyRecipient,
        txnHash: done.txnHash,
        explorer: `https://amoy.polygonscan.com/tx/${done.txnHash}`
      };
    }
  );
if (!execute || !amoyAmount)
  skip('EVM native transfer on Polygon Amoy', 'Set LIVE_EXECUTE=1 and LIVE_EVM_AMOUNT (wei).');
else
  await check('EVM sponsored native transfer executes on Polygon Amoy', async () => {
    const op = await wallet.evm.sendTransfer({
      idempotencyKey: id('live-amoy-send'),
      chainId: amoy,
      to: amoyRecipient,
      asset: 'native',
      amount: amoyAmount
    });
    const done = await executed(() => wallet.evm.refreshOperation(op.id));
    return { to: amoyRecipient, txnHash: done.txnHash };
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
const solanaRecipient = process.env.LIVE_SOLANA_RECIPIENT ?? lifecycleWallets.solana!.address;
{
  const transfer = {
    network: 'solana:devnet',
    to: solanaRecipient,
    asset: 'native',
    amount: process.env.LIVE_SOLANA_AMOUNT ?? '1000000'
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
  if (!execute) skip('Solana transfer execution', 'Set LIVE_EXECUTE=1 to send devnet SOL.');
  else
    await check('Solana sponsored transfer executes; getTransactionStatus agrees', async () => {
      const op = await wallet.solana.sendTransfer({
        idempotencyKey: id('live-sol-send'),
        ...transfer
      });
      const done = await executed(() => wallet.solana.refreshOperation(op.id));
      const status = await wallet.solana.getTransactionStatus(op.quote!.txnId);
      if (status.status !== 'executed' || status.txnHash !== done.txnHash)
        throw new Error(`getTransactionStatus returned ${JSON.stringify(status)}`);
      return {
        to: transfer.to,
        txnHash: done.txnHash,
        quoteLifetimeMs: Date.parse(op.quote!.expiresAt) - Date.parse(op.createdAt)
      };
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
      domain: {
        name: 'Acceptance',
        version: '1',
        chainId: 3448148188,
        verifyingContract: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'
      },
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
const trc20 = {
  network: 'tron:nile',
  to: lifecycleWallets.tron!.address,
  asset: process.env.LIVE_TRON_TOKEN ?? 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', // Nile USDT
  amount: process.env.LIVE_TRC20_AMOUNT ?? '1',
  // A first TRC-20 transfer to an account burns more energy than a TRX transfer.
  maxQuotedFee: process.env.LIVE_TRC20_MAX_FEE ?? '30000000'
} as const;
if (!execute)
  await check(
    'observation: Tron TRC-20 transfer call is accepted and quoted (quote only)',
    async () => {
      try {
        const op = await wallet.tron.prepareTransfer({
          idempotencyKey: id('live-trc20-quote'),
          ...trc20
        });
        return {
          status: op.status,
          sponsored: op.quote?.sponsored,
          quoteLifetimeMs: op.quote
            ? Date.parse(op.quote.expiresAt) - Date.parse(op.createdAt)
            : null
        };
      } catch (error) {
        // The wallet may hold none of the token; a reverting simulation is reported, not failed.
        if (!(error instanceof WalletError)) throw error;
        return {
          refused: error.code,
          ...('upstreamCode' in error ? { upstreamCode: error.upstreamCode } : {})
        };
      }
    }
  );
else
  await check(
    'Tron TRC-20 (USDT) transfer executes within maxQuotedFee; getTransactionStatus agrees',
    async () => {
      const op = await wallet.tron.sendTransfer({
        idempotencyKey: id('live-trc20-send'),
        ...trc20
      });
      const done = await executed(() => wallet.tron.refreshOperation(op.id));
      const status = await wallet.tron.getTransactionStatus(op.quote!.txnId);
      if (status.status !== 'executed' || status.txnHash !== done.txnHash)
        throw new Error(`getTransactionStatus returned ${JSON.stringify(status)}`);
      return {
        to: trc20.to,
        amount: trc20.amount,
        sponsored: op.quote?.sponsored,
        fee: op.fee ? `${op.fee.value} sun` : 'none',
        txnHash: done.txnHash,
        explorer: `https://nile.tronscan.org/#/transaction/${done.txnHash}`
      };
    }
  );
await check('Tron Nile balances', () =>
  balances(wallet.indexer.getTronBalances({ networks: ['tron:nile'] }))
);
const tronRecipient = process.env.LIVE_TRON_RECIPIENT ?? lifecycleWallets.tron!.address;
{
  const transfer = {
    network: 'tron:nile',
    to: tronRecipient,
    asset: 'native',
    amount: process.env.LIVE_TRON_AMOUNT ?? '1'
  } as const;
  await check('Tron quote without maxQuotedFee is sent only when sponsored', async () => {
    const result = await wallet.tron
      .prepareTransfer({ idempotencyKey: id('live-trx-quote'), ...transfer })
      .catch((error) => error);
    if (result instanceof WalletError && result.code === 'SPONSORSHIP_REQUIRED')
      return 'not covered by delegated resources: refused as expected';
    if (result instanceof Error) throw result;
    return { sponsored: result.quote?.sponsored };
  });
  const maxQuotedFee = process.env.LIVE_TRON_MAX_FEE;
  if (!execute) skip('Tron transfer execution', 'Set LIVE_EXECUTE=1 to send Nile TRX.');
  else
    await check(
      'Tron transfer executes within maxQuotedFee; getTransactionStatus agrees',
      async () => {
        const op = await wallet.tron.sendTransfer({
          idempotencyKey: id('live-trx-send'),
          ...transfer,
          maxQuotedFee
        });
        const done = await executed(() => wallet.tron.refreshOperation(op.id));
        const status = await wallet.tron.getTransactionStatus(op.quote!.txnId);
        if (status.status !== 'executed' || status.txnHash !== done.txnHash)
          throw new Error(`getTransactionStatus returned ${JSON.stringify(status)}`);
        return {
          to: transfer.to,
          txnHash: done.txnHash,
          quoteLifetimeMs: Date.parse(op.quote!.expiresAt) - Date.parse(op.createdAt)
        };
      }
    );
}

const ephemeral = (getIdToken: () => ReturnType<typeof idToken> = () => idToken(subject)) =>
  createEphemeralServerWallet({
    publishableKey: key,
    origin,
    oidc: { subject, issuer, audience, getIdToken },
    attestation: { trustedPcr0s: pcr0s, allowDebugEnclave },
    signing,
    fetch: recording
  });
await check('ephemeral handles restore the same wallets and sign in parallel', async () => {
  const handles = [ephemeral(), ephemeral(), ephemeral()];
  try {
    const restored = await Promise.all(handles.map((handle) => handle.restore()));
    for (const r of restored)
      if (JSON.stringify(r.wallets) !== JSON.stringify(snapshot.wallets))
        throw new Error('An ephemeral handle restored different wallets');
    if (new Set(restored.map((r) => r.credentialId)).size !== handles.length)
      throw new Error('Ephemeral handles shared a credential');
    const started = Date.now();
    const signatures = await Promise.all(
      handles.flatMap((handle, n) => [
        handle.evm.signMessage({
          idempotencyKey: `eph-${crypto.randomUUID()}`,
          chainId: amoy,
          message: `ephemeral ${n}`
        }),
        handle.solana.signMessage({
          idempotencyKey: `eph-${crypto.randomUUID()}`,
          message: `ephemeral ${n}`
        }),
        handle.tron.signMessage({
          idempotencyKey: `eph-${crypto.randomUUID()}`,
          message: `ephemeral ${n}`
        })
      ])
    );
    if (!signatures.every((signature) => signature.verified))
      throw new Error('A signature did not verify');
    return { handles: handles.length, signatures: signatures.length, ms: Date.now() - started };
  } finally {
    await Promise.allSettled(handles.map((handle) => handle.close()));
  }
});
await check('a closed ephemeral handle revokes its credential and refuses to sign', async () => {
  const handle = ephemeral();
  await handle.restore({ families: ['evm'] });
  const revokes = calls.RevokeCredential ?? 0;
  await handle.close();
  if ((calls.RevokeCredential ?? 0) !== revokes + 1) throw new Error('close() did not revoke');
  const refused = await handle.evm
    .signMessage({ idempotencyKey: `eph-${crypto.randomUUID()}`, chainId: amoy, message: 'closed' })
    .catch((error) => error);
  if (!(refused instanceof WalletError) || refused.code !== 'WALLET_CLOSED')
    throw new Error('A closed handle signed');
  return { refused: refused.code };
});
await check('observation: two ephemeral handles signing in with the same ID token', async () => {
  const outcome = async (run: () => Promise<unknown[]>) =>
    (await run()).map((r) =>
      r instanceof WalletError
        ? `${r.code}${'upstreamCode' in r ? ` ${String(r.upstreamCode)}` : ''}`
        : 'ok'
    );
  const attempt = (handle: ReturnType<typeof ephemeral>) =>
    handle.restore({ families: ['evm'] }).then(
      () => 'ok',
      (error: unknown) => error
    );
  const sequentialToken = await idToken(subject);
  const seq = [ephemeral(async () => sequentialToken), ephemeral(async () => sequentialToken)];
  const concurrentToken = await idToken(subject);
  const conc = [ephemeral(async () => concurrentToken), ephemeral(async () => concurrentToken)];
  try {
    return {
      sequential: await outcome(async () => [await attempt(seq[0]), await attempt(seq[1])]),
      concurrent: await outcome(() => Promise.all(conc.map(attempt)))
    };
  } finally {
    await Promise.allSettled([...seq, ...conc].map((handle) => handle.close()));
  }
});

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
