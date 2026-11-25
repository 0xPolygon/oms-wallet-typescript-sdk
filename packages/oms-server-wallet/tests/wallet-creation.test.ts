import { describe, expect, it } from 'vitest';

import { UpstreamError, WalletError } from '@polygonlabs/oms-server-wallet-sdk';

import { createServerWalletInternal } from '../src/wallet.js';
import { FakeWaas, TEST_PUBLISHABLE_KEY, sdkHarness } from './helpers.js';

const oidc = {
  subject: 'customer-1',
  issuer: 'https://issuer.example',
  audience: 'oms-server-wallet',
  getIdToken: async () => ({
    token: `fixture-${crypto.randomUUID()}`,
    expiresAt: Math.floor(Date.now() / 1000) + 300
  })
};
const ephemeral = (remote: FakeWaas) =>
  createServerWalletInternal(
    { publishableKey: TEST_PUBLISHABLE_KEY, oidc, storage: 'memory' },
    { transport: remote, creationRecheckDelaysMs: [0, 0, 0] }
  );
const creates = (remote: FakeWaas) => remote.calls.filter((call) => call.method === 'CreateWallet');
const duplicateEvm = {
  id: 'wallet-2',
  address: '0x2222222222222222222222222222222222222222',
  networkFamily: 'evm'
};

describe('in-memory wallet creation', () => {
  it('creates only through create(); restore() never creates', async () => {
    const remote = new FakeWaas();
    const wallet = ephemeral(remote);
    await expect(wallet.restore()).rejects.toMatchObject({ code: 'WALLET_NOT_INITIALIZED' });
    await expect(
      wallet.evm.signMessage({
        idempotencyKey: `eph-${crypto.randomUUID()}`,
        chainId: 137,
        message: 'hi'
      })
    ).rejects.toMatchObject({
      code: 'WALLET_NOT_INITIALIZED'
    });
    expect(creates(remote)).toHaveLength(0);
    const created = await wallet.create({ families: ['evm', 'tron'] });
    expect(created.wallets.evm?.id).toBe('wallet-1');
    expect(created.wallets.tron).toBeDefined();
    // create() binds what exists instead of creating it again.
    await ephemeral(remote).create({ families: ['evm', 'tron'] });
    expect(creates(remote)).toHaveLength(2);
    expect((await ephemeral(remote).restore()).wallets.evm?.id).toBe('wallet-1');
  });

  it('runs concurrent create() calls for one identity in this process one at a time', async () => {
    const remote = new FakeWaas();
    const handles = Array.from({ length: 6 }, () => ephemeral(remote));
    const snapshots = await Promise.all(handles.map((handle) => handle.create()));
    expect(new Set(snapshots.map((snapshot) => snapshot.wallets.evm?.id))).toEqual(
      new Set(['wallet-1'])
    );
    expect(new Set(snapshots.map((snapshot) => snapshot.credentialId)).size).toBe(6);
    expect(creates(remote)).toHaveLength(1);
  });

  it('does not create again after an unknown create outcome', async () => {
    const remote = new FakeWaas();
    remote.failCreate = true;
    const request = remote.request.bind(remote);
    remote.request = async (method, body, credential) => {
      const response = await request(method, body, credential);
      return method === 'ListWallets' || method === 'CompleteAuth'
        ? { ...(response as object), wallets: [] }
        : response;
    };
    await expect(ephemeral(remote).create()).rejects.toMatchObject({ code: 'CREATION_UNCERTAIN' });
    expect(creates(remote)).toHaveLength(1);
  });
});

