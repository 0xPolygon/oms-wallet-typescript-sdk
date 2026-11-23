import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  EncryptedStore,
  SerialExecutor,
  ServerWallet,
  type StateStore
} from '@polygonlabs/oms-server-wallet-sdk';

import { chainQuoteSchema, isWalletAddress, walletFamily } from '../src/protocol.js';
import { FakeWaas, MemoryStore, SOLANA_ADDRESS, TRON_ADDRESS, sdkHarness } from './helpers.js';

/** A store left by the published 0.2.0 package; see fixtures/record-state-0.2.0.mjs. */
const legacy = JSON.parse(
  readFileSync(new URL('./fixtures/state-0.2.0.json', import.meta.url), 'utf8')
) as { subject: string; encryptionKey: string; store: Record<string, string> };

function legacyHarness() {
  const raw = new MemoryStore();
  for (const [key, value] of Object.entries(legacy.store)) raw.values.set(key, value);
  const store = new EncryptedStore(raw, legacy.encryptionKey, legacy.subject);
  const remote = new FakeWaas();
  remote.wallet = {
    id: 'wallet-legacy',
    address: '0x1111111111111111111111111111111111111111',
    networkFamily: 'evm'
  };
  const client = new ServerWallet({
    subject: legacy.subject,
    issuer: 'https://issuer.example',
    audience: 'oms-server-wallet',
    store,
    executor: new SerialExecutor(),
    transport: remote,
    tokenProvider: async () => ({
      token: `fixture-${crypto.randomUUID()}`,
      expiresAt: Math.floor(Date.now() / 1000) + 300
    })
  });
  return { raw, store, remote, client };
}
const read = async (store: StateStore) => JSON.parse((await store.read('wallet'))!);
const calls = (remote: FakeWaas, method: string) =>
  remote.calls.filter((call) => call.method === method);

