import { hashTypedData } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  createSingleProcessExecutor,
  createSingleProcessExecutorPool,
  type TypedDataInput,
  type TypedDataSigningRequest
} from '@polygonlabs/oms-server-wallet-sdk';

import { tronToHex } from '../src/internal/protocol/addresses.js';
import { createServerWalletInternal, createServerWalletServiceInternal } from '../src/wallet.js';
import {
  FakeWaas,
  MemoryStore,
  TEST_PUBLISHABLE_KEY,
  TRON_ADDRESS,
  TRON_RECIPIENT,
  sdkHarness
} from './helpers.js';

const verifyingContract = '0x4444444444444444444444444444444444444444';
const permit: TypedDataInput = {
  domain: { name: 'Permit', version: '1', chainId: 137, verifyingContract },
  types: { Permit: [{ name: 'value', type: 'uint256' }] },
  primaryType: 'Permit',
  // `amount` is not declared by the types: it is not signed and must not reach the policy or WaaS.
  message: { value: '1000', amount: '1' }
};
const oidc = {
  subject: 'customer-1',
  issuer: 'https://issuer.example',
  audience: 'oms-server-wallet',
  getIdToken: async () => ({
    token: `fixture-${crypto.randomUUID()}`,
    expiresAt: Math.floor(Date.now() / 1000) + 300
  })
};
const signTypedDataCalls = (remote: FakeWaas) =>
  remote.calls.filter((call) => call.method === 'SignTypedData');

