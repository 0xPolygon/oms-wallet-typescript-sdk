import { describe, expect, it } from 'vitest';
import { createSingleProcessExecutor, parseAmount } from '@polygonlabs/oms-server-wallet-sdk';
import { environmentFromKey } from '../src/environment.js';
import { EncryptedStore } from '../src/storage.js';
import { createServerWalletInternal } from '../src/wallet.js';
import { MemoryStore, TEST_PUBLISHABLE_KEY, sdkHarness } from './helpers.js';

const transfer = {
  chainId: 137 as const,
  to: '0x2222222222222222222222222222222222222222',
  asset: 'native',
  amount: '1000000000000000'
};

describe('server wallet lifecycle and transactions', () => {
  it('rejects invalid addresses and base-unit amounts before authentication or preparation', async () => {
    const h = sdkHarness();
    await expect(
      h.client.evm.prepareTransfer({ idempotencyKey: 'invalid-1', ...transfer, to: '0x123' })
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    await expect(
      h.client.evm.prepareTransfer({ idempotencyKey: 'invalid-2', ...transfer, amount: '1.2' })
    ).rejects.toMatchObject({ code: 'INVALID_TRANSFER' });
    expect(h.remote.calls).toHaveLength(0);
  });
  it('persists credentials and restores the same wallet across client instances', async () => {
    const h = sdkHarness();
    const first = await h.client.createOrRestore();
    const restored = await h.create().createOrRestore();
    expect(restored).toEqual(first);
    expect(h.remote.calls.filter((c) => c.method === 'CreateWallet')).toHaveLength(1);
    expect(h.remote.calls.filter((c) => c.method === 'CompleteAuth')).toHaveLength(1);
  });
  it('automatically authenticates and binds the same wallet after expiry', async () => {
    const h = sdkHarness();
    const first = await h.client.createOrRestore();
    const state = JSON.parse((await h.store.read('wallet'))!);
    state.credential.expiresAt = new Date(0).toISOString();
    await h.store.write('wallet', JSON.stringify(state));
    const restored = await h.create().createOrRestore();
    expect(restored.wallet).toEqual(first.wallet);
    expect(restored.credentialId).not.toBe(first.credentialId);
    expect(h.remote.calls.filter((c) => c.method === 'CreateWallet')).toHaveLength(1);
    expect(h.remote.calls.some((c) => c.method === 'UseWallet')).toBe(true);
  });
  it('recovers from verified credential-expired errors', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore();
    h.remote.expiredOnce = true;
    expect(
      (
        await h.client.evm.signMessage({
          idempotencyKey: 'sign-001',
          chainId: 137 as const,
          message: 'hello'
        })
      ).verified
    ).toBe(true);
    expect(h.remote.calls.filter((c) => c.method === 'CompleteAuth')).toHaveLength(2);
  });
  it('recovers from verified remote revocation and accepts already-revoked keys on disable', async () => {
    const h = sdkHarness();
    const initial = await h.client.createOrRestore();
    h.remote.revoked.add(initial.credentialId!);
    expect(
      (
        await h.client.evm.signMessage({
          idempotencyKey: 'revoked-1',
          chainId: 137 as const,
          message: 'hello'
        })
      ).verified
    ).toBe(true);
    const restored = await h.client.inspect();
    expect(restored.wallet).toEqual(initial.wallet);
    expect(restored.credentialId).not.toBe(initial.credentialId);
    h.remote.revoked.add(restored.credentialId!);
    expect((await h.client.disable()).disabled).toBe(true);
    expect((await h.client.inspect()).credentialId).toBeUndefined();
  });
  it('does not repeatedly reauthenticate when authorization remains denied', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore();
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) => {
      if (method === 'SignMessage') {
        h.remote.revoked.add(credential!.credentialId);
      }
      return request(method, body, credential);
    };
    await expect(
      h.client.evm.signMessage({
        idempotencyKey: 'denied-1',
        chainId: 137 as const,
        message: 'hello'
      })
    ).rejects.toMatchObject({
      upstreamCode: 7207
    });
    expect(h.remote.calls.filter((call) => call.method === 'CompleteAuth')).toHaveLength(2);
    expect(h.remote.calls.filter((call) => call.method === 'SignMessage')).toHaveLength(2);
  });
  it('reconciles lost create responses without creating another wallet', async () => {
    const h = sdkHarness();
    h.remote.failCreate = true;
    await expect(h.client.createOrRestore()).rejects.toThrow('Lost create');
    expect((await h.create().createOrRestore()).wallet?.id).toBe('wallet-1');
    expect(h.remote.calls.filter((c) => c.method === 'CreateWallet')).toHaveLength(1);
  });
  it('continues discovery when a create is uncertain instead of creating duplicates', async () => {
    const h = sdkHarness();
    h.remote.failCreate = true;
    await expect(h.client.createOrRestore()).rejects.toThrow();
    const wallet = h.remote.wallet;
    h.remote.wallet = undefined;
    await expect(h.create().createOrRestore()).rejects.toMatchObject({
      code: 'CREATION_UNCERTAIN'
    });
    h.remote.wallet = wallet;
    expect((await h.create().createOrRestore()).wallet?.id).toBe('wallet-1');
  });
  it('serializes concurrent requests from separate SDK instances sharing an executor', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        h.create().evm.signMessage({
          idempotencyKey: `message-${i}`,
          chainId: 137 as const,
          message: `hello ${i}`
        })
      )
    );
    expect(h.remote.maxInFlight).toBe(1);
  });
  it('rejects unsponsored transfers and never executes them', async () => {
    const h = sdkHarness();
    h.remote.sponsored = false;
    await expect(
      h.client.evm.prepareTransfer({ idempotencyKey: 'transfer-1', ...transfer })
    ).rejects.toMatchObject({
      code: 'SPONSORSHIP_REQUIRED'
    });
    expect((await h.client.evm.getOperation('transfer-1'))?.status).toBe('failed');
    expect(h.remote.calls.some((c) => c.method === 'Execute')).toBe(false);
  });
  it('encodes only ERC-20 transfer calldata and preserves large integer amounts', async () => {
    const h = sdkHarness();
    await h.client.evm.prepareTransfer({
      idempotencyKey: 'transfer-2',
      ...transfer,
      asset: '0x3333333333333333333333333333333333333333',
      amount: '123456789012345678901234567890'
    });
    const body = h.remote.calls.find((c) => c.method === 'PrepareEthereumTransaction')!.body;
    expect(body.to).toBe('0x3333333333333333333333333333333333333333');
    expect(body.value).toBe('0');
    expect(body.data).toBe(
      `0xa9059cbb${transfer.to.slice(2).padStart(64, '0')}${BigInt('123456789012345678901234567890').toString(16).padStart(64, '0')}`
    );
  });
  it('returns the same operation for retries and rejects changed inputs', async () => {
    const h = sdkHarness();
    const op = await h.client.evm.prepareTransfer({ idempotencyKey: 'transfer-3', ...transfer });
    expect(
      await h.create().evm.prepareTransfer({ idempotencyKey: 'transfer-3', ...transfer })
    ).toEqual(op);
    await expect(
      h.client.evm.prepareTransfer({ idempotencyKey: 'transfer-3', ...transfer, amount: '1' })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(h.remote.calls.filter((c) => c.method === 'PrepareEthereumTransaction')).toHaveLength(1);
  });
  it('reconciles an ambiguous execution without sending it twice', async () => {
    const h = sdkHarness();
    const prepared = await h.client.evm.prepareTransfer({
      idempotencyKey: 'transfer-4',
      ...transfer
    });
    h.remote.failExecute = true;
    expect(
      (
        await h.client.evm.execute({
          idempotencyKey: 'transfer-4',
          reviewId: prepared.reviewId!
        })
      ).status
    ).toBe('unknown');
    expect(
      (
        await h.create().evm.execute({
          idempotencyKey: 'transfer-4',
          reviewId: prepared.reviewId!
        })
      ).status
    ).toBe('pending');
    h.remote.txnStatus = 'executed';
    expect((await h.client.evm.refreshOperation('transfer-4'))?.txnHash).toBe(
      `0x${'ab'.repeat(32)}`
    );
    expect(h.remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(1);
  });
  it('refuses expired quotes without submitting', async () => {
    const h = sdkHarness();
    const prepared = await h.client.evm.prepareTransfer({
      idempotencyKey: 'transfer-5',
      ...transfer
    });
    const op = JSON.parse((await h.store.read('operation:transfer-5'))!);
    op.quote.expiresAt = new Date(0).toISOString();
    await h.store.write('operation:transfer-5', JSON.stringify(op));
    await expect(
      h.client.evm.execute({ idempotencyKey: 'transfer-5', reviewId: prepared.reviewId! })
    ).rejects.toMatchObject({
      code: 'QUOTE_EXPIRED'
    });
  });
  it('keeps a wallet disabled through failed revocation and restart, then retries revocation on enable', async () => {
    const h = sdkHarness();
    const first = await h.client.createOrRestore();
    h.remote.failRevoke = true;
    await expect(h.client.disable()).rejects.toThrow();
    await expect(
      h
        .create()
        .evm.signMessage({ idempotencyKey: 'disabled-1', chainId: 137 as const, message: 'hello' })
    ).rejects.toMatchObject({
      code: 'WALLET_DISABLED'
    });
    await expect(h.client.enable()).rejects.toThrow();
    expect((await h.client.inspect()).disabled).toBe(true);
    h.remote.failRevoke = false;
    const enabled = await h.create().enable();
    expect(h.remote.revoked.has(first.credentialId!)).toBe(true);
    expect(enabled.wallet).toEqual(first.wallet);
    expect(enabled.disabled).toBe(false);
  });
  it('rotates by self-revoking the old key and authenticating a fresh credential', async () => {
    const h = sdkHarness();
    const before = await h.client.createOrRestore();
    const after = await h.client.rotateCredential();
    expect(h.remote.revoked.has(before.credentialId!)).toBe(true);
    expect(after.credentialId).not.toBe(before.credentialId);
    expect(after.wallet).toEqual(before.wallet);
  });
  it('rejects mismatched authenticated identities', async () => {
    const h = sdkHarness();
    const client = createServerWalletInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc: {
          subject: 'other-customer',
          issuer: 'https://issuer.example',
          audience: 'oms-server-wallet',
          getIdToken: async () => ({ token: 'x', expiresAt: 100 })
        },
        store: { encryptedStore: h.store },
        executor: createSingleProcessExecutor()
      },
      { transport: h.remote }
    );
    await expect(client.createOrRestore()).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    expect(h.remote.calls.some((c) => c.method === 'CreateWallet')).toBe(false);
  });
  it('rejects a response bound to a different credential hash', async () => {
    const h = sdkHarness();
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) => {
      const response = await request(method, body, credential);
      if (method === 'CompleteAuth') {
        const auth = response as { credential: { credentialId: string } };
        auth.credential.credentialId = `0x${'00'.repeat(32)}`;
      }
      return response;
    };
    await expect(h.client.createOrRestore()).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    expect(h.remote.calls.some((call) => call.method === 'CreateWallet')).toBe(false);
  });
});