describe('state migration from 0.2.x and 0.3.x', () => {
  it('migrates encrypted 0.2.0 state on first load and keeps the same credential', async () => {
    const h = legacyHarness();
    const before = await read(h.store);
    expect(before.version).toBeUndefined();
    const snapshot = await h.client.inspect();
    expect(snapshot.wallet).toEqual(before.wallet);
    expect(snapshot.wallets).toEqual({ evm: before.wallet });
    expect(snapshot.credentialId).toBe(before.credential.credentialId);
    expect(snapshot.creationUncertain).toBe(false);
    const after = await read(h.store);
    expect(after).toEqual({
      version: 2,
      wallets: { evm: before.wallet },
      credential: before.credential,
      disabled: false,
      creating: []
    });
    // Still encrypted, with the same key and binding.
    expect(h.raw.values.get('wallet')).not.toContain('wallet-legacy');
  });
  it('keeps signing and reading 0.2.0 operations without authenticating again', async () => {
    const h = legacyHarness();
    const operations = await h.client.listOperations();
    expect(operations.map((op) => [op.id, op.kind, op.status])).toEqual([
      ['legacy-sign-1', 'sign', 'signed'],
      ['legacy-transfer-1', 'transfer', 'pending']
    ]);
    expect((await h.client.signMessage('after-migration', 137, 'hello')).verified).toBe(true);
    // The migrated credential is used as is: the stored nonce keeps counting up.
    expect(calls(h.remote, 'CompleteAuth')).toHaveLength(0);
    expect(calls(h.remote, 'CreateWallet')).toHaveLength(0);
    expect(h.remote.calls[0].credential).toBe((await read(h.store)).credential.id);
  });
  it('turns a legacy uncertain create into an EVM creation to settle', async () => {
    const h = sdkHarness();
    await h.store.write('wallet', JSON.stringify({ disabled: false, creating: true }));
    expect((await h.client.inspect()).creationUncertain).toBe(true);
    expect((await read(h.store)).creating).toEqual(['evm']);
    await expect(h.client.createOrRestore()).rejects.toMatchObject({
      code: 'CREATION_UNCERTAIN'
    });
    h.remote.wallet = {
      id: 'wallet-1',
      address: '0x1111111111111111111111111111111111111111',
      networkFamily: 'evm'
    };
    const restored = await h.client.createOrRestore();
    expect(restored.wallet?.id).toBe('wallet-1');
    expect(restored.creationUncertain).toBe(false);
    expect(calls(h.remote, 'CreateWallet')).toHaveLength(0);
  });
  it('adds the RPC credential ID to records written before it was stored', async () => {
    const h = legacyHarness();
    const state = await read(h.store);
    const expected = state.credential.credentialId;
    delete state.credential.credentialId;
    await h.store.write('wallet', JSON.stringify(state));
    expect((await h.client.inspect()).credentialId).toBe(expected);
  });
  it.each([
    ['invalid JSON', '{'],
    ['an unknown version', JSON.stringify({ version: 3, wallets: {} })],
    ['a non-EVM address in the EVM slot', JSON.stringify({ wallet: { id: 'w', address: 'x' } })],
    [
      'a Solana wallet with a Tron address',
      JSON.stringify({
        version: 2,
        wallets: { solana: { id: 'w', address: TRON_ADDRESS } },
        disabled: false,
        creating: []
      })
    ],
    ['a malformed credential', JSON.stringify({ credential: { id: '0x04', nonce: 'x' } })],
    ['an unrelated record', JSON.stringify({ unrelated: 'unrecognised record' })],
    ['an empty object', '{}'],
    ['a legacy record missing its flags', JSON.stringify({ disabled: false })],
    [
      'a legacy record with unknown fields',
      JSON.stringify({ disabled: false, creating: false, wallets: {} })
    ],
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
});

describe('one wallet per network family', () => {
  it('creates each requested family once and restores all of them', async () => {
    const h = sdkHarness();
    const created = await h.client.createOrRestore({ families: ['evm', 'solana', 'tron'] });
    expect(created.wallets.solana?.address).toBe(SOLANA_ADDRESS);
    expect(created.wallets.tron?.address).toBe(TRON_ADDRESS);
    expect(created.wallet).toEqual(created.wallets.evm);
    expect(calls(h.remote, 'CreateWallet').map((call) => call.body.networkFamily)).toEqual([
      'evm',
      'solana',
      'tron'
    ]);
    expect(await h.create().createOrRestore({ families: ['tron', 'solana'] })).toEqual(created);
    expect(calls(h.remote, 'CreateWallet')).toHaveLength(3);
    expect(calls(h.remote, 'CompleteAuth')).toHaveLength(1);
  });
  it('creates only the EVM wallet by default, as before', async () => {
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
  it('lists wallets before adding a family to a migrated identity', async () => {
    const h = legacyHarness();
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
    expect(calls(h.remote, 'CompleteAuth')).toHaveLength(0);
    expect(calls(h.remote, 'CreateWallet').map((call) => call.body.networkFamily)).toEqual([
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
    expect((await h.client.signMessage('evm-still-works', 137, 'hello')).verified).toBe(true);
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
    // Tron addresses carry a checksum, so no case variant of one is valid.
    const family = 'solana';
    // A different, still valid, address that differs from the original only in case.
    const swapCase = (address: string) => {
      for (let i = 0; i < address.length; i++) {
        const char = address[i];
        const other = char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase();
        const swapped = address.slice(0, i) + other + address.slice(i + 1);
        if (other !== char && isWalletAddress(family, swapped)) return swapped;
      }
      throw new Error(`No case variant of ${address} is a ${family} address`);
    };
    // A listed wallet whose address differs from the stored one only in case.
    const listed = sdkHarness();
    const created = await listed.client.createOrRestore({ families: [family] });
    const wallet = listed.remote.others.find((entry) => entry.networkFamily === family)!;
    wallet.address = swapCase(wallet.address);
    await expect(listed.client.rotate()).rejects.toMatchObject({ code: 'WALLET_MISMATCH' });
    expect((await listed.client.inspect()).wallets).toEqual(created.wallets);

    // A binding response that differs from the listed wallet only in case.
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
    await expect(bound.client.rotate()).rejects.toMatchObject({ code: 'WALLET_MISMATCH' });
  });
  it('settles an uncertain create of one family without duplicating it', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore();
    h.remote.failCreate = true;
    await expect(h.client.createOrRestore({ families: ['solana'] })).rejects.toThrow('Lost create');
    expect((await h.client.inspect()).creationUncertain).toBe(true);
    h.remote.failCreate = false;
    const snapshot = await h.create().createOrRestore({ families: ['solana'] });
    expect(snapshot.wallets.solana?.id).toBe('wallet-sol');
    expect(snapshot.creationUncertain).toBe(false);
    expect(calls(h.remote, 'CreateWallet')).toHaveLength(2);
  });
  it('rejects a created wallet of a different family', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore();
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) => {
      const response = await request(method, body, credential);
      if (method === 'CreateWallet' && body.networkFamily === 'tron')
        return { wallet: { id: 'x', address: SOLANA_ADDRESS, networkFamily: 'solana' } };
      return response;
    };
    await expect(h.client.createOrRestore({ families: ['tron'] })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
    expect((await h.client.inspect()).wallets.tron).toBeUndefined();
  });
  it('keeps every family across rotation and disable/enable', async () => {
    const h = sdkHarness();
    const before = await h.client.createOrRestore({ families: ['solana', 'tron'] });
    expect(before.wallet).toBeUndefined();
    const rotated = await h.client.rotate();
    expect(rotated.wallets).toEqual(before.wallets);
    expect(rotated.credentialId).not.toBe(before.credentialId);
    await h.client.setDisabled(true);
    expect((await h.client.setDisabled(false)).wallets).toEqual(before.wallets);
    // No EVM wallet is created for an identity that only uses Solana and Tron.
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
