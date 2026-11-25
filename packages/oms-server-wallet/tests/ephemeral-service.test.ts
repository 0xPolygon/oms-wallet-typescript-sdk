import { describe, expect, it } from 'vitest';

import { createEphemeralServerWalletServiceInternal } from '../src/wallet.js';
import { FakeWaas, TEST_PUBLISHABLE_KEY } from './helpers.js';

/** A FakeWaas that signs each ID token in as the subject encoded in it. */
function multiUserWaas() {
  const remote = new FakeWaas();
  const request = remote.request.bind(remote);
  remote.request = async (method, body, credential) => {
    const response = await request(method, body, credential);
    if (method === 'CompleteAuth') {
      const sub = String(body.answer).split(':')[1];
      return {
        ...(response as object),
        identity: { type: 'oidc', iss: 'https://issuer.example', sub }
      };
    }
    return response;
  };
  return remote;
}

const service = (
  remote: FakeWaas,
  cache?: { maxHandles?: number; idleTimeoutMs?: number },
  clock?: () => number
) =>
  createEphemeralServerWalletServiceInternal(
    {
      publishableKey: TEST_PUBLISHABLE_KEY,
      oidc: {
        issuer: 'https://issuer.example',
        audience: 'oms-server-wallet',
        getIdToken: async (subject) => ({
          token: `fixture:${subject}:${crypto.randomUUID()}`,
          expiresAt: Math.floor(Date.now() / 1000) + 300
        })
      },
      approval: 'allow-immediate',
      ...(cache ? { cache } : {})
    },
    { transport: remote, clock }
  );
const signIns = (remote: FakeWaas) =>
  remote.calls.filter((call) => call.method === 'CompleteAuth').length;

describe('createEphemeralServerWalletService', () => {
  it('reuses a cached handle per subject, so a warm request does not sign in again', async () => {
    const remote = multiUserWaas();
    const wallets = service(remote);
    await wallets.forSubject('alice').create();
    const after = signIns(remote);
    const again = wallets.forSubject('alice');
    await again.restore({ families: ['evm'] });
    expect(signIns(remote)).toBe(after);
    expect('close' in again).toBe(false);
    await wallets.forSubject('bob').create();
    expect(signIns(remote)).toBe(after + 1);
  });

  it('drops the least recently used handle past maxHandles, and idle handles, without revoking', async () => {
    let now = Date.now();
    const remote = multiUserWaas();
    const wallets = service(remote, { maxHandles: 2, idleTimeoutMs: 60_000 }, () => now);
    const alice = (await wallets.forSubject('alice').create()).credentialId!;
    await wallets.forSubject('bob').create();
    await wallets.forSubject('carol').create();
    expect(remote.revoked.size).toBe(0);
    // alice was dropped: a new handle signs in again with a new credential.
    expect(
      (await wallets.forSubject('alice').restore({ families: ['evm'] })).credentialId
    ).not.toBe(alice);
    const before = signIns(remote);
    now += 61_000;
    await wallets.forSubject('carol').restore({ families: ['evm'] });
    expect(signIns(remote)).toBe(before + 1);
    expect(remote.revoked.size).toBe(0);
  });

  it('revokes on evict(subject) and on close(), after which forSubject throws', async () => {
    const remote = multiUserWaas();
    const wallets = service(remote);
    const alice = (await wallets.forSubject('alice').create()).credentialId!;
    const bob = (await wallets.forSubject('bob').create()).credentialId!;
    await wallets.evict('alice');
    expect(remote.revoked.has(alice)).toBe(true);
    await wallets.close();
    expect(remote.revoked.has(bob)).toBe(true);
    expect(() => wallets.forSubject('bob')).toThrow(
      expect.objectContaining({ code: 'WALLET_CLOSED' })
    );
  });

  it('sends from different users in parallel', async () => {
    const remote = multiUserWaas();
    const wallets = service(remote);
    const users = ['alice', 'bob', 'carol'];
    await Promise.all(users.map((user) => wallets.forSubject(user).create()));
    const sent = await Promise.all(
      users.map((user) =>
        wallets.forSubject(user).evm.sendTransfer({
          idempotencyKey: `pay-${user}-0001`,
          chainId: 137,
          to: '0x2222222222222222222222222222222222222222',
          asset: 'native',
          amount: '1'
        })
      )
    );
    expect(sent.every((op) => op.status === 'pending')).toBe(true);
  });

  it('rejects storage and executor options', () => {
    expect(() =>
      createEphemeralServerWalletServiceInternal({
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc: {
          issuer: 'https://issuer.example',
          audience: 'oms-server-wallet',
          getIdToken: async () => ({ token: 't', expiresAt: 1 })
        },
        executor: (() => ({ run: async () => undefined })) as never
      } as never)
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION' }));
  });
});
