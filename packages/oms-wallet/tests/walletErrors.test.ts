import { afterEach, describe, expect, it, vi } from 'vitest';

import { WalletClientImpl } from '../src/clients/walletClient';
import { Waas } from '../src/generated/waas.gen';
import { MemoryStorageManager } from '../src/storageManager';
import { testWalletAccount } from './fixtures/walletAccount.js';
import {
  MockSigner,
  jsonResponse,
  testEnvironment,
  testStoredExpiryBounds,
  waasErrorResponse,
  testStorageKeys
} from './fixtures/helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WalletClient errors', () => {
  it('maps consumed auth commitments to a specific SDK error code', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith('/CompleteAuth')) {
        return jsonResponse(
          {
            code: 7008,
            name: 'CommitmentConsumed',
            message: 'The authentication commitment has already been used',
            status: 400
          },
          400
        );
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage: new MemoryStorageManager(),
      credentialSigner: new MockSigner()
    });
    seedEmailAuthAttempt(wallet);

    await expect(wallet.completeEmailAuth({ code: '123456' })).rejects.toMatchObject({
      code: 'OMS_AUTH_COMMITMENT_CONSUMED',
      operation: 'wallet.completeEmailAuth',
      status: 400,
      retryable: false
    });
    await expect(wallet.completeEmailAuth({ code: '123456' })).rejects.toMatchObject({
      code: 'OMS_SESSION_MISSING',
      operation: 'wallet.completeEmailAuth',
      message: 'No pending email auth attempt'
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('validates requested session lifetimes before auth requests', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage: new MemoryStorageManager(),
      redirectAuthStorage: new MemoryStorageManager(),
      credentialSigner: new MockSigner()
    });

    await expect(
      wallet.startEmailAuth({
        email: 'user@example.com',
        sessionLifetimeSeconds: 0
      })
    ).rejects.toMatchObject({
      code: 'OMS_VALIDATION_ERROR',
      operation: 'wallet.startEmailAuth'
    });
    await expect(
      wallet.startOidcRedirectAuth({
        provider: {
          clientId: 'google-client',
          issuer: 'https://accounts.google.com',
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          providerRedirectUri: 'https://app.example/callback'
        },
        sessionLifetimeSeconds: 1.5
      })
    ).rejects.toMatchObject({
      code: 'OMS_VALIDATION_ERROR',
      operation: 'wallet.startOidcRedirectAuth'
    });
    await expect(
      wallet.signInWithOidcIdToken({
        idToken: 'invalid-token',
        issuer: 'https://accounts.google.com',
        audience: 'google-client',
        sessionLifetimeSeconds: 15_552_001
      })
    ).rejects.toMatchObject({
      code: 'OMS_VALIDATION_ERROR',
      operation: 'wallet.signInWithOidcIdToken',
      message:
        'wallet.signInWithOidcIdToken requires sessionLifetimeSeconds to be an integer between 1 and 15552000'
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // 180 days is the largest accepted lifetime.
    fetchMock.mockResolvedValueOnce(jsonResponse({ verifier: 'verifier-1', challenge: 'c' }));
    await expect(
      wallet.startEmailAuth({ email: 'user@example.com', sessionLifetimeSeconds: 15_552_000 })
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('maps an already-imported address from importEncryptedWallet to a stable public error', async () => {
    const storage = new MemoryStorageManager();
    storage.set(
      testStorageKeys.session,
      JSON.stringify({
        version: 2,
        scope: {
          projectId: 'project-id',
          walletApiUrl: 'https://wallet.example',
          indexerGatewayUrl: 'https://indexer.example'
        },
        wallet: testWalletAccount('wallet-id', '0x1111111111111111111111111111111111111111'),
        expiresAt: '2099-01-01T00:00:00Z',
        auth: { type: 'email', email: 'user@example.com' },
        signerCredentialId: '0x04' + '11'.repeat(64),
        signerKeyType: 'ecdsa-p256-sha256',
        ...testStoredExpiryBounds('2099-01-01T00:00:00Z')
      })
    );
    // The restored session's expiry refresh answers as a server without GetCredential.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => waasErrorResponse('WebrpcBadRoute'))
    );
    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      credentialSigner: new MockSigner(),
      walletImportTrustedPcr0s: ['1'.repeat(96)]
    });
    const importFetch = vi.fn(async () =>
      jsonResponse(
        {
          error: 'AddressAlreadyImported',
          code: 7313,
          msg: 'address already imported',
          status: 400
        },
        400
      )
    );
    // The attested import transport is replaced with an unattested generated client so the
    // WaaS error body is parsed exactly as the wire returns it.
    (wallet as any).walletImportClient = new Waas('https://wallet.example', importFetch);

    const error = await wallet
      .importEncryptedWallet({
        walletType: 'ethereum',
        keyMaterial: {
          keyId: 'key-1',
          cipherSuite: 'p256-sha256-aes256gcm',
          encapsulatedKey: 'AQID',
          ciphertext: 'BAUG'
        }
      })
      .catch((caught: unknown) => caught);

    expect(importFetch).toHaveBeenCalledOnce();
    expect(error).toMatchObject({
      code: 'OMS_WALLET_ADDRESS_ALREADY_IMPORTED',
      operation: 'wallet.importEncryptedWallet',
      status: 409,
      retryable: false,
      upstreamError: { service: 'waas', name: 'AddressAlreadyImported', code: '7313' }
    });
    expect(wallet.activeWallet?.id).toBe('wallet-id');
  });
});

function seedEmailAuthAttempt(wallet: WalletClientImpl): void {
  (wallet as any).activeEmailAuthAttempt = {
    verifier: 'verifier-1',
    challenge: 'challenge-1',
    sessionLifetimeSeconds: 604_800
  };
}
