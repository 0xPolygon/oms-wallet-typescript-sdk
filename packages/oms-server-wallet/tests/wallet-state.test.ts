import { describe, expect, it } from 'vitest';

import type { StateStore } from '@polygonlabs/oms-server-wallet-sdk';

import { chainQuoteSchema, isWalletAddress, walletFamily } from '../src/protocol.js';
import { FakeWaas, SOLANA_ADDRESS, TRON_ADDRESS, sdkHarness } from './helpers.js';

const read = async (store: StateStore) => JSON.parse((await store.read('wallet'))!);
const calls = (remote: FakeWaas, method: string) =>
  remote.calls.filter((call) => call.method === method);

describe('strict wallet state validation', () => {
  it('keeps inspect() and getOperation() strictly read-only with zero store writes', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore();
    await h.client.evm.signMessage({
      idempotencyKey: 'readonly-sign-1',
      chainId: 137 as const,
      message: 'hello'
    });
    let writes = 0;
    const origWrite = h.store.write.bind(h.store);
    h.store.write = async (key, value) => {
      writes++;
      return origWrite(key, value);
    };
    const snap = await h.client.inspect();
    expect(snap.wallets.evm?.id).toBe('wallet-1');
    const op = await h.client.evm.getOperation('readonly-sign-1');
    expect(op?.status).toBe('signed');
    expect(writes).toBe(0);
  });

  it.each([
    ['invalid JSON', '{'],
    ['an unknown version', JSON.stringify({ version: 3, wallets: {} })],
    ['unversioned pre-v2 state', JSON.stringify({ disabled: false, creating: false })],
    [
      'a non-EVM address in the EVM slot',
      JSON.stringify({
        version: 2,
        wallets: { evm: { id: 'w', address: 'x' } },
        disabled: false,
        creating: []
      })
    ],
    [
      'a Solana wallet with a Tron address',
      JSON.stringify({
        version: 2,
        wallets: { solana: { id: 'w', address: TRON_ADDRESS } },
        disabled: false,
        creating: []
      })
    ],
    [
      'a malformed credential',
      JSON.stringify({
        version: 2,
        wallets: {},
        credential: { id: '0x04', nonce: 'x' },
        disabled: false,
        creating: []
      })
    ],
    ['an unrelated record', JSON.stringify({ unrelated: 'unrecognised record' })],
    ['an empty object', '{}'],
    [
      'a current record with unknown fields',
      JSON.stringify({ version: 2, wallets: {}, disabled: false, creating: [], extra: 1 })
    ]
  ])('fails closed on %s without contacting WaaS', async (_, value) => {
    const h = sdkHarness();
    await h.store.write('wallet', value);
    await expect(h.client.inspect()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(h.client.createOrRestore()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(h.remote.calls).toHaveLength(0);
    expect(await h.store.read('wallet')).toBe(value);
  });

  it('fails closed on corrupted operation records', async () => {
    const h = sdkHarness();
    await h.store.write('operation:corrupt-op-1', '{"bad":true}');
    await expect(h.client.evm.getOperation('corrupt-op-1')).rejects.toMatchObject({
      code: 'INVALID_STATE'
    });
  });
});

describe('one wallet per network family', () => {
  it('creates each requested family once and restores all of them', async () => {
    const h = sdkHarness();
    const created = await h.client.createOrRestore({ families: ['evm', 'solana', 'tron'] });
    expect(created.wallets.solana?.address).toBe(SOLANA_ADDRESS);
    expect(created.wallets.tron?.address).toBe(TRON_ADDRESS);
    expect(created.wallets.evm).toEqual(created.wallets.evm);
    expect(calls(h.remote, 'CreateWallet').map((call) => call.body.networkFamily)).toEqual([
      'evm',
      'solana',
      'tron'
    ]);
    expect(await h.create().createOrRestore({ families: ['tron', 'solana'] })).toEqual(created);
    expect(calls(h.remote, 'CreateWallet')).toHaveLength(3);
    expect(calls(h.remote, 'CompleteAuth')).toHaveLength(1);
  });

  it('creates only the EVM wallet by default', async () => {
    const h = sdkHarness();
    const snapshot = await h.client.createOrRestore();
    expect(Object.keys(snapshot.wallets)).toEqual(['evm']);
    expect(calls(h.remote, 'CreateWallet').map((call) => call.body.networkFamily)).toEqual(['evm']);
  });

  it('binds every held wallet to a new credential after expiry', async () => {
    const h = sdkHarness();
    const first = await h.client.createOrRestore({ families: ['evm', 'solana', 'tron'] });
    const state = await read(h.store);
    state.credential.expiresAt = new Date(0).toISOString();
    await h.store.write('wallet', JSON.stringify(state));
    const restored = await h.create().createOrRestore({ families: ['solana'] });
    expect(restored.wallets).toEqual(first.wallets);
    expect(calls(h.remote, 'UseWallet').map((call) => call.body.walletId)).toEqual([
      'wallet-1',
      'wallet-sol',
      'wallet-trx'
    ]);
    expect(calls(h.remote, 'CreateWallet')).toHaveLength(3);
  });

  it('lists wallets before adding a new family to an existing identity', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore({ families: ['evm'] });
    // A Solana wallet created outside this SDK for the same identity is adopted, not duplicated.
    h.remote.others.push({
      id: 'wallet-sol-existing',
      address: SOLANA_ADDRESS,
      networkFamily: 'solana'
    });
    const snapshot = await h.client.createOrRestore({ families: ['solana', 'tron'] });
    expect(snapshot.wallets.solana?.id).toBe('wallet-sol-existing');
    expect(snapshot.wallets.tron?.id).toBe('wallet-trx');
    expect(calls(h.remote, 'ListWallets')).toHaveLength(1);
    expect(calls(h.remote, 'CompleteAuth')).toHaveLength(1);
    expect(calls(h.remote, 'CreateWallet').map((call) => call.body.networkFamily)).toEqual([
      'evm',
      'tron'
    ]);
  });

  it('follows wallet pagination during discovery', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore({ families: ['evm', 'solana', 'tron'] });
    h.remote.pageSize = 1;
    await h.store.write(
      'wallet',
      JSON.stringify({ ...(await read(h.store)), credential: undefined })
    );
    expect(Object.keys((await h.create().inspect()).wallets)).toHaveLength(3);
    await h.create().createOrRestore({ families: ['evm'] });
    expect(calls(h.remote, 'ListWallets').map((call) => call.body.page)).toEqual([
      { cursor: '1', limit: 100 },
      { cursor: '2', limit: 100 }
    ]);
  });

  it('refuses an identity with two wallets of a family in use, and only that family', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore();
    h.remote.others.push(
      { id: 'trx-a', address: TRON_ADDRESS, networkFamily: 'tron' },
      { id: 'trx-b', address: TRON_ADDRESS, networkFamily: 'tron' }
    );
    await expect(h.client.createOrRestore({ families: ['tron'] })).rejects.toMatchObject({
      code: 'WALLET_MISMATCH'
    });
    expect(
      (
        await h.client.evm.signMessage({
          idempotencyKey: 'evm-still-works',
          chainId: 137 as const,
          message: 'hello'
        })
      ).verified
    ).toBe(true);
    expect(calls(h.remote, 'CreateWallet')).toHaveLength(1);
  });

  it('refuses when a stored wallet is no longer listed for the identity', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore({ families: ['evm', 'solana'] });
    h.remote.others = [{ id: 'wallet-sol-2', address: SOLANA_ADDRESS, networkFamily: 'solana' }];
    const state = await read(h.store);
    state.credential.expiresAt = new Date(0).toISOString();
    await h.store.write('wallet', JSON.stringify(state));
    await expect(h.client.createOrRestore()).rejects.toMatchObject({ code: 'WALLET_MISMATCH' });
  });

  it('compares Solana addresses exactly, in discovery and binding', async () => {
    const family = 'solana';
    const swapCase = (address: string) => {
      for (let i = 0; i < address.length; i++) {
        const char = address[i];
        const other = char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase();
        const swapped = address.slice(0, i) + other + address.slice(i + 1);
        if (other !== char && isWalletAddress(family, swapped)) return swapped;
      }
      throw new Error(`No case variant of ${address} is a ${family} address`);
    };
    const listed = sdkHarness();
    const created = await listed.client.createOrRestore({ families: [family] });
    const wallet = listed.remote.others.find((entry) => entry.networkFamily === family)!;
    wallet.address = swapCase(wallet.address);
    await expect(listed.client.rotateCredential()).rejects.toMatchObject({
      code: 'WALLET_MISMATCH'
    });
    expect((await listed.client.inspect()).wallets).toEqual(created.wallets);

    const bound = sdkHarness();
    const request = bound.remote.request.bind(bound.remote);
    bound.remote.request = async (method, body, credential) => {
      const response = (await request(method, body, credential)) as {
        wallet?: { address: string };
      };
      if (method === 'UseWallet' && response.wallet)
        return { wallet: { ...response.wallet, address: swapCase(response.wallet.address) } };
      return response;
    };
    await bound.client.createOrRestore({ families: [family] });
    await expect(bound.client.rotateCredential()).rejects.toMatchObject({
      code: 'WALLET_MISMATCH'
    });
  });

  it('settles an uncertain create of one family without duplicating it', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore();
    h.remote.failCreate = true;
    const snapshot = await h.client.createOrRestore({ families: ['solana'] });
    expect(snapshot.wallets.solana?.id).toBe('wallet-sol');
    expect(snapshot.creationUncertain).toBe(false);
    expect(calls(h.remote, 'CreateWallet')).toHaveLength(2);
  });

  it('never trusts a created wallet of a different family, binding only the discovered one', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore();
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) => {
      const response = await request(method, body, credential);
      if (method === 'CreateWallet' && body.networkFamily === 'tron')
        return { wallet: { id: 'x', address: SOLANA_ADDRESS, networkFamily: 'solana' } };
      return response;
    };
    // A malformed create response leaves the outcome unknown: the SDK binds only what an attested
    // ListWallets and UseWallet show, and never sends a second CreateWallet.
    const snapshot = await h.client.createOrRestore({ families: ['tron'] });
    expect(snapshot.wallets.tron?.networkFamily).toBe('tron');
    expect(snapshot.wallets.tron?.id).not.toBe('x');
    expect(
      calls(h.remote, 'CreateWallet').filter((c) => c.body.networkFamily === 'tron')
    ).toHaveLength(1);
  });

  it('keeps every family across rotation and disable/enable', async () => {
    const h = sdkHarness();
    const before = await h.client.createOrRestore({ families: ['solana', 'tron'] });
    expect(before.wallets.evm).toBeUndefined();
    const rotated = await h.client.rotateCredential();
    expect(rotated.wallets).toEqual(before.wallets);
    expect(rotated.credentialId).not.toBe(before.credentialId);
    await h.client.disable();
    expect((await h.client.enable()).wallets).toEqual(before.wallets);
    expect(calls(h.remote, 'CreateWallet').map((call) => call.body.networkFamily)).toEqual([
      'solana',
      'tron'
    ]);
  });

  it.each([[[]], [['bitcoin']], ['evm']])('rejects families %j', async (families) => {
    const h = sdkHarness();
    await expect(
      h.client.createOrRestore({ families: families as unknown as ['evm'] })
    ).rejects.toMatchObject({ code: 'INVALID_FAMILY' });
    expect(h.remote.calls).toHaveLength(0);
  });
});

describe('WaaS v1.2.0 protocol shapes', () => {
  it('reads the family from networkFamily or the older type field', () => {
    const base = { id: 'w', address: SOLANA_ADDRESS };
    expect(walletFamily({ ...base, networkFamily: 'solana' })).toBe('solana');
    expect(walletFamily({ ...base, type: 'ethereum' })).toBe('evm');
    expect(walletFamily({ ...base, networkFamily: 'tron', type: 'tron' })).toBe('tron');
    expect(walletFamily({ ...base, networkFamily: 'evm', type: 'solana' })).toBeUndefined();
    expect(walletFamily({ ...base, networkFamily: 'bitcoin' })).toBeUndefined();
  });
  it('reads null fee options from older servers as none', () => {
    const quote = {
      txnId: 't',
      status: 'quoted',
      sponsored: true,
      expiresAt: '2026-11-23T10:00:00Z'
    };
    expect(chainQuoteSchema.parse({ ...quote, feeOptions: null }).feeOptions).toEqual([]);
    expect(chainQuoteSchema.parse(quote).feeOptions).toEqual([]);
    expect(() => chainQuoteSchema.parse({ ...quote, feeOptions: [{ value: '-1' }] })).toThrow();
  });
});
