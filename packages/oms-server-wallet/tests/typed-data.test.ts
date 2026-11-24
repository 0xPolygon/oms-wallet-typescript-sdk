import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/json.js';
import { validateTypedData } from '../src/typed-data.js';
import { sdkHarness } from './helpers.js';
import { recoveryFixture } from './fixtures/trails.js';

describe('lossless bounded authorization data', () => {
  it('canonicalizes object order and bigints without losing precision', () => {
    expect(canonicalJson({ z: 123456789012345678901n, a: [true, null, 0.005] })).toBe(
      '{"a":[true,null,0.005],"z":"123456789012345678901"}'
    );
  });
  it('rejects unsafe numbers, invalid values, reserved keys, depth, cycles and size', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const value of [
      NaN,
      Infinity,
      9007199254740992,
      undefined,
      new Date(),
      () => 1,
      JSON.parse('{"__proto__":{}}'),
      cyclic,
      Array(20_001).fill(null)
    ]) {
      expect(() => canonicalJson(value)).toThrow(/bounded JSON/);
    }
    expect(() => canonicalJson('é'.repeat(100), 100)).toThrow();
  });
  it('pins chain and contract in the EIP-712 domain and normalizes decimal inputs', () => {
    const { typedData } = recoveryFixture();
    const validated = validateTypedData(typedData, 137);
    expect(validated.digest).toMatch(/^0x[a-f0-9]{64}$/);
    expect(
      validateTypedData({ ...typedData, domain: { ...typedData.domain, chainId: '137' } }, 137)
        .digest
    ).toBe(validated.digest);
    expect(validated.typedData.types.EIP712Domain).toContainEqual({
      name: 'chainId',
      type: 'uint256'
    });
    for (const data of [
      { ...typedData, domain: { ...typedData.domain, chainId: 1 } },
      { ...typedData, domain: { chainId: 137 } },
      { ...typedData, primaryType: 'Absent' },
      { ...typedData, primaryType: 'EIP712Domain' },
      { ...typedData, types: { ...typedData.types, EIP712Domain: [] } },
      { ...typedData, message: { ...typedData.message, space: 9007199254740992 } }
    ])
      expect(() => validateTypedData(data, 137)).toThrow(/EIP-712/);
    expect(() => validateTypedData(typedData, 10)).toThrow();
  });
});

describe('WaaS typed-data signing', () => {
  it('signs via the credential executor, verifies wallet-aware signatures and persists idempotent results', async () => {
    const h = sdkHarness();
    const { typedData } = recoveryFixture();
    const operation = await h.client.evm.signTypedData({
      idempotencyKey: 'typed-sign-1',
      chainId: 137,
      typedData
    });
    expect(operation).toMatchObject({
      kind: 'signTypedData',
      status: 'signed',
      verified: true,
      signature: '0x1234'
    });
    expect(
      await h.create().evm.signTypedData({
        idempotencyKey: 'typed-sign-1',
        chainId: 137,
        typedData: { ...typedData }
      })
    ).toEqual(operation);
    const calls = h.remote.calls.filter((c) => c.method.includes('TypedData'));
    expect(calls.map((c) => c.method)).toEqual(['SignTypedData', 'IsValidTypedDataSignature']);
    expect(calls[0].body).toMatchObject({ network: '137', walletId: 'wallet-1' });
    expect(calls[1].body).not.toHaveProperty('networkFamily');
    expect(calls[1].credential).toBeUndefined();
    const changed = structuredClone(typedData);
    changed.message.space = '123456790';
    await expect(
      h.client.evm.signTypedData({
        idempotencyKey: 'typed-sign-1',
        chainId: 137,
        typedData: changed
      })
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT'
    });
    await expect(
      h.client.evm.signMessage({ idempotencyKey: 'typed-sign-1', chainId: 137, message: 'message' })
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT'
    });
  });
  it('snapshots before queuing, serializes nonce use, and automatically reauthenticates', async () => {
    const h = sdkHarness();
    const { typedData } = recoveryFixture();
    await h.client.createOrRestore();
    h.remote.expiredOnce = true;
    const expectedSpace = typedData.message.space;
    const pending = h.client.evm.signTypedData({
      idempotencyKey: 'typed-queued',
      chainId: 137,
      typedData
    });
    typedData.message.space = '987654321';
    await Promise.all([
      pending,
      h.create().evm.signTypedData({ idempotencyKey: 'typed-concurrent', chainId: 137, typedData })
    ]);
    expect(h.remote.maxInFlight).toBe(1);
    expect(h.remote.calls.filter((c) => c.method === 'CompleteAuth')).toHaveLength(2);
    expect(h.remote.calls.find((c) => c.method === 'SignTypedData')!.body.typedData).toMatchObject({
      message: { space: expectedSpace }
    });
  });
  it('rejects invalid data before authentication and blocks disabled wallets', async () => {
    const h = sdkHarness();
    const { typedData } = recoveryFixture();
    await expect(
      h.client.evm.signTypedData({ idempotencyKey: 'typed-bad-chain', chainId: 1, typedData })
    ).rejects.toMatchObject({
      code: 'INVALID_TYPED_DATA'
    });
    expect(h.remote.calls).toHaveLength(0);
    await h.client.disable();
    await expect(
      h.client.evm.signTypedData({ idempotencyKey: 'typed-disabled', chainId: 137, typedData })
    ).rejects.toMatchObject({
      code: 'WALLET_DISABLED'
    });
    expect(h.remote.calls).toHaveLength(0);
  });
  it('never exposes unverified signatures or blindly resigns after verification failure', async () => {
    const h = sdkHarness();
    const { typedData } = recoveryFixture();
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) =>
      method === 'IsValidTypedDataSignature'
        ? { isValid: false }
        : request(method, body, credential);
    await expect(
      h.client.evm.signTypedData({ idempotencyKey: 'typed-invalid', chainId: 137, typedData })
    ).rejects.toMatchObject({
      code: 'SIGNATURE_INVALID'
    });
    expect(
      await h
        .create()
        .evm.signTypedData({ idempotencyKey: 'typed-invalid', chainId: 137, typedData })
    ).toMatchObject({
      status: 'failed',
      error: 'SIGNATURE_INVALID'
    });
    expect(await h.client.evm.getOperation('typed-invalid')).not.toHaveProperty('signature');
    expect(h.remote.calls.filter((c) => c.method === 'SignTypedData')).toHaveLength(1);
  });
});