describe('typed-data signing is opt-in', () => {
  it('omits signTypedData from every factory that has no signing policy', async () => {
    const remote = new FakeWaas();
    const wallet = createServerWalletInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc,
        storage: { encryptedStore: new MemoryStore() },
        executor: createSingleProcessExecutor(),
        approval: 'allow-immediate'
      },
      { transport: remote }
    );
    const service = createServerWalletServiceInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc: { issuer: oidc.issuer, audience: oidc.audience, getIdToken: oidc.getIdToken },
        storage: { encryptedStore: { read: async () => null, write: async () => undefined } },
        executor: createSingleProcessExecutorPool()
      },
      { transport: remote }
    );
    const ephemeral = createServerWalletInternal(
      { publishableKey: TEST_PUBLISHABLE_KEY, oidc, storage: 'memory' },
      { transport: remote }
    );
    for (const handle of [wallet, service.forSubject('customer-2'), ephemeral]) {
      expect('signTypedData' in handle.evm).toBe(false);
      expect('signTypedData' in handle.tron).toBe(false);
      expect(typeof handle.evm.signMessage).toBe('function');
    }
  });

  it('rejects a signing option without a policy function', () => {
    expect(() =>
      createServerWalletInternal({
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc,
        storage: { encryptedStore: new MemoryStore() },
        executor: createSingleProcessExecutor(),
        signing: {} as never
      })
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION' }));
  });

  it('asks the policy with a frozen request holding only the signed fields', async () => {
    const seen: TypedDataSigningRequest[] = [];
    const h = sdkHarness({
      signing: {
        authorizeTypedData: (request) => {
          seen.push(request);
          return true;
        }
      }
    });
    const op = await h.client.evm.signTypedData({
      idempotencyKey: 'policy-sign-1',
      chainId: 137,
      typedData: permit
    });
    expect(op.status).toBe('signed');
    const wallet = (await h.client.inspect()).wallets.evm!.address;
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request).toMatchObject({
      family: 'evm',
      chainId: 137,
      subject: 'customer-1',
      walletAddress: wallet,
      idempotencyKey: 'policy-sign-1'
    });
    expect(request.typedData.message).toEqual({ value: '1000' });
    expect(request.digest).toBe(
      hashTypedData({
        domain: { name: 'Permit', version: '1', chainId: 137, verifyingContract },
        types: permit.types,
        primaryType: 'Permit',
        message: { value: 1000n }
      })
    );
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.typedData.message)).toBe(true);
    // WaaS signs exactly what the policy saw.
    expect(signTypedDataCalls(h.remote)[0].body.typedData).toMatchObject({
      message: { value: '1000' }
    });
    expect(
      (signTypedDataCalls(h.remote)[0].body.typedData as { message: object }).message
    ).not.toHaveProperty('amount');
  });

  it.each([
    ['false', false],
    ['a truthy non-boolean', 1],
    ['the string "true"', 'true'],
    ['undefined', undefined]
  ])(
    'refuses with TYPED_DATA_REFUSED when the policy returns %s, recording nothing',
    async (_, answer) => {
      let allow: unknown = answer;
      const h = sdkHarness({ signing: { authorizeTypedData: async () => allow as boolean } });
      const sign = () =>
        h.client.evm.signTypedData({
          idempotencyKey: 'policy-refused-1',
          chainId: 137,
          typedData: permit
        });
      await expect(sign()).rejects.toMatchObject({ code: 'TYPED_DATA_REFUSED' });
      expect(signTypedDataCalls(h.remote)).toHaveLength(0);
      expect(await h.client.evm.getOperation('policy-refused-1')).toBeNull();
      // The same key works once the policy approves.
      allow = true;
      expect((await sign()).status).toBe('signed');
    }
  );

  it('passes an error thrown by the policy through unchanged', async () => {
    const failure = new Error('policy store down');
    const h = sdkHarness({
      signing: {
        authorizeTypedData: () => {
          throw failure;
        }
      }
    });
    await expect(
      h.client.tron.signTypedData({
        idempotencyKey: 'policy-throws-1',
        network: 'tron:nile',
        typedData: {
          domain: { name: 'Permit', chainId: 3448148188, verifyingContract: TRON_RECIPIENT },
          types: { Permit: [{ name: 'value', type: 'uint256' }] },
          primaryType: 'Permit',
          message: { value: '1' }
        }
      })
    ).rejects.toBe(failure);
    expect(signTypedDataCalls(h.remote)).toHaveLength(0);
  });

  it('calls the policy as a method of the signing object', async () => {
    const policy = {
      allowed: 'Permit',
      authorizeTypedData(request: TypedDataSigningRequest) {
        return request.typedData.primaryType === this.allowed;
      }
    };
    const h = sdkHarness({ signing: policy });
    expect(
      (
        await h.client.evm.signTypedData({
          idempotencyKey: 'policy-this-1',
          chainId: 137,
          typedData: permit
        })
      ).status
    ).toBe('signed');
  });

  it('sends Tron requests with the network and refuses a self-verifying Tron domain', async () => {
    const seen: TypedDataSigningRequest[] = [];
    const h = sdkHarness({
      signing: {
        authorizeTypedData: (request) => {
          seen.push(request);
          return true;
        }
      }
    });
    const typedData = (verifying: string): TypedDataInput => ({
      domain: { name: 'Permit', chainId: 3448148188, verifyingContract: verifying },
      types: { Permit: [{ name: 'spender', type: 'address' }] },
      primaryType: 'Permit',
      message: { spender: TRON_RECIPIENT }
    });
    await h.client.tron.signTypedData({
      idempotencyKey: 'policy-tron-1',
      network: 'tron:nile',
      typedData: typedData(TRON_RECIPIENT)
    });
    expect(seen[0]).toMatchObject({
      family: 'tron',
      network: 'tron:nile',
      chainId: 3448148188,
      walletAddress: TRON_ADDRESS
    });
    expect(seen[0].typedData.message).toEqual({ spender: tronToHex(TRON_RECIPIENT) });
    await expect(
      h.client.tron.signTypedData({
        idempotencyKey: 'policy-tron-2',
        network: 'tron:nile',
        typedData: typedData(TRON_ADDRESS)
      })
    ).rejects.toMatchObject({ code: 'INVALID_TYPED_DATA' });
    expect(seen).toHaveLength(1);
  });

  it('asks the policy on in-memory handles too', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore({ families: ['evm', 'tron'] });
    const seen: TypedDataSigningRequest[] = [];
    let allow = false;
    const ephemeral = createServerWalletInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc,
        storage: 'memory',
        signing: {
          authorizeTypedData: (request) => {
            seen.push(request);
            return allow;
          }
        }
      },
      { transport: h.remote }
    );
    await ephemeral.restore();
    const before = signTypedDataCalls(h.remote).length;
    await expect(
      ephemeral.evm.signTypedData({
        idempotencyKey: `eph-${crypto.randomUUID()}`,
        chainId: 137,
        typedData: permit
      })
    ).rejects.toMatchObject({ code: 'TYPED_DATA_REFUSED' });
    expect(signTypedDataCalls(h.remote)).toHaveLength(before);
    allow = true;
    expect(
      await ephemeral.evm.signTypedData({
        idempotencyKey: `eph-${crypto.randomUUID()}`,
        chainId: 137,
        typedData: permit
      })
    ).toMatchObject({
      verified: true
    });
    expect(seen[0]).toMatchObject({ family: 'evm', subject: 'customer-1' });
    expect(seen[0].idempotencyKey).toMatch(/^eph-/);
    await ephemeral.close();
  });
});
