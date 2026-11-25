import { describe, expect, it } from 'vitest';

import type { TypedDataInput } from '@polygonlabs/oms-server-wallet-sdk';

import { createEphemeralServerWalletInternal } from '../src/wallet.js';
import { FakeWaas, TEST_PUBLISHABLE_KEY, sdkHarness } from './helpers.js';

const usdt = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
const tronTypedData: TypedDataInput = {
  domain: { name: 'Permit', version: '1', chainId: 3448148188 as const, verifyingContract: usdt },
  types: { Note: [{ name: 'text', type: 'string' }] },
  primaryType: 'Note',
  message: { text: 'ephemeral' }
};
const evmTypedData = (verifyingContract: string): TypedDataInput => ({
  domain: { name: 'Acceptance', version: '1', chainId: 137 as const, verifyingContract },
  types: { Check: [{ name: 'note', type: 'string' }] },
  primaryType: 'Check',
  message: { note: 'ephemeral' }
});

const ephemeral = (remote: FakeWaas, oidc: { sessionLifetimeSeconds?: number } = {}) =>
  createEphemeralServerWalletInternal(
    {
      publishableKey: TEST_PUBLISHABLE_KEY,
      oidc: {
        subject: 'customer-1',
        issuer: 'https://issuer.example',
        audience: 'oms-server-wallet',
        getIdToken: async () => ({
          token: `fixture-${crypto.randomUUID()}`,
          expiresAt: Math.floor(Date.now() / 1000) + 300
        }),
        ...oidc
      },
      signing: { authorizeTypedData: () => true }
    },
    { transport: remote }
  );

/** A FakeWaas whose identity already holds EVM, Solana and Tron wallets, created durably. */
async function provisioned() {
  const h = sdkHarness();
  await h.client.createOrRestore({ families: ['evm', 'solana', 'tron'] });
  return h.remote;
}
const calls = (remote: FakeWaas, method: string) =>
  remote.calls.filter((call) => call.method === method);