describe('encryption, amounts, environment routing', () => {
  it('binds encrypted state to the owner and record and detects tampering', async () => {
    const raw = new MemoryStore();
    const key = btoa('k'.repeat(32));
    const store = new EncryptedStore(raw, key, 'customer-1');
    await store.write('wallet', 'private material');
    expect(await store.read('wallet')).toBe('private material');
    expect(await raw.read('wallet')).not.toContain('private material');
    await expect(new EncryptedStore(raw, key, 'customer-2').read('wallet')).rejects.toMatchObject({
      code: 'STORAGE_INTEGRITY'
    });
    await raw.write('other', (await raw.read('wallet'))!);
    await expect(store.read('other')).rejects.toThrow();
    const envelope = JSON.parse((await raw.read('wallet'))!);
    envelope.data = btoa('tampered');
    await raw.write('wallet', JSON.stringify(envelope));
    await expect(store.read('wallet')).rejects.toThrow();
  });
  it('uses fresh encryption nonces and rejects malformed keys', async () => {
    const raw = new MemoryStore();
    const store = new EncryptedStore(raw, btoa('k'.repeat(32)), 'subject');
    await store.write('wallet', 'same');
    const first = await raw.read('wallet');
    await store.write('wallet', 'same');
    expect(await raw.read('wallet')).not.toEqual(first);
    expect(() => new EncryptedStore(raw, btoa('short'), 'subject')).toThrow(
      expect.objectContaining({ code: 'CONFIGURATION', status: 503 })
    );
    expect(() => new EncryptedStore(raw, 'not-valid-base64!!!', 'subject')).toThrow(
      expect.objectContaining({ code: 'CONFIGURATION', status: 503 })
    );
  });
  it('parses amounts without floating-point rounding', () => {
    expect(parseAmount('12345678901234567890.123456', 6)).toBe('12345678901234567890123456');
    for (const value of ['0', '-1', '1e5', '0.0000001', '1.0000001', 'NaN'])
      expect(() => parseAmount(value, 6)).toThrow();
  });
  it('routes publishable keys and isolates project scopes', () => {
    expect(environmentFromKey('pk_dev_live_abc_key').origin).toBe(
      'https://api.dev.polygon-dev.technology'
    );
    expect(environmentFromKey('pk_sdbx_abc_key').indexerUrl).toBe(
      'https://sandbox-api.polygon.technology/v1/IndexerGateway/GetTokenBalancesDetails'
    );
    expect(environmentFromKey('pk_stg_live_abc_key').projectId).toBe('prj_abc');
    expect(() => environmentFromKey('pk_dev_live_x"\n_key')).toThrow();
  });
});
