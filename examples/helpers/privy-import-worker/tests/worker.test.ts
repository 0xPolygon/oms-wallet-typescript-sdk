import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleRequest } from '../worker/index';

const localOrigin = 'http://localhost:5173';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Privy import Worker', () => {
  it.each([localOrigin, 'https://0xpolygon.github.io'])(
    'answers CORS preflights for %s',
    async (origin) => {
      const response = await handleRequest(
        new Request('https://worker.example/v1/disposable-wallets/export', {
          method: 'OPTIONS',
          headers: { Origin: origin }
        }),
        testEnv()
      );

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    }
  );

  it('rejects mutation requests from other origins', async () => {
    const response = await handleRequest(
      createRequest({ origin: 'https://attacker.example' }),
      testEnv()
    );

    expect(response.status).toBe(403);
  });

  it('rate limits disposable-wallet creation per client', async () => {
    const response = await handleRequest(createRequest(), testEnv(false));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: 'Too many test-wallet requests. Try again shortly.'
    });
  });

  it('creates a wallet owned by a fresh key and exports it to the caller recipient key', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const privyFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          id: 'privy-wallet-id',
          address: '0x1111111111111111111111111111111111111111'
        })
      )
      .mockResolvedValueOnce(
        Response.json({ ciphertext: 'ciphertext', encapsulated_key: 'encapsulated-key' })
      );
    const generateSignature = vi.fn(() => 'authorization-signature');

    const response = await handleRequest(createRequest(), testEnv(), {
      fetch: privyFetch,
      generateP256KeyPair: vi.fn(async () => ({
        publicKey: 'authorization-public-key',
        privateKey: 'authorization-private-key'
      })),
      generateAuthorizationSignature: generateSignature
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(localOrigin);
    await expect(response.json()).resolves.toEqual({
      walletId: 'privy-wallet-id',
      address: '0x1111111111111111111111111111111111111111',
      ciphertext: 'ciphertext',
      encapsulatedKey: 'encapsulated-key'
    });
    const basicAuth = `Basic ${btoa('privy-app-id:privy-app-secret')}`;
    const exportUrl = 'https://api.privy.io/v1/wallets/privy-wallet-id/export';
    const exportBody = { encryption_type: 'HPKE', recipient_public_key: 'recipient-public-key' };
    const requestExpiry = String(1_700_000_000_000 + 5 * 60 * 1_000);
    expect(privyFetch.mock.calls.map(([url, init]) => ({ url, ...init }))).toEqual([
      {
        url: 'https://api.privy.io/v1/wallets',
        method: 'POST',
        headers: {
          Authorization: basicAuth,
          'Content-Type': 'application/json',
          'privy-app-id': 'privy-app-id'
        },
        body: JSON.stringify({
          chain_type: 'ethereum',
          display_name: 'OMS wallet import demo',
          owner: { public_key: 'authorization-public-key' }
        })
      },
      {
        url: exportUrl,
        method: 'POST',
        headers: {
          Authorization: basicAuth,
          'Content-Type': 'application/json',
          'privy-app-id': 'privy-app-id',
          'privy-authorization-signature': 'authorization-signature',
          'privy-request-expiry': requestExpiry
        },
        body: JSON.stringify(exportBody)
      }
    ]);
    expect(generateSignature.mock.calls).toEqual([
      [
        {
          authorizationPrivateKey: 'authorization-private-key',
          input: {
            version: 1,
            method: 'POST',
            url: exportUrl,
            body: exportBody,
            headers: { 'privy-app-id': 'privy-app-id', 'privy-request-expiry': requestExpiry }
          }
        }
      ]
    ]);
  });

  it.each([
    { step: 'creation', failAt: 0, error: 'Privy wallet creation failed with status 401.' },
    { step: 'export', failAt: 1, error: 'Privy wallet export failed with status 401.' }
  ])('returns 400 when Privy wallet $step fails', async ({ failAt, error }) => {
    const responses = [
      Response.json({
        id: 'privy-wallet-id',
        address: '0x1111111111111111111111111111111111111111'
      }),
      Response.json({ ciphertext: 'ciphertext', encapsulated_key: 'encapsulated-key' })
    ];
    responses[failAt] = Response.json({ error: 'unauthorized' }, { status: 401 });
    const privyFetch = vi.fn<typeof fetch>(async () => responses.shift()!);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(createRequest(), testEnv(), {
      fetch: privyFetch,
      generateP256KeyPair: vi.fn(async () => ({ publicKey: 'public', privateKey: 'private' })),
      generateAuthorizationSignature: vi.fn(() => 'signature')
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(privyFetch).toHaveBeenCalledTimes(failAt + 1);
  });

  it('rejects an oversized request body before contacting Privy', async () => {
    const privyFetch = vi.fn<typeof fetch>();
    const generateP256KeyPair = vi.fn(async () => ({ publicKey: 'public', privateKey: 'private' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(
      createRequest({
        body: JSON.stringify({ recipientPublicKey: 'k', padding: 'x'.repeat(16_384) })
      }),
      testEnv(),
      { fetch: privyFetch, generateP256KeyPair, generateAuthorizationSignature: vi.fn() }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Request body is too large.' });
    expect(generateP256KeyPair).not.toHaveBeenCalled();
    expect(privyFetch).not.toHaveBeenCalled();
  });
});

function createRequest(options: { origin?: string; body?: string } = {}): Request {
  return new Request('https://worker.example/v1/disposable-wallets/export', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': '203.0.113.10',
      'Content-Type': 'application/json',
      Origin: options.origin ?? localOrigin
    },
    body: options.body ?? JSON.stringify({ recipientPublicKey: 'recipient-public-key' })
  });
}

function testEnv(rateLimitSuccess = true): Env {
  return {
    PRIVY_APP_ID: 'privy-app-id',
    PRIVY_APP_SECRET: 'privy-app-secret',
    PRIVY_EXPORT_RATE_LIMITER: {
      limit: vi.fn(async () => ({ success: rateLimitSuccess }))
    }
  };
}