describe('createEphemeralServerWallet', () => {
  it('never creates wallets: restore and signing need an existing wallet', async () => {
    const remote = new FakeWaas();
    const wallet = ephemeral(remote);
    await expect(
      wallet.evm.signMessage({ chainId: 137 as const, message: 'hi' })
    ).rejects.toMatchObject({
      code: 'WALLET_NOT_INITIALIZED'
    });
    await expect(wallet.restore()).rejects.toMatchObject({ code: 'WALLET_NOT_INITIALIZED' });
    await expect(wallet.restore({ families: ['solana'] })).rejects.toMatchObject({
      code: 'WALLET_NOT_INITIALIZED'
    });
    expect(calls(remote, 'CreateWallet')).toHaveLength(0);
  });

  it('restores existing wallets and signs on every family with WaaS verification', async () => {
    const remote = await provisioned();
    const before = calls(remote, 'CreateWallet').length;
    const listsBefore = calls(remote, 'ListWallets').length;
    const wallet = ephemeral(remote);
    const snapshot = await wallet.restore();
    expect(Object.keys(snapshot.wallets).sort()).toEqual(['evm', 'solana', 'tron']);
    expect(calls(remote, 'ListWallets')).toHaveLength(listsBefore);
    expect(calls(remote, 'CompleteAuth').at(-1)?.body.lifetime).toBe(900);

    await expect(
      wallet.evm.signMessage({ chainId: 80002 as const, message: 'hi' })
    ).resolves.toEqual({
      signature: '0x1234',
      verified: true
    });
    await expect(
      wallet.evm.signTypedData({
        chainId: 137 as const,
        typedData: evmTypedData('0x000000000000000000000000000000000000dEaD')
      })
    ).resolves.toMatchObject({ verified: true });
    await expect(wallet.solana.signMessage({ message: 'hi' })).resolves.toMatchObject({
      verified: true
    });
    await expect(wallet.tron.signMessage({ message: 'hi' })).resolves.toMatchObject({
      verified: true
    });
    await expect(
      wallet.tron.signTypedData({ network: 'tron:nile', typedData: tronTypedData })
    ).resolves.toMatchObject({ verified: true });
    expect(calls(remote, 'CreateWallet')).toHaveLength(before);
  });

  it('refuses typed data that could authorize the wallet itself', async () => {
    const remote = await provisioned();
    const wallet = ephemeral(remote);
    const {
      wallets: { evm }
    } = await wallet.restore({ families: ['evm'] });
    const signed = calls(remote, 'SignTypedData').length;
    await expect(
      wallet.evm.signTypedData({ chainId: 137 as const, typedData: evmTypedData(evm!.address) })
    ).rejects.toMatchObject({ code: 'INVALID_TYPED_DATA' });
    await expect(
      wallet.evm.signTypedData({
        chainId: 137 as const,
        typedData: {
          domain: {
            name: 'Sequence Wallet',
            version: '3',
            chainId: 137 as const,
            verifyingContract: evm!.address
          },
          types: { Calls: [{ name: 'nonce', type: 'uint256' }] },
          primaryType: 'Calls',
          message: { nonce: '1' }
        }
      })
    ).rejects.toMatchObject({ code: 'INVALID_TYPED_DATA' });
    expect(calls(remote, 'SignTypedData')).toHaveLength(signed);
  });

  it('runs handles for one identity in parallel with distinct credentials', async () => {
    const remote = await provisioned();
    const handles = [ephemeral(remote), ephemeral(remote), ephemeral(remote)];
    const snapshots = await Promise.all(
      handles.map((handle) => handle.restore({ families: ['evm'] }))
    );
    expect(new Set(snapshots.map((snapshot) => snapshot.credentialId)).size).toBe(3);
    expect(new Set(snapshots.map((snapshot) => snapshot.wallets.evm?.address)).size).toBe(1);
    remote.maxInFlight = 0;
    const results = await Promise.all(
      handles.flatMap((handle) =>
        [1, 2].map((n) =>
          handle.evm.signMessage({ chainId: 137 as const, message: `parallel ${n}` })
        )
      )
    );
    expect(results.every((result) => result.verified)).toBe(true);
    expect(remote.maxInFlight).toBeGreaterThan(1);
  });

  it('close revokes the credential, blocks every later or queued call, and can be retried', async () => {
    const remote = await provisioned();
    const wallet = ephemeral(remote);
    const { credentialId } = await wallet.restore();

    remote.failRevoke = true;
    const queued = wallet.inspect();
    await expect(wallet.close()).rejects.toThrow('Unavailable');
    await expect(queued).rejects.toMatchObject({ code: 'WALLET_CLOSED' });
    expect(remote.revoked.has(credentialId!)).toBe(false);

    remote.failRevoke = false;
    await wallet.close();
    expect(remote.revoked.has(credentialId!)).toBe(true);
    const revokes = calls(remote, 'RevokeCredential').length;
    await wallet.close();
    expect(calls(remote, 'RevokeCredential')).toHaveLength(revokes);

    for (const call of [
      () => wallet.inspect(),
      () => wallet.restore(),
      () => wallet.rotateCredential(),
      () => wallet.evm.signMessage({ chainId: 137 as const, message: 'hi' }),
      () => wallet.indexer.getEvmBalances()
    ])
      await expect(call()).rejects.toMatchObject({ code: 'WALLET_CLOSED' });
  });

  it('revokes a credential whose sign-in failed part way', async () => {
    const remote = await provisioned();
    const request = remote.request.bind(remote);
    let failUseWallet = true;
    remote.request = async (method, body, credential) => {
      if (method === 'UseWallet' && failUseWallet) throw new Error('UseWallet unavailable');
      return request(method, body, credential);
    };
    const wallet = ephemeral(remote);
    // With families, wallets are bound inside sign-in, before the credential gets its expiresAt.
    await expect(wallet.restore({ families: ['evm'] })).rejects.toThrow('UseWallet unavailable');
    const { credentialId, expiresAt } = await wallet.inspect();
    expect(credentialId).toBeDefined();
    expect(expiresAt).toBeUndefined();
    failUseWallet = false;
    await wallet.close();
    expect(remote.revoked.has(credentialId!)).toBe(true);
  });

  it('rotates to a new credential for the restored wallets', async () => {
    const remote = await provisioned();
    const wallet = ephemeral(remote);
    const first = await wallet.restore({ families: ['evm', 'tron'] });
    const rotated = await wallet.rotateCredential();
    expect(rotated.credentialId).not.toBe(first.credentialId);
    expect(remote.revoked.has(first.credentialId!)).toBe(true);
    expect(rotated.wallets.tron?.address).toBe(first.wallets.tron?.address);
  });

  it('re-authenticates during restore when a cached credential was revoked server-side', async () => {
    const remote = await provisioned();
    const wallet = ephemeral(remote);
    const first = await wallet.restore({ families: ['evm'] });
    // Simulate server-side revocation before local expiresAt elapses.
    remote.revoked.add(first.credentialId!);
    const second = await wallet.restore();
    expect(second.credentialId).not.toBe(first.credentialId);
    expect(Object.keys(second.wallets).sort()).toEqual(['evm', 'solana', 'tron']);
  });

  it('does not persist or attempt to revoke a credential when getIdToken fails before sign-in', async () => {
    const remote = await provisioned();
    const wallet = createEphemeralServerWalletInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc: {
          subject: 'customer-1',
          issuer: 'https://issuer.example',
          audience: 'oms-server-wallet',
          getIdToken: async () => {
            throw new Error('IdP down');
          }
        }
      },
      { transport: remote }
    );
    await expect(wallet.restore()).rejects.toThrow('IdP down');
    expect((await wallet.inspect()).credentialId).toBeUndefined();
    const revokesBefore = calls(remote, 'RevokeCredential').length;
    await wallet.close();
    expect(calls(remote, 'RevokeCredential')).toHaveLength(revokesBefore);
  });

  it('rejects durable-only options at runtime', () => {
    for (const extra of [
      { store: {} },
      { executor: {} },
      { swaps: {} },
      { approval: 'allow-immediate' },
      { storage: {} }
    ])
      expect(() =>
        createEphemeralServerWalletInternal({
          publishableKey: TEST_PUBLISHABLE_KEY,
          oidc: {
            subject: 'customer-1',
            issuer: 'https://issuer.example',
            audience: 'oms-server-wallet',
            getIdToken: async () => ({ token: 't', expiresAt: 1 })
          },
          ...extra
        } as never)
      ).toThrow(expect.objectContaining({ code: 'CONFIGURATION' }));
  });
});