describe('identities with more than one wallet per family', () => {
  it('lists every wallet and restores the one the caller selects', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore();
    h.remote.others.push(duplicateEvm);
    // A bound durable wallet keeps using its own wallet when a duplicate appears.
    expect((await h.create().createOrRestore()).wallets.evm?.id).toBe('wallet-1');

    const remote = h.remote;
    await expect(ephemeral(remote).restore()).rejects.toMatchObject({
      code: 'WALLET_MISMATCH',
      message: expect.stringContaining('wallets.evm')
    });
    const listed = await ephemeral(remote).listWallets();
    expect(
      listed
        .filter((wallet) => wallet.family === 'evm')
        .map((w) => w.id)
        .sort()
    ).toEqual(['wallet-1', 'wallet-2']);
    const restored = await ephemeral(remote).restore({ wallets: { evm: duplicateEvm.address } });
    expect(restored.wallets.evm?.id).toBe('wallet-2');
  });

  it('refuses a selection that is not one of the identity wallets or disagrees with a bound one', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore();
    await expect(
      ephemeral(h.remote).restore({
        wallets: { evm: '0x5555555555555555555555555555555555555555' }
      })
    ).rejects.toMatchObject({ code: 'WALLET_MISMATCH' });
    h.remote.others.push(duplicateEvm);
    await expect(
      h.client.createOrRestore({ wallets: { evm: duplicateEvm.address } })
    ).rejects.toMatchObject({ code: 'WALLET_MISMATCH' });
    await expect(
      h.client.createOrRestore({ wallets: { evm: 'not-an-address' } })
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
  });

  it('lets a fresh durable wallet choose among duplicates and remember the choice', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore();
    h.remote.others.push(duplicateEvm);
    const fresh = sdkHarness();
    Object.assign(fresh.remote, { wallet: h.remote.wallet, others: h.remote.others });
    await expect(fresh.client.createOrRestore()).rejects.toMatchObject({ code: 'WALLET_MISMATCH' });
    expect(
      (await fresh.client.createOrRestore({ wallets: { evm: duplicateEvm.address } })).wallets.evm
        ?.id
    ).toBe('wallet-2');
    // Later calls need no selection: the bound wallet is stored.
    expect((await fresh.create().createOrRestore()).wallets.evm?.id).toBe('wallet-2');
    expect(creates(fresh.remote)).toHaveLength(0);
  });

  it('clears creating after a verified pre-create WaaS refusal so retries can create', async () => {
    const h = sdkHarness();
    const request = h.remote.request.bind(h.remote);
    let createAttempts = 0;
    h.remote.request = async (method, body, credential) => {
      if (method === 'CreateWallet') {
        createAttempts++;
        if (createAttempts === 1) throw new UpstreamError(7200, 'CreateWallet');
      }
      return request(method, body, credential);
    };
    await expect(h.client.createOrRestore({ families: ['evm'] })).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      upstreamCode: 7200
    });
    const created = await h.client.createOrRestore({ families: ['evm'] });
    expect(created.wallets.evm?.id).toBe('wallet-1');
    expect(created.creationUncertain).toBe(false);
    expect(createAttempts).toBe(2);
    expect(creates(h.remote)).toHaveLength(1);
  });

  it('throws CREATION_UNCERTAIN (never TypeError) when recheck clears credential and getIdToken fails', async () => {
    let tokens = 0;
    const remote = new FakeWaas();
    const request = remote.request.bind(remote);
    remote.request = async (method, body, credential) => {
      if (method === 'CreateWallet')
        throw new WalletError('UPSTREAM_UNAVAILABLE', 'network lost', 502);
      if (method === 'ListWallets') throw new UpstreamError(7202, 'ListWallets');
      return request(method, body, credential);
    };
    const wallet = createServerWalletInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc: {
          subject: 'customer-1',
          issuer: 'https://issuer.example',
          audience: 'oms-server-wallet',
          getIdToken: async () => {
            tokens++;
            if (tokens > 1) throw new Error('IdP down');
            return {
              token: `fixture-${crypto.randomUUID()}`,
              expiresAt: Math.floor(Date.now() / 1000) + 300
            };
          }
        },
        storage: 'memory'
      },
      { transport: remote, creationRecheckDelaysMs: [0] }
    );
    await expect(wallet.create({ families: ['evm'] })).rejects.toMatchObject({
      code: 'CREATION_UNCERTAIN'
    });
  });

  it('lists wallets even when creating is non-empty and duplicates exist on WaaS', async () => {
    const h = sdkHarness();
    const request = h.remote.request.bind(h.remote);
    let lostOnce = false;
    h.remote.request = async (method, body, credential) => {
      if (method === 'CreateWallet' && !lostOnce) {
        lostOnce = true;
        throw new WalletError('UPSTREAM_UNAVAILABLE', 'lost create', 502);
      }
      return request(method, body, credential);
    };
    await expect(h.client.createOrRestore({ families: ['evm'] })).rejects.toMatchObject({
      code: 'CREATION_UNCERTAIN'
    });
    h.remote.wallet = {
      id: 'wallet-1',
      address: '0x1111111111111111111111111111111111111111',
      networkFamily: 'evm'
    };
    h.remote.others.push(duplicateEvm);
    const listed = await h.client.listWallets();
    expect(
      listed
        .filter((wallet) => wallet.family === 'evm')
        .map((wallet) => wallet.id)
        .sort()
    ).toEqual(['wallet-1', 'wallet-2']);
  });
});
