import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletClientImpl } from '../src/clients/walletClient';
import type { CredentialSigner } from '../src/credentialSigner';
import { Networks } from '../src/networks';
import { OMSWallet } from '../src/omsWallet';
import { MemoryStorageManager } from '../src/storageManager';
import { sessionStorageKeys } from '../src/utils/constants';
import { RequestUtils } from '../src/utils/requestUtils';
import { WalletType } from '../src/types/waas';
import { testWalletAccount } from './fixtures/walletAccount.js';
import {
  MockSigner as FixtureMockSigner,
  jsonResponse,
  requestCount,
  sessionChangeReasons,
  testCredential,
  testEnvironment,
  testExpiryBounds,
  testStoredExpiryBounds,
  waasErrorResponse,
  testStorageKeys
} from './fixtures/helpers.js';

/** Fixture signer with a `clear` spy for sign-out and expiry cleanup assertions. */
class MockSigner extends FixtureMockSigner {
  clear = vi.fn(async () => {});

  constructor(available = true) {
    super(undefined, available);
  }
}

beforeEach(() => {
  // Default WaaS for tests that send no request of their own: a server without GetCredential, so a
  // restored session's background expiry refresh keeps the local expiry.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => waasErrorResponse('WebrpcBadRoute'))
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function seedEmailAuthAttempt(
  wallet: WalletClientImpl,
  verifier = 'verifier-1',
  challenge = 'challenge-1',
  sessionLifetimeSeconds = 604_800,
  email = 'user@example.com'
): void {
  (wallet as any).activeEmailAuthAttempt = { email, verifier, challenge, sessionLifetimeSeconds };
}

function emailAuth(email = 'user@example.com') {
  return { type: 'email' as const, email };
}

function googleAuth(email = 'user@example.com') {
  return {
    type: 'oidc' as const,
    flow: 'redirect' as const,
    issuer: 'https://accounts.google.com',
    provider: 'google',
    providerLabel: 'Google',
    email
  };
}

const directSessionScope = {
  projectId: 'project-id',
  walletApiUrl: 'https://wallet.example',
  indexerGatewayUrl: 'https://indexer.example'
};

const omsSessionScope = {
  projectId: 'prj_project',
  walletApiUrl: 'https://sandbox-api.dev.polygon-dev.technology',
  indexerGatewayUrl: 'https://sandbox-api.dev.polygon-dev.technology/v1/IndexerGateway/'
};

/** The storage keys of the project `OMSWallet` derives from `pk_dev_sdbx_project_key`. */
const omsStorageKeys = sessionStorageKeys(omsSessionScope.projectId, omsSessionScope.walletApiUrl);

function seedStoredSession(
  storage: MemoryStorageManager,
  params: {
    walletId?: string;
    walletAddress?: string;
    expiresAt?: string;
    auth?: ReturnType<typeof emailAuth> | ReturnType<typeof googleAuth>;
    scope?: typeof directSessionScope;
    signerCredentialId?: string;
    signerKeyType?: CredentialSigner['signingAlgorithm'];
    /** Where the record is stored; by default, under its scope's key. */
    key?: string;
  } = {}
): void {
  const scope = params.scope ?? directSessionScope;
  storage.set(
    params.key ?? sessionStorageKeys(scope.projectId, scope.walletApiUrl).session,
    JSON.stringify({
      version: 2,
      scope,
      wallet: testWalletAccount(
        params.walletId ?? 'wallet-id',
        params.walletAddress ?? '0x1111111111111111111111111111111111111111'
      ),
      expiresAt: params.expiresAt ?? '2099-01-01T00:00:00Z',
      auth: params.auth ?? emailAuth(),
      signerCredentialId: params.signerCredentialId ?? '0x04' + '11'.repeat(64),
      signerKeyType: params.signerKeyType ?? 'ecdsa-p256-sha256',
      ...testStoredExpiryBounds(params.expiresAt ?? '2099-01-01T00:00:00Z')
    })
  );
}

function storedSession(
  storage: MemoryStorageManager,
  key = testStorageKeys.session
): Record<string, any> | null {
  return JSON.parse(storage.get(key) ?? 'null');
}

describe('WalletClient session storage', () => {
  it('falls back to memory storage when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);

    const client = new OMSWallet({
      publishableKey: 'pk_dev_sdbx_project_key',
      credentialSigner: new MockSigner()
    });

    expect(client.wallet.activeWallet?.address).toBeUndefined();
  });

  it('ends a stored session whose signing key is gone as expired, keeping its record', async () => {
    const storage = new MemoryStorageManager();
    seedStoredSession(storage);

    // The session ended on its own elsewhere: its key is gone while its record stays. The restore
    // read finds that without a request.
    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      credentialSigner: new MockSigner(false)
    });
    const onSessionChange = vi.fn();
    wallet.onSessionChange(onSessionChange);

    await vi.waitFor(() => expect(sessionChangeReasons(onSessionChange)).toEqual(['expired']));
    expect(wallet.activeWallet).toBeUndefined();
    expect(storage.get(testStorageKeys.session)).not.toBeNull();
  });

  it('retains expired wallet metadata, notifies session expiry listeners, and throws a session expiry error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => waasErrorResponse('KeyExpired'))
    );
    const storage = new MemoryStorageManager();
    const signer = new MockSigner();
    const onSessionChange = vi.fn();
    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      credentialSigner: signer
    });
    (wallet as any).persistSession(
      testWalletAccount('wallet-id', '0x1111111111111111111111111111111111111111'),
      {
        expiresAt: '2000-01-01T00:00:00Z',
        auth: emailAuth(),
        signerCredentialId: '0x04' + '11'.repeat(64),
        signerKeyType: 'ecdsa-p256-sha256'
      }
    );
    wallet.onSessionChange(onSessionChange);

    await expect(
      wallet.signMessage({ network: Networks.polygon, message: 'hello' })
    ).rejects.toMatchObject({
      code: 'OMS_SESSION_EXPIRED',
      operation: 'wallet.signMessage',
      message: 'Wallet session expired'
    });
    expect(wallet.session).toBeUndefined();
    expect(storedSession(storage)).toMatchObject({
      version: 2,
      wallet: { id: 'wallet-id', address: '0x1111111111111111111111111111111111111111' },
      expiresAt: '2000-01-01T00:00:00Z',
      auth: emailAuth()
    });
    expect(signer.clear).toHaveBeenCalledOnce();
    expect(onSessionChange).toHaveBeenLastCalledWith({
      reason: 'expired',
      activeWallet: undefined,
      session: undefined,
      expiredSession: {
        wallet: testWalletAccount('wallet-id', '0x1111111111111111111111111111111111111111'),
        session: {
          expiresAt: '2000-01-01T00:00:00Z',
          auth: emailAuth()
        },
        expiredAt: '2000-01-01T00:00:00Z'
      }
    });

    const lateListener = vi.fn();
    wallet.onSessionChange(lateListener);
    await vi.waitFor(() => expect(lateListener).toHaveBeenCalled());
    expect(lateListener).toHaveBeenLastCalledWith({
      reason: 'expired',
      activeWallet: undefined,
      session: undefined,
      expiredSession: {
        wallet: testWalletAccount('wallet-id', '0x1111111111111111111111111111111111111111'),
        session: {
          expiresAt: '2000-01-01T00:00:00Z',
          auth: emailAuth()
        },
        expiredAt: '2000-01-01T00:00:00Z'
      }
    });
  });

  it('notifies session expiry listeners when signer cleanup fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => waasErrorResponse('KeyExpired'))
    );
    const storage = new MemoryStorageManager();
    const signer = new MockSigner();
    signer.clear.mockRejectedValueOnce(new Error('clear failed'));
    const onSessionChange = vi.fn();
    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      credentialSigner: signer
    });
    (wallet as any).persistSession(
      testWalletAccount('wallet-id', '0x1111111111111111111111111111111111111111'),
      {
        expiresAt: '2000-01-01T00:00:00Z',
        auth: emailAuth(),
        signerCredentialId: '0x04' + '11'.repeat(64),
        signerKeyType: 'ecdsa-p256-sha256'
      }
    );
    wallet.onSessionChange(onSessionChange);

    await expect(
      wallet.signMessage({ network: Networks.polygon, message: 'hello' })
    ).rejects.toMatchObject({
      code: 'OMS_SESSION_EXPIRED',
      operation: 'wallet.signMessage'
    });
    expect(wallet.session).toBeUndefined();
    expect(signer.clear).toHaveBeenCalledOnce();
    expect(onSessionChange).toHaveBeenLastCalledWith({
      reason: 'expired',
      activeWallet: undefined,
      session: undefined,
      expiredSession: {
        wallet: testWalletAccount('wallet-id', '0x1111111111111111111111111111111111111111'),
        session: {
          expiresAt: '2000-01-01T00:00:00Z',
          auth: emailAuth()
        },
        expiredAt: '2000-01-01T00:00:00Z'
      }
    });
  });

  it('does not restore expired sessions from storage and notifies after construction without clearing stored metadata', async () => {
    const storage = new MemoryStorageManager();
    const signer = new MockSigner();
    const onSessionChange = vi.fn();
    seedStoredSession(storage, { expiresAt: '2000-01-01T00:00:00Z', scope: omsSessionScope });

    const client = new OMSWallet({
      publishableKey: 'pk_dev_sdbx_project_key',
      storage,
      credentialSigner: signer
    });
    client.wallet.onSessionChange(onSessionChange);

    expect(client.wallet.session).toBeUndefined();
    expect(storedSession(storage, omsStorageKeys.session)).toMatchObject({
      version: 2,
      wallet: { id: 'wallet-id' },
      expiresAt: '2000-01-01T00:00:00Z',
      auth: emailAuth()
    });

    await vi.waitFor(() => expect(onSessionChange).toHaveBeenCalled());
    expect(signer.clear).toHaveBeenCalledOnce();
    expect(onSessionChange).toHaveBeenLastCalledWith({
      reason: 'expired',
      activeWallet: undefined,
      session: undefined,
      expiredSession: {
        wallet: testWalletAccount('wallet-id', '0x1111111111111111111111111111111111111111'),
        session: {
          expiresAt: '2000-01-01T00:00:00Z',
          auth: emailAuth()
        },
        expiredAt: '2000-01-01T00:00:00Z'
      }
    });

    const nextOnSessionChange = vi.fn();
    const nextClient = new OMSWallet({
      publishableKey: 'pk_dev_sdbx_project_key',
      storage,
      credentialSigner: signer
    });
    nextClient.wallet.onSessionChange(nextOnSessionChange);

    expect(nextClient.wallet.activeWallet?.address).toBeUndefined();
    await vi.waitFor(() => expect(nextOnSessionChange).toHaveBeenCalled());
    expect(nextOnSessionChange).toHaveBeenLastCalledWith({
      reason: 'expired',
      activeWallet: undefined,
      session: undefined,
      expiredSession: {
        wallet: testWalletAccount('wallet-id', '0x1111111111111111111111111111111111111111'),
        session: {
          expiresAt: '2000-01-01T00:00:00Z',
          auth: emailAuth()
        },
        expiredAt: '2000-01-01T00:00:00Z'
      }
    });
  });

  it('stops replaying an expiry found at load once signed out', async () => {
    const storage = new MemoryStorageManager();
    seedStoredSession(storage, { expiresAt: '2000-01-01T00:00:00Z', scope: omsSessionScope });
    const client = new OMSWallet({
      publishableKey: 'pk_dev_sdbx_project_key',
      storage,
      credentialSigner: new MockSigner()
    });

    await client.wallet.signOut();
    const onSessionChange = vi.fn();
    client.wallet.onSessionChange(onSessionChange);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it('notifies and clears an active session when its expiry time is reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => waasErrorResponse('KeyExpired'))
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const storage = new MemoryStorageManager();
    const signer = new MockSigner();
    const onSessionChange = vi.fn();
    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      credentialSigner: signer
    });
    (wallet as any).persistSession(
      testWalletAccount('wallet-id', '0x1111111111111111111111111111111111111111'),
      {
        expiresAt: '2026-01-01T00:02:00Z',
        auth: emailAuth(),
        signerCredentialId: '0x04' + '11'.repeat(64),
        signerKeyType: 'ecdsa-p256-sha256',
        expiryBounds: testExpiryBounds('2026-01-01T00:02:00Z')
      }
    );
    wallet.onSessionChange(onSessionChange);

    // Without activity, WaaS is asked 5 minutes (the grace period) after the local expiry.
    await vi.advanceTimersByTimeAsync(119_999 + 5 * 60_000);
    expect(sessionChangeReasons(onSessionChange)).toEqual([]);
    expect(wallet.activeWallet?.address).toBe('0x1111111111111111111111111111111111111111');

    await vi.advanceTimersByTimeAsync(1);

    expect(wallet.session).toBeUndefined();
    expect(storedSession(storage)).toMatchObject({
      wallet: { id: 'wallet-id', address: '0x1111111111111111111111111111111111111111' },
      expiresAt: '2026-01-01T00:02:00Z',
      auth: emailAuth()
    });
    expect(signer.clear).toHaveBeenCalledOnce();
    expect(onSessionChange).toHaveBeenLastCalledWith({
      reason: 'expired',
      activeWallet: undefined,
      session: undefined,
      expiredSession: {
        wallet: testWalletAccount('wallet-id', '0x1111111111111111111111111111111111111111'),
        session: {
          expiresAt: '2026-01-01T00:02:00Z',
          auth: emailAuth()
        },
        expiredAt: '2026-01-01T00:02:00Z'
      }
    });
  });

  it('reports a sign-out once and cancels the session expiry timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const signer = new MockSigner();
    const onSessionChange = vi.fn();
    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage: new MemoryStorageManager(),
      credentialSigner: signer
    });
    (wallet as any).persistSession(
      testWalletAccount('wallet-id', '0x1111111111111111111111111111111111111111'),
      {
        expiresAt: '2026-01-01T00:02:00Z',
        auth: emailAuth(),
        signerCredentialId: '0x04' + '11'.repeat(64),
        signerKeyType: 'ecdsa-p256-sha256',
        expiryBounds: testExpiryBounds('2026-01-01T00:02:00Z')
      }
    );
    wallet.onSessionChange(onSessionChange);

    await wallet.signOut();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(wallet.activeWallet?.address).toBeUndefined();
    expect((wallet as any).storage.get(testStorageKeys.session)).toBeNull();
    expect(signer.clear).toHaveBeenCalledOnce();
    expect(sessionChangeReasons(onSessionChange)).toEqual(['signedOut']);
  });

  it('does not let an old expiry timer clear a replacement session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => waasErrorResponse('KeyExpired'))
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const signer = new MockSigner();
    const onSessionChange = vi.fn();
    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage: new MemoryStorageManager(),
      credentialSigner: signer
    });
    (wallet as any).persistSession(
      testWalletAccount('wallet-old', '0x1111111111111111111111111111111111111111'),
      {
        expiresAt: '2026-01-01T00:02:00Z',
        auth: emailAuth('old@example.com'),
        signerCredentialId: '0x04' + '11'.repeat(64),
        signerKeyType: 'ecdsa-p256-sha256',
        expiryBounds: testExpiryBounds('2026-01-01T00:02:00Z')
      }
    );
    (wallet as any).persistSession(
      testWalletAccount('wallet-new', '0x2222222222222222222222222222222222222222'),
      {
        expiresAt: '2026-01-01T00:04:00Z',
        auth: googleAuth('new@example.com'),
        signerCredentialId: '0x04' + '11'.repeat(64),
        signerKeyType: 'ecdsa-p256-sha256',
        expiryBounds: testExpiryBounds('2026-01-01T00:04:00Z')
      }
    );
    wallet.onSessionChange(onSessionChange);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(wallet.activeWallet?.address).toBe('0x2222222222222222222222222222222222222222');
    expect(wallet.session).toEqual({
      expiresAt: '2026-01-01T00:04:00Z',
      auth: googleAuth('new@example.com')
    });
    expect(sessionChangeReasons(onSessionChange)).toEqual([]);

    await vi.advanceTimersByTimeAsync(120_000 + 5 * 60_000);

    expect(wallet.activeWallet?.address).toBeUndefined();
    expect(signer.clear).toHaveBeenCalledOnce();
    expect(onSessionChange).toHaveBeenLastCalledWith({
      reason: 'expired',
      activeWallet: undefined,
      session: undefined,
      expiredSession: {
        wallet: testWalletAccount('wallet-new', '0x2222222222222222222222222222222222222222'),
        session: {
          expiresAt: '2026-01-01T00:04:00Z',
          auth: googleAuth('new@example.com')
        },
        expiredAt: '2026-01-01T00:04:00Z'
      }
    });
  });

  it('notifies and clears pending manual wallet selection when its expiry time is reached', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const signer = new MockSigner();
    const onSessionChange = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/CompleteAuth')) {
        return jsonResponse({
          identity: { type: 'email', sub: 'user-1' },
          email: 'user@example.com',
          wallets: [
            testWallet('wallet-1', WalletType.Ethereum, '11'),
            testWallet('wallet-2', WalletType.Ethereum, '22')
          ],
          credential: {
            ...testCredential(),
            expiresAt: '2026-01-01T00:02:00Z'
          }
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(RequestUtils, 'hashEmailAuthAnswer').mockResolvedValue('answer');

    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage: new MemoryStorageManager(),
      credentialSigner: signer
    });
    wallet.onSessionChange(onSessionChange);
    seedEmailAuthAttempt(wallet);

    const selection = await wallet.completeEmailAuth({
      code: '123456',
      walletSelection: 'manual'
    });

    expect('selectWallet' in selection).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(wallet.session).toBeUndefined();
    expect(signer.clear).toHaveBeenCalledOnce();
    expect(onSessionChange).toHaveBeenLastCalledWith({
      reason: 'expired',
      activeWallet: undefined,
      session: undefined,
      expiredSession: {
        wallet: undefined,
        session: {
          expiresAt: '2026-01-01T00:02:00Z',
          auth: emailAuth()
        },
        expiredAt: '2026-01-01T00:02:00Z'
      }
    });
    await expect(selection.selectWallet({ walletId: 'wallet-1' })).rejects.toMatchObject({
      code: 'OMS_WALLET_SELECTION_STALE'
    });
  });

  it('clears in-memory wallet state and signer state on sign-out', async () => {
    const signer = new MockSigner();
    const storage = new MemoryStorageManager();
    const redirectAuthStorage = new MemoryStorageManager();
    redirectAuthStorage.set(
      testStorageKeys.redirectAuth,
      JSON.stringify({ verifier: 'old-verifier' })
    );
    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      redirectAuthStorage,
      credentialSigner: signer
    });

    (wallet as any).persistSession(
      testWalletAccount('wallet-id', '0x1111111111111111111111111111111111111111'),
      {
        expiresAt: '2099-01-01T00:00:00Z',
        auth: emailAuth(),
        signerCredentialId: '0x04' + '11'.repeat(64),
        signerKeyType: 'ecdsa-p256-sha256'
      }
    );
    seedEmailAuthAttempt(wallet, 'old-verifier', 'old-challenge');
    await wallet.signOut();

    expect(wallet.activeWallet?.address).toBeUndefined();
    await expect(wallet.completeEmailAuth({ code: '123456' })).rejects.toMatchObject({
      code: 'OMS_SESSION_MISSING',
      operation: 'wallet.completeEmailAuth',
      message: 'No pending email auth attempt'
    });
    expect(wallet.session).toBeUndefined();
    expect(storage.get(testStorageKeys.session)).toBeNull();
    expect(redirectAuthStorage.get(testStorageKeys.redirectAuth)).toBeNull();
    expect(signer.clear).toHaveBeenCalledOnce();
  });

  it('clears an existing session before starting email auth', async () => {
    const signer = new MockSigner();
    const storage = new MemoryStorageManager();
    const redirectAuthStorage = new MemoryStorageManager();
    seedStoredSession(storage, { auth: emailAuth('old@example.com') });
    redirectAuthStorage.set(
      testStorageKeys.redirectAuth,
      JSON.stringify({ verifier: 'old-verifier' })
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith('/CommitVerifier')) {
        return jsonResponse({
          verifier: 'verifier-1',
          challenge: 'challenge-1'
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      redirectAuthStorage,
      credentialSigner: signer
    });

    await wallet.startEmailAuth({ email: 'new@example.com' });

    expect(wallet.activeWallet?.address).toBeUndefined();
    expect(storage.get(testStorageKeys.session)).toBeNull();
    expect(redirectAuthStorage.get(testStorageKeys.redirectAuth)).toBeNull();
    expect(signer.clear).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: 'an Ethereum wallet with OIDC auth',
      wallet: testWalletAccount('wallet-id', '0x1111111111111111111111111111111111111111'),
      auth: googleAuth()
    },
    {
      label: 'an imported Tron wallet with email auth',
      wallet: {
        id: 'wallet-tron',
        type: 'tron',
        address: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL',
        reference: 'primary',
        keyOrigin: 'imported'
      },
      auth: emailAuth()
    }
  ])('restores the full active wallet and session for $label from storage', ({ wallet, auth }) => {
    const storage = new MemoryStorageManager();
    seedStoredSession(storage, { auth, scope: omsSessionScope });
    const record = JSON.parse(storage.get(omsStorageKeys.session)!);
    storage.set(omsStorageKeys.session, JSON.stringify({ ...record, wallet }));

    const client = new OMSWallet({
      publishableKey: 'pk_dev_sdbx_project_key',
      storage,
      credentialSigner: new MockSigner()
    });

    expect(client.wallet.activeWallet).toEqual(wallet);
    expect(client.wallet.session).toEqual({ expiresAt: '2099-01-01T00:00:00Z', auth });
  });

  it('discards version 1 session records saved by SDK 0.3.x', () => {
    const storage = new MemoryStorageManager();
    storage.set(
      omsStorageKeys.session,
      JSON.stringify({
        version: 1,
        scope: omsSessionScope,
        walletId: 'wallet-id',
        walletAddress: '0x1111111111111111111111111111111111111111',
        expiresAt: '2099-01-01T00:00:00Z',
        auth: emailAuth(),
        signerCredentialId: '0x04' + '11'.repeat(64),
        signerKeyType: 'ecdsa-p256-sha256'
      })
    );

    const client = new OMSWallet({
      publishableKey: 'pk_dev_sdbx_project_key',
      storage,
      credentialSigner: new MockSigner()
    });

    expect(client.wallet.activeWallet).toBeUndefined();
    expect(client.wallet.session).toBeUndefined();
    expect(storage.get(omsStorageKeys.session)).toBeFalsy();
  });

  it('discards stored sessions whose wallet record is malformed or has no completed auth', () => {
    for (const override of [
      { wallet: { id: 'wallet-id', type: 'bitcoin', address: 'bc1', keyOrigin: 'enclave' } },
      { wallet: { id: 'wallet-id', type: 'ethereum', address: 'not-hex', keyOrigin: 'enclave' } },
      { wallet: { id: 'wallet-id', type: 'tron', address: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL' } },
      { auth: undefined }
    ]) {
      const storage = new MemoryStorageManager();
      seedStoredSession(storage, { scope: omsSessionScope });
      const record = JSON.parse(storage.get(omsStorageKeys.session)!);
      storage.set(omsStorageKeys.session, JSON.stringify({ ...record, ...override }));

      const client = new OMSWallet({
        publishableKey: 'pk_dev_sdbx_project_key',
        storage,
        credentialSigner: new MockSigner()
      });

      expect(client.wallet.activeWallet).toBeUndefined();
      expect(client.wallet.session).toBeUndefined();
      expect(storage.get(omsStorageKeys.session)).toBeFalsy();
    }
  });

  it.each([
    { field: 'projectId', scope: { ...omsSessionScope, projectId: 'prj_other' } },
    {
      field: 'walletApiUrl',
      scope: { ...omsSessionScope, walletApiUrl: 'https://wallet.other.example' }
    },
    {
      field: 'indexerGatewayUrl',
      scope: { ...omsSessionScope, indexerGatewayUrl: 'https://indexer.other.example/' }
    }
  ])("discards a record under this project's key that names a different $field", ({ scope }) => {
    const storage = new MemoryStorageManager();
    seedStoredSession(storage, { scope, key: omsStorageKeys.session });

    const client = new OMSWallet({
      publishableKey: 'pk_dev_sdbx_project_key',
      storage,
      credentialSigner: new MockSigner()
    });

    expect(client.wallet.activeWallet).toBeUndefined();
    expect(client.wallet.session).toBeUndefined();
    expect(storage.get(omsStorageKeys.session)).toBeFalsy();
  });

  it('keeps the sessions of other projects and environments on the same storage apart', () => {
    // Two projects, or one project in two environments, used on one origin.
    const storage = new MemoryStorageManager();
    const otherProject = { ...omsSessionScope, projectId: 'prj_other' };
    const otherEnvironment = {
      projectId: 'prj_project',
      walletApiUrl: 'https://sandbox-api.polygon.technology',
      indexerGatewayUrl: 'https://sandbox-api.polygon.technology/v1/IndexerGateway/'
    };
    seedStoredSession(storage, { scope: otherProject, walletId: 'wallet-other-project' });
    seedStoredSession(storage, { scope: otherEnvironment, walletId: 'wallet-other-environment' });
    seedStoredSession(storage, { scope: omsSessionScope });
    const keysOf = (scope: typeof omsSessionScope) =>
      sessionStorageKeys(scope.projectId, scope.walletApiUrl).session;
    const otherProjectRecord = storage.get(keysOf(otherProject));
    const otherEnvironmentRecord = storage.get(keysOf(otherEnvironment));

    const client = new OMSWallet({
      publishableKey: 'pk_dev_sdbx_project_key',
      storage,
      credentialSigner: new MockSigner()
    });

    expect(client.wallet.activeWallet?.id).toBe('wallet-id');
    expect(storage.get(keysOf(otherProject))).toBe(otherProjectRecord);
    expect(storage.get(keysOf(otherEnvironment))).toBe(otherEnvironmentRecord);
    expect(keysOf(otherProject)).toBe(
      'omsWallet_session:prj_other@https://sandbox-api.dev.polygon-dev.technology'
    );
    expect(keysOf(otherEnvironment)).toBe(
      'omsWallet_session:prj_project@https://sandbox-api.polygon.technology'
    );
  });

  it('returns the same frozen active wallet and session until they change', () => {
    const storage = new MemoryStorageManager();
    seedStoredSession(storage, { scope: omsSessionScope });
    const client = new OMSWallet({
      publishableKey: 'pk_dev_sdbx_project_key',
      storage,
      credentialSigner: new MockSigner()
    });
    const wallet = client.wallet;
    const activeWallet = wallet.activeWallet;
    const session = wallet.session;

    expect(wallet.activeWallet).toBe(activeWallet);
    expect(wallet.session).toBe(session);
    expect(Object.isFrozen(activeWallet)).toBe(true);
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session?.auth)).toBe(true);
    expect(() => {
      (activeWallet as any).address = '0x9999999999999999999999999999999999999999';
    }).toThrow(TypeError);

    (wallet as any).persistSession(
      testWalletAccount('wallet-id', '0x1111111111111111111111111111111111111111'),
      {
        expiresAt: '2099-02-01T00:00:00Z',
        auth: emailAuth(),
        signerCredentialId: '0x04' + '11'.repeat(64),
        signerKeyType: 'ecdsa-p256-sha256'
      }
    );

    // Only the expiry changed: the wallet keeps its object, the session gets a new one.
    expect(wallet.activeWallet).toBe(activeWallet);
    expect(wallet.session).not.toBe(session);
    expect(wallet.session?.expiresAt).toBe('2099-02-01T00:00:00Z');
  });

  it('rejects a restored session when the configured signer does not match', async () => {
    const storage = new MemoryStorageManager();
    seedStoredSession(storage, {
      signerCredentialId: '0x04' + '33'.repeat(64)
    });
    const signer = new MockSigner();
    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      credentialSigner: signer
    });

    await expect(
      wallet.signMessage({ network: Networks.polygon, message: 'hello' })
    ).rejects.toMatchObject({
      code: 'OMS_SESSION_MISSING',
      operation: 'wallet.signMessage'
    });
    expect(wallet.activeWallet?.address).toBeUndefined();
    expect(storage.get(testStorageKeys.session)).toBeNull();
    expect(signer.clear).toHaveBeenCalledOnce();
  });

  it('stores the local signer identity after email auth and restores a usable session', async () => {
    const storage = new MemoryStorageManager();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);

      if (url.endsWith('/CompleteAuth')) {
        expect(body).toMatchObject({
          identityType: 'email',
          authMode: 'otp',
          verifier: 'verifier-1',
          lifetime: 604_800
        });
        expect(body.answer).toEqual(expect.any(String));
        return jsonResponse({
          identity: { type: 'email', sub: 'user-1' },
          wallets: [
            {
              id: 'wallet-id',
              networkFamily: 'evm',
              keyOrigin: 'enclave',
              address: '0x1111111111111111111111111111111111111111'
            }
          ],
          credential: testCredential()
        });
      }

      if (url.endsWith('/UseWallet')) {
        return jsonResponse({
          wallet: {
            id: 'wallet-id',
            networkFamily: 'evm',
            keyOrigin: 'enclave',
            address: '0x1111111111111111111111111111111111111111'
          }
        });
      }

      if (url.endsWith('/SignMessage')) {
        expect(body).toEqual({
          network: Networks.amoy.id.toString(),
          walletId: 'wallet-id',
          message: 'test'
        });
        return jsonResponse({ signature: '0xsigned' });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      credentialSigner: new MockSigner()
    });
    seedEmailAuthAttempt(wallet);

    const result = await wallet.completeEmailAuth({ code: '123456' });

    expect(result).toMatchObject({
      wallet: {
        id: 'wallet-id',
        type: WalletType.Ethereum,
        address: '0x1111111111111111111111111111111111111111'
      },
      wallets: [
        {
          id: 'wallet-id',
          type: WalletType.Ethereum,
          address: '0x1111111111111111111111111111111111111111'
        }
      ],
      credential: testCredential()
    });
    expect(wallet.activeWallet?.address).toBe('0x1111111111111111111111111111111111111111');
    expect(wallet.session).toEqual({
      expiresAt: '2099-01-01T00:00:00Z',
      auth: emailAuth()
    });
    expect(storedSession(storage)).toMatchObject({
      expiresAt: '2099-01-01T00:00:00Z',
      auth: emailAuth(),
      signerCredentialId: '0x04' + '11'.repeat(64),
      signerKeyType: 'ecdsa-p256-sha256'
    });

    await expect(wallet.signMessage({ network: Networks.amoy, message: 'test' })).resolves.toBe(
      '0xsigned'
    );

    const restoredWallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      credentialSigner: new MockSigner()
    });

    await expect(
      restoredWallet.signMessage({ network: Networks.amoy, message: 'test' })
    ).resolves.toBe('0xsigned');
  });

  it('uses a requested email auth session lifetime', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);

      if (url.endsWith('/CommitVerifier')) {
        return jsonResponse({ verifier: 'verifier-1', challenge: 'challenge-1' });
      }

      if (url.endsWith('/CompleteAuth')) {
        expect(body.lifetime).toBe(120);
        return jsonResponse({
          identity: { type: 'email', sub: 'user-1' },
          email: 'user@example.com',
          wallets: [testWallet('wallet-id', WalletType.Ethereum, '11')],
          credential: testCredential()
        });
      }

      if (url.endsWith('/UseWallet')) {
        return jsonResponse({ wallet: testWallet('wallet-id', WalletType.Ethereum, '11') });
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

    await wallet.startEmailAuth({ email: 'user@example.com', sessionLifetimeSeconds: 120 });
    await wallet.completeEmailAuth({ code: '123456' });

    expect(requestCount(fetchMock, '/CommitVerifier')).toBe(1);
    expect(requestCount(fetchMock, '/CompleteAuth')).toBe(1);
  });

  it('deduplicates concurrent email auth completion for the same auth attempt', async () => {
    const completeAuth = deferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/CompleteAuth')) {
        return completeAuth.promise;
      }

      if (url.endsWith('/UseWallet')) {
        return jsonResponse({ wallet: testWallet('wallet-id', WalletType.Ethereum, '11') });
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
    vi.spyOn(RequestUtils, 'hashEmailAuthAnswer').mockResolvedValue('answer');

    const first = wallet.completeEmailAuth({ code: '123456' });
    const second = wallet.completeEmailAuth({ code: '123456' });
    await waitForRequest(fetchMock, '/CompleteAuth');

    expect(requestCount(fetchMock, '/CompleteAuth')).toBe(1);
    completeAuth.resolve(
      jsonResponse({
        identity: { type: 'email', sub: 'user-1' },
        email: 'user@example.com',
        wallets: [testWallet('wallet-id', WalletType.Ethereum, '11')],
        credential: testCredential()
      })
    );

    await expect(first).resolves.toMatchObject({
      wallet: { id: 'wallet-id' }
    });
    await expect(second).resolves.toMatchObject({
      wallet: { id: 'wallet-id' }
    });
    expect(requestCount(fetchMock, '/UseWallet')).toBe(1);
  });

  it('does not persist stale automatic email auth after a newer email auth starts', async () => {
    const completeAuth = deferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;

      if (url.endsWith('/CompleteAuth')) {
        if (body?.verifier === 'verifier-2') {
          return jsonResponse({
            identity: { type: 'email', sub: 'user-2' },
            email: 'new@example.com',
            wallets: [testWallet('wallet-new', WalletType.Ethereum, '22')],
            credential: testCredential()
          });
        }
        return completeAuth.promise;
      }

      if (url.endsWith('/CommitVerifier')) {
        return jsonResponse({
          verifier: 'verifier-2',
          challenge: 'challenge-2'
        });
      }

      if (url.endsWith('/UseWallet')) {
        if (body?.walletId === 'wallet-new') {
          return jsonResponse({ wallet: testWallet('wallet-new', WalletType.Ethereum, '22') });
        }
        throw new Error('UseWallet should not be called for stale auth');
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    // A new auth flow replaces the signing key, as the default WebCrypto signer does, so the new
    // flow's requests do not wait for the old credential's request in flight.
    const signer = new MockSigner();
    signer.clear = vi.fn(async () => signer.setCredential('0x04' + '22'.repeat(64)));

    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage: new MemoryStorageManager(),
      credentialSigner: signer
    });
    seedEmailAuthAttempt(wallet);
    vi.spyOn(RequestUtils, 'hashEmailAuthAnswer').mockResolvedValue('old-answer');

    const staleCompletion = wallet.completeEmailAuth({ code: '111111' });
    await waitForRequest(fetchMock, '/CompleteAuth');
    await wallet.startEmailAuth({ email: 'new@example.com' });
    completeAuth.resolve(
      jsonResponse({
        identity: { type: 'email', sub: 'user-1' },
        email: 'old@example.com',
        wallets: [testWallet('wallet-old', WalletType.Ethereum, '44')],
        credential: testCredential()
      })
    );

    await expect(staleCompletion).rejects.toMatchObject({
      code: 'OMS_SESSION_MISSING',
      operation: 'wallet.completeEmailAuth',
      message: 'Email auth attempt is no longer active'
    });
    expect(wallet.activeWallet?.address).toBeUndefined();
    expect(requestCount(fetchMock, '/UseWallet')).toBe(0);
    await expect(wallet.completeEmailAuth({ code: '222222' })).resolves.toMatchObject({
      wallet: { id: 'wallet-new' }
    });
    expect(wallet.activeWallet?.address).toBe('0x2222222222222222222222222222222222222222');
    expect(requestCount(fetchMock, '/UseWallet')).toBe(1);
  });

  it('allows email auth completion retry after a failed completion request', async () => {
    let completeAuthCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/CompleteAuth')) {
        completeAuthCalls += 1;
        if (completeAuthCalls === 1) {
          throw new Error('temporary CompleteAuth failure');
        }

        return jsonResponse({
          identity: { type: 'email', sub: 'user-1' },
          email: 'user@example.com',
          wallets: [testWallet('wallet-id', WalletType.Ethereum, '11')],
          credential: testCredential()
        });
      }

      if (url.endsWith('/UseWallet')) {
        return jsonResponse({ wallet: testWallet('wallet-id', WalletType.Ethereum, '11') });
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
    vi.spyOn(RequestUtils, 'hashEmailAuthAnswer').mockResolvedValue('answer');

    await expect(wallet.completeEmailAuth({ code: '123456' })).rejects.toMatchObject({
      operation: 'wallet.completeEmailAuth'
    });
    await expect(wallet.completeEmailAuth({ code: '123456' })).resolves.toMatchObject({
      wallet: { id: 'wallet-id' }
    });
    expect(requestCount(fetchMock, '/CompleteAuth')).toBe(2);
  });

  it('loads an additional auth wallet page before creating a wallet', async () => {
    const requestedType = WalletType.Solana;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);

      if (url.endsWith('/CompleteAuth')) {
        return jsonResponse({
          identity: { type: 'email', sub: 'user-1' },
          wallets: [testWallet('wallet-1', WalletType.Ethereum, '11')],
          page: { cursor: 'cursor-2' },
          credential: testCredential()
        });
      }

      if (url.endsWith('/ListWallets')) {
        expect(body).toEqual({ page: { cursor: 'cursor-2' } });
        return jsonResponse({
          wallets: [testWallet('wallet-2', requestedType, '22')],
          page: {}
        });
      }

      if (url.endsWith('/UseWallet')) {
        expect(body).toEqual({ walletId: 'wallet-2' });
        return jsonResponse({ wallet: testWallet('wallet-2', requestedType, '22') });
      }

      if (url.endsWith('/CreateWallet')) {
        throw new Error('CreateWallet should not be called');
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

    const result = await wallet.completeEmailAuth({ code: '123456', walletType: requestedType });

    expect(result.wallet.address).toBe(testWalletAddress(requestedType, '22'));
    expect(result.wallets).toEqual([
      expectedWallet('wallet-1', WalletType.Ethereum, '11'),
      expectedWallet('wallet-2', requestedType, '22')
    ]);
  });

  it('returns a pending wallet selection with filtered wallets when wallet selection is manual', async () => {
    const otherType = WalletType.Solana;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);

      if (url.endsWith('/CompleteAuth')) {
        return jsonResponse({
          identity: { type: 'email', sub: 'user-1' },
          email: 'user@example.com',
          wallets: [
            testWallet('wallet-1', WalletType.Ethereum, '11'),
            testWallet('wallet-other', otherType, '33')
          ],
          page: { cursor: 'cursor-2' },
          credential: testCredential()
        });
      }

      if (url.endsWith('/ListWallets')) {
        expect(body).toEqual({ page: { cursor: 'cursor-2' } });
        return jsonResponse({
          wallets: [testWallet('wallet-2', WalletType.Ethereum, '22')],
          page: {}
        });
      }

      if (url.endsWith('/UseWallet')) {
        expect(body).toEqual({ walletId: 'wallet-2' });
        return jsonResponse({ wallet: testWallet('wallet-2', WalletType.Ethereum, '22') });
      }

      if (url.endsWith('/CreateWallet')) {
        throw new Error('CreateWallet should not be called');
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const storage = new MemoryStorageManager();
    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      credentialSigner: new MockSigner()
    });
    seedEmailAuthAttempt(wallet);

    const result = await wallet.completeEmailAuth({ code: '123456', walletSelection: 'manual' });

    expect(result).toMatchObject({
      walletType: WalletType.Ethereum,
      wallets: [
        expectedWallet('wallet-1', WalletType.Ethereum, '11'),
        expectedWallet('wallet-2', WalletType.Ethereum, '22')
      ],
      credential: testCredential()
    });
    expect(result.selectWallet).toEqual(expect.any(Function));
    expect(result.createAndSelectWallet).toEqual(expect.any(Function));
    expect(wallet.activeWallet?.address).toBeUndefined();

    (result.wallets as Array<any>).push(expectedWallet('wallet-forged', WalletType.Ethereum, '44'));
    (result.wallets[0] as any).id = 'wallet-forged';
    (result.credential as any).credentialId = '0x' + 'ff'.repeat(32);

    await expect(result.selectWallet({ walletId: 'wallet-forged' })).rejects.toMatchObject({
      code: 'OMS_WALLET_SELECTION_UNAVAILABLE',
      operation: 'wallet.pendingWalletSelection.selectWallet'
    });

    await expect(result.selectWallet({ walletId: 'wallet-other' })).rejects.toMatchObject({
      code: 'OMS_WALLET_SELECTION_UNAVAILABLE',
      operation: 'wallet.pendingWalletSelection.selectWallet'
    });
    expect(requestCount(fetchMock, '/UseWallet')).toBe(0);

    const activated = await result.selectWallet({ walletId: 'wallet-2' });

    expect(activated.wallet.address).toBe('0x2222222222222222222222222222222222222222');
    expect(wallet.activeWallet?.address).toBe('0x2222222222222222222222222222222222222222');
    expect(wallet.session).toEqual({
      expiresAt: '2099-01-01T00:00:00Z',
      auth: emailAuth()
    });
    expect(storedSession(storage)?.auth).toEqual(emailAuth());
  });

  it('pending create uses the requested wallet type', async () => {
    const requestedType = WalletType.Solana;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);

      if (url.endsWith('/CompleteAuth')) {
        return jsonResponse({
          identity: { type: 'email', sub: 'user-1' },
          email: 'user@example.com',
          wallets: [],
          credential: testCredential()
        });
      }

      if (url.endsWith('/CreateWallet')) {
        expect(body).toEqual({
          networkFamily: 'solana',
          reference: 'fresh'
        });
        return jsonResponse({ wallet: testWallet('wallet-new', requestedType, '33', 'fresh') });
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

    const selection = await wallet.completeEmailAuth({
      code: '123456',
      walletType: requestedType,
      walletSelection: 'manual'
    });

    const result = await selection.createAndSelectWallet({ reference: 'fresh' });

    expect(result).toEqual({
      wallet: expectedWallet('wallet-new', requestedType, '33', 'fresh')
    });
    expect(wallet.activeWallet?.address).toBe(testWalletAddress(requestedType, '33'));
  });

  it.each([
    { secondSelection: 'manual' as const, activeAddress: undefined },
    {
      secondSelection: 'automatic' as const,
      activeAddress: '0x2222222222222222222222222222222222222222'
    }
  ])(
    'stale pending wallet selections fail before network after newer $secondSelection auth',
    async ({ secondSelection, activeAddress }) => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const body = JSON.parse(init?.body as string);

        if (url.endsWith('/CompleteAuth')) {
          return jsonResponse({
            identity: { type: 'email', sub: 'user-1' },
            email: body.answer === 'first' ? 'first@example.com' : 'second@example.com',
            wallets: [
              testWallet(
                body.answer === 'first' ? 'wallet-first' : 'wallet-second',
                WalletType.Ethereum,
                body.answer === 'first' ? '11' : '22'
              )
            ],
            credential: testCredential()
          });
        }

        if (url.endsWith('/UseWallet')) {
          return jsonResponse({ wallet: testWallet('wallet-second', WalletType.Ethereum, '22') });
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
      vi.spyOn(RequestUtils, 'hashEmailAuthAnswer')
        .mockResolvedValueOnce('first')
        .mockResolvedValueOnce('second');

      const staleSelection = await wallet.completeEmailAuth({
        code: '111111',
        walletSelection: 'manual'
      });
      seedEmailAuthAttempt(wallet, 'verifier-2', 'challenge-2');
      await wallet.completeEmailAuth({ code: '222222', walletSelection: secondSelection });
      const requestCountBeforeStaleSelection = fetchMock.mock.calls.length;

      await expect(staleSelection.selectWallet({ walletId: 'wallet-first' })).rejects.toMatchObject(
        {
          code: 'OMS_WALLET_SELECTION_STALE'
        }
      );
      await expect(
        staleSelection.createAndSelectWallet({ reference: 'stale' })
      ).rejects.toMatchObject({
        code: 'OMS_WALLET_SELECTION_STALE'
      });
      expect(fetchMock.mock.calls.length).toBe(requestCountBeforeStaleSelection);
      expect(wallet.activeWallet?.address).toBe(activeAddress);
    }
  );

  it('reused pending wallet selections fail before network after success', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/CompleteAuth')) {
        return jsonResponse({
          identity: { type: 'email', sub: 'user-1' },
          email: 'user@example.com',
          wallets: [testWallet('wallet-1', WalletType.Ethereum, '11')],
          credential: testCredential()
        });
      }

      if (url.endsWith('/UseWallet')) {
        return jsonResponse({ wallet: testWallet('wallet-1', WalletType.Ethereum, '11') });
      }

      if (url.endsWith('/CreateWallet')) {
        throw new Error('CreateWallet should not be called');
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

    const selection = await wallet.completeEmailAuth({ code: '123456', walletSelection: 'manual' });
    await selection.selectWallet({ walletId: 'wallet-1' });
    const requestCountAfterSelection = fetchMock.mock.calls.length;

    await expect(selection.createAndSelectWallet({ reference: 'again' })).rejects.toMatchObject({
      code: 'OMS_WALLET_SELECTION_STALE'
    });
    expect(fetchMock.mock.calls.length).toBe(requestCountAfterSelection);
  });

  it('concurrent pending create calls send only one create wallet request', async () => {
    let resolveCreate!: (response: Response) => void;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);

      if (url.endsWith('/CompleteAuth')) {
        return jsonResponse({
          identity: { type: 'email', sub: 'user-1' },
          email: 'user@example.com',
          wallets: [],
          credential: testCredential()
        });
      }

      if (url.endsWith('/CreateWallet')) {
        expect(body).toEqual({ networkFamily: 'evm', reference: 'fresh' });
        return new Promise<Response>((resolve) => {
          resolveCreate = resolve;
        });
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
    const selection = await wallet.completeEmailAuth({ code: '123456', walletSelection: 'manual' });

    const firstCreate = selection.createAndSelectWallet({ reference: 'fresh' });
    const secondCreate = selection.createAndSelectWallet({ reference: 'fresh' });

    await expect(secondCreate).rejects.toMatchObject({
      code: 'OMS_WALLET_SELECTION_IN_FLIGHT'
    });
    await waitForRequest(fetchMock, '/CreateWallet');
    expect(requestCount(fetchMock, '/CreateWallet')).toBe(1);

    resolveCreate(
      jsonResponse({ wallet: testWallet('wallet-new', WalletType.Ethereum, '33', 'fresh') })
    );
    await expect(firstCreate).resolves.toMatchObject({
      wallet: { id: 'wallet-new' }
    });
    expect(requestCount(fetchMock, '/CreateWallet')).toBe(1);
  });

  it('serializes imports with every pending wallet selection action', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/CompleteAuth')) {
        return jsonResponse({
          identity: { type: 'email', sub: 'user-1' },
          email: 'user@example.com',
          wallets: [testWallet('wallet-1', WalletType.Ethereum, '11')],
          credential: testCredential()
        });
      }

      if (url.endsWith('/UseWallet') || url.endsWith('/CreateWallet')) {
        throw new Error('A second pending selection action must not reach WaaS');
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage: new MemoryStorageManager(),
      credentialSigner: new MockSigner(),
      walletImportTrustedPcr0s: ['1'.repeat(96)]
    });
    seedEmailAuthAttempt(wallet);
    const selection = await wallet.completeEmailAuth({ code: '123456', walletSelection: 'manual' });
    const importedWallet = deferred<ReturnType<typeof testWallet>>();
    const requestImportWallet = vi
      .spyOn(wallet as any, 'requestImportWallet')
      .mockReturnValue(importedWallet.promise);
    const importParams = {
      walletType: WalletType.Ethereum,
      keyMaterial: {
        keyId: 'key-1',
        cipherSuite: 'p256-sha256-aes256gcm' as const,
        encapsulatedKey: 'AQID',
        ciphertext: 'BAUG'
      }
    };

    const firstImport = wallet.importEncryptedWallet(importParams);
    await vi.waitFor(() => expect(requestImportWallet).toHaveBeenCalledOnce());

    await expect(wallet.importEncryptedWallet(importParams)).rejects.toMatchObject({
      code: 'OMS_WALLET_SELECTION_IN_FLIGHT',
      operation: 'wallet.importEncryptedWallet'
    });
    await expect(selection.selectWallet({ walletId: 'wallet-1' })).rejects.toMatchObject({
      code: 'OMS_WALLET_SELECTION_IN_FLIGHT',
      operation: 'wallet.pendingWalletSelection.selectWallet'
    });
    await expect(selection.createAndSelectWallet()).rejects.toMatchObject({
      code: 'OMS_WALLET_SELECTION_IN_FLIGHT',
      operation: 'wallet.pendingWalletSelection.createAndSelectWallet'
    });
    expect(requestImportWallet).toHaveBeenCalledOnce();
    expect(requestCount(fetchMock, '/UseWallet')).toBe(0);
    expect(requestCount(fetchMock, '/CreateWallet')).toBe(0);

    importedWallet.resolve(testWallet('wallet-imported', WalletType.Ethereum, '33'));
    await expect(firstImport).resolves.toMatchObject({ wallet: { id: 'wallet-imported' } });
  });

  it('failed pending create can be retried when the selection was not consumed', async () => {
    let createAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/CompleteAuth')) {
        return jsonResponse({
          identity: { type: 'email', sub: 'user-1' },
          email: 'user@example.com',
          wallets: [],
          credential: testCredential()
        });
      }

      if (url.endsWith('/CreateWallet')) {
        createAttempts += 1;
        if (createAttempts === 1) {
          throw new Error('network failed');
        }
        return jsonResponse({
          wallet: testWallet('wallet-new', WalletType.Ethereum, '33', 'fresh')
        });
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
    const selection = await wallet.completeEmailAuth({ code: '123456', walletSelection: 'manual' });

    await expect(selection.createAndSelectWallet({ reference: 'fresh' })).rejects.toMatchObject({
      code: 'OMS_REQUEST_FAILED'
    });

    await expect(selection.createAndSelectWallet({ reference: 'fresh' })).resolves.toMatchObject({
      wallet: { id: 'wallet-new' }
    });
    expect(requestCount(fetchMock, '/CreateWallet')).toBe(2);
  });

  it('pending create invalidated while in flight does not persist the stale result', async () => {
    let resolveCreate!: (response: Response) => void;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);

      if (url.endsWith('/CompleteAuth')) {
        return jsonResponse({
          identity: { type: 'email', sub: 'user-1' },
          email: body.answer === 'first' ? 'first@example.com' : 'second@example.com',
          wallets:
            body.answer === 'first' ? [] : [testWallet('wallet-second', WalletType.Ethereum, '22')],
          credential: testCredential()
        });
      }

      if (url.endsWith('/CreateWallet')) {
        return new Promise<Response>((resolve) => {
          resolveCreate = resolve;
        });
      }

      if (url.endsWith('/UseWallet')) {
        return jsonResponse({ wallet: testWallet('wallet-second', WalletType.Ethereum, '22') });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const signer = new MockSigner();

    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage: new MemoryStorageManager(),
      credentialSigner: signer
    });
    seedEmailAuthAttempt(wallet);
    vi.spyOn(RequestUtils, 'hashEmailAuthAnswer')
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second');
    const selection = await wallet.completeEmailAuth({ code: '111111', walletSelection: 'manual' });

    const staleCreate = selection.createAndSelectWallet({ reference: 'stale' });
    await waitForRequest(fetchMock, '/CreateWallet');
    // A new email auth starts with a new signing key, as `startEmailAuth` makes the default signer
    // create, so its requests do not wait for the old credential's create in flight.
    signer.setCredential('0x04' + '22'.repeat(64));
    seedEmailAuthAttempt(wallet, 'verifier-2', 'challenge-2');
    await wallet.completeEmailAuth({ code: '222222' });
    resolveCreate(
      jsonResponse({ wallet: testWallet('wallet-stale', WalletType.Ethereum, '44', 'stale') })
    );

    await expect(staleCreate).rejects.toMatchObject({
      code: 'OMS_WALLET_SELECTION_STALE'
    });
    expect(wallet.activeWallet?.address).toBe('0x2222222222222222222222222222222222222222');
  });

  it('public wallet activation methods reject while manual selection is pending', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/CompleteAuth')) {
        return jsonResponse({
          identity: { type: 'email', sub: 'user-1' },
          email: 'user@example.com',
          wallets: [testWallet('wallet-1', WalletType.Ethereum, '11')],
          credential: testCredential()
        });
      }

      if (url.endsWith('/ListWallets')) {
        return jsonResponse({
          wallets: [testWallet('wallet-1', WalletType.Ethereum, '11')],
          page: {}
        });
      }

      if (url.endsWith('/UseWallet') || url.endsWith('/CreateWallet')) {
        throw new Error(
          'Public activation methods should not be used while manual wallet selection is pending; complete selection through PendingWalletSelection'
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
    await wallet.completeEmailAuth({ code: '111111', walletSelection: 'manual' });

    await expect(wallet.listWallets()).resolves.toEqual([
      expectedWallet('wallet-1', WalletType.Ethereum, '11')
    ]);
    await expect(wallet.useWallet({ walletId: 'wallet-1' })).rejects.toMatchObject({
      code: 'OMS_SESSION_MISSING',
      operation: 'wallet.useWallet',
      message: 'No active wallet session'
    });
    await expect(
      wallet.createWallet({ walletType: WalletType.Ethereum, reference: 'fresh' })
    ).rejects.toMatchObject({
      code: 'OMS_SESSION_MISSING',
      operation: 'wallet.createWallet',
      message: 'No active wallet session'
    });
    expect(requestCount(fetchMock, '/UseWallet')).toBe(0);
    expect(requestCount(fetchMock, '/CreateWallet')).toBe(0);
  });

  it('active wallet switch invalidated while in flight by sign-out does not persist the stale result', async () => {
    const storage = new MemoryStorageManager();
    let resolveUse!: (response: Response) => void;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);

      if (url.endsWith('/UseWallet')) {
        expect(body).toEqual({ walletId: 'wallet-2' });
        return new Promise<Response>((resolve) => {
          resolveUse = resolve;
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      credentialSigner: new MockSigner()
    });
    (wallet as any).persistSession(
      testWalletAccount('wallet-1', '0x1111111111111111111111111111111111111111'),
      {
        expiresAt: '2099-01-01T00:00:00Z',
        auth: emailAuth(),
        signerCredentialId: '0x04' + '11'.repeat(64),
        signerKeyType: 'ecdsa-p256-sha256'
      }
    );

    const staleUse = wallet.useWallet({ walletId: 'wallet-2' });
    await waitForRequest(fetchMock, '/UseWallet');
    await wallet.signOut();
    resolveUse(jsonResponse({ wallet: testWallet('wallet-2', WalletType.Ethereum, '22') }));

    await expect(staleUse).rejects.toMatchObject({
      code: 'OMS_SESSION_MISSING',
      operation: 'wallet.useWallet',
      message: 'No active wallet session'
    });
    expect(wallet.activeWallet?.address).toBeUndefined();
    expect(storage.get(testStorageKeys.session)).toBeNull();
  });

  it('lists every wallet page from an active session', async () => {
    const requests: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/ListWallets')) {
        const body = JSON.parse(init?.body as string);
        requests.push(body);
        return body.page?.cursor === 'cursor-2'
          ? jsonResponse({ wallets: [testWallet('wallet-2', WalletType.Solana, '22')], page: {} })
          : jsonResponse({
              wallets: [testWallet('wallet-1', WalletType.Ethereum, '11')],
              page: { cursor: 'cursor-2' }
            });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const storage = new MemoryStorageManager();
    seedStoredSession(storage, { walletId: 'wallet-1' });
    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      credentialSigner: new MockSigner()
    });

    await expect(wallet.listWallets()).resolves.toEqual([
      expectedWallet('wallet-1', WalletType.Ethereum, '11'),
      expectedWallet('wallet-2', WalletType.Solana, '22')
    ]);
    expect(requests).toEqual([{}, { page: { cursor: 'cursor-2' } }]);
  });

  it('can switch to an existing wallet from an active session', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);

      if (url.endsWith('/UseWallet')) {
        expect(body).toEqual({ walletId: 'wallet-2' });
        return jsonResponse({ wallet: testWallet('wallet-2', WalletType.Ethereum, '22') });
      }

      if (url.endsWith('/SignMessage')) {
        expect(body).toEqual({
          network: Networks.polygon.id.toString(),
          walletId: 'wallet-2',
          message: 'hello'
        });
        return jsonResponse({ signature: '0xsigned' });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const storage = new MemoryStorageManager();
    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      credentialSigner: new MockSigner()
    });
    (wallet as any).persistSession(
      testWalletAccount('wallet-1', '0x1111111111111111111111111111111111111111'),
      {
        expiresAt: '2099-01-01T00:00:00Z',
        auth: emailAuth(),
        signerCredentialId: '0x04' + '11'.repeat(64),
        signerKeyType: 'ecdsa-p256-sha256'
      }
    );

    const result = await wallet.useWallet({ walletId: 'wallet-2' });

    expect(result).toEqual({
      wallet: expectedWallet('wallet-2', WalletType.Ethereum, '22')
    });
    expect(wallet.activeWallet?.address).toBe('0x2222222222222222222222222222222222222222');
    expect(storedSession(storage)).toMatchObject({
      wallet: { id: 'wallet-2', address: '0x2222222222222222222222222222222222222222' }
    });
    expect(requestCount(fetchMock, '/UseWallet')).toBe(1);

    await expect(wallet.signMessage({ network: Networks.polygon, message: 'hello' })).resolves.toBe(
      '0xsigned'
    );
    expect(requestCount(fetchMock, '/SignMessage')).toBe(1);
  });

  it('can explicitly create and activate a new wallet from an active session', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);

      if (url.endsWith('/CreateWallet')) {
        expect(body).toEqual({
          networkFamily: 'evm',
          reference: 'fresh'
        });
        return jsonResponse({
          wallet: testWallet('wallet-new', WalletType.Ethereum, '33', 'fresh')
        });
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
    (wallet as any).persistSession(
      testWalletAccount('wallet-id', '0x1111111111111111111111111111111111111111'),
      {
        expiresAt: '2099-01-01T00:00:00Z',
        auth: emailAuth(),
        signerCredentialId: '0x04' + '11'.repeat(64),
        signerKeyType: 'ecdsa-p256-sha256'
      }
    );

    const result = await wallet.createWallet({
      walletType: WalletType.Ethereum,
      reference: 'fresh'
    });

    expect(result).toEqual({
      wallet: expectedWallet('wallet-new', WalletType.Ethereum, '33', 'fresh')
    });
    expect(wallet.activeWallet?.address).toBe('0x3333333333333333333333333333333333333333');
  });
});

function testWallet(id: string, type: WalletType, seed: string, reference?: string) {
  return {
    id,
    networkFamily: type === WalletType.Ethereum ? 'evm' : 'solana',
    keyOrigin: 'enclave',
    address: testWalletAddress(type, seed),
    ...(reference ? { reference } : {})
  };
}

function expectedWallet(id: string, type: WalletType, seed: string, reference?: string) {
  return {
    id,
    type,
    address: testWalletAddress(type, seed),
    reference,
    keyOrigin: 'enclave'
  };
}

function testWalletAddress(type: WalletType, seed: string): string {
  if (type === WalletType.Ethereum) {
    return '0x' + seed.repeat(20);
  }

  switch (seed) {
    case '22':
      return '3gFktQX6vki5M2DzN8Y1ESPUJ4fJ8o6hVQWf8vYvPypD';
    case '33':
      return '4Nd1mYQbqjVU2aR7cJNPyqW9XjHnBYvWQd7ZxYxvT6uP';
    default:
      throw new Error(`Missing Solana test address for seed ${seed}`);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitForRequest(
  fetchMock: ReturnType<typeof vi.fn>,
  endpoint: string
): Promise<void> {
  // Microtask turns only, so the wait also works under fake timers; signing a request takes several.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (requestCount(fetchMock, endpoint) > 0) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Expected ${endpoint} request`);
}
