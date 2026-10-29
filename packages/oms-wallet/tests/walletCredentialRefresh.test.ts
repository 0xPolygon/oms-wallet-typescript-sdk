import { afterEach, describe, expect, it, vi } from 'vitest';

import { WalletClientImpl } from '../src/clients/walletClient';
import { Networks } from '../src/networks';
import { MemoryStorageManager } from '../src/storageManager';
import { testWalletAccount } from './fixtures/walletAccount.js';
import {
  MockSigner,
  createWalletWithSession,
  jsonResponse,
  listenToSessionChanges,
  requestCount,
  sessionChangeReasons,
  testCredential,
  testEnvironment,
  testStoredExpiryBounds,
  waasErrorResponse,
  testStorageKeys
} from './fixtures/helpers.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const walletAddress = '0x1111111111111111111111111111111111111111';

function credentialResponse(expiresAt: string): Response {
  return jsonResponse({ credential: { ...testCredential(), expiresAt } });
}

/**
 * Routes each WaaS request by endpoint to `handlers`. An unknown endpoint throws from `fetch`, which
 * the SDK surfaces as a request failure.
 */
function stubWaas(handlers: Record<string, () => Response | Promise<Response>>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const endpoint = '/' + input.toString().split('/').pop();
    const handler = handlers[endpoint];
    if (!handler) throw new Error(`Unexpected request: ${endpoint}`);
    return handler();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function storedExpiresAt(storage: MemoryStorageManager): string | undefined {
  return JSON.parse(storage.get(testStorageKeys.session) ?? 'null')?.expiresAt;
}

function signMessage(wallet: WalletClientImpl) {
  return wallet.signMessage({ network: Networks.polygon, message: 'hello' });
}

describe('WalletClient sliding credential expiry', () => {
  it('extends, persists, and reschedules the expiry when the expiry timer finds it extended', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let getCredential = () => credentialResponse('2026-01-01T00:10:00Z');
    const fetchMock = stubWaas({ '/GetCredential': () => getCredential() });
    const storage = new MemoryStorageManager();
    const wallet = createWalletWithSession(walletAddress, undefined, {
      expiresAt: '2026-01-01T00:02:00Z',
      storage
    });
    const onSessionChange = listenToSessionChanges(wallet);

    // The timer reads at the local expiry (00:02).
    await vi.advanceTimersByTimeAsync(120_000 - 1);
    expect(requestCount(fetchMock, '/GetCredential')).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
    expect(wallet.session?.expiresAt).toBe('2026-01-01T00:10:00Z');
    expect(storedExpiresAt(storage)).toBe('2026-01-01T00:10:00Z');
    expect(sessionChangeReasons(onSessionChange)).toEqual(['expiryUpdated']);

    // The rescheduled timer reads again at the new expiry (00:10).
    getCredential = () => waasErrorResponse('KeyExpired');
    await vi.advanceTimersByTimeAsync(479_999);
    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(requestCount(fetchMock, '/GetCredential')).toBe(2);
    expect(wallet.session).toBeUndefined();
    expect(sessionChangeReasons(onSessionChange)).toEqual(['expiryUpdated', 'expired']);
  });

  it('keeps a refreshed expiry in memory and reschedules when storage fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let getCredential = () => credentialResponse('2026-01-01T00:10:00Z');
    const fetchMock = stubWaas({ '/GetCredential': () => getCredential() });
    const storage = new MemoryStorageManager();
    const wallet = createWalletWithSession(walletAddress, undefined, {
      expiresAt: '2026-01-01T00:02:00Z',
      storage
    });
    vi.spyOn(storage, 'set').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const onSessionChange = listenToSessionChanges(wallet);
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);

    try {
      await vi.advanceTimersByTimeAsync(120_000);

      expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
      expect(wallet.session?.expiresAt).toBe('2026-01-01T00:10:00Z');
      expect(storedExpiresAt(storage)).toBe('2026-01-01T00:02:00Z');
      expect(sessionChangeReasons(onSessionChange)).toEqual(['expiryUpdated']);

      // The timer was rescheduled to the in-memory expiry (00:10).
      getCredential = () => waasErrorResponse('KeyExpired');
      await vi.advanceTimersByTimeAsync(479_999);
      expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(requestCount(fetchMock, '/GetCredential')).toBe(2);
      expect(sessionChangeReasons(onSessionChange)).toEqual(['expiryUpdated', 'expired']);

      await vi.advanceTimersByTimeAsync(0);
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
    }
  });

  it.each(['KeyNotFound', 'KeyExpired'] as const)(
    'ends the session once when an authenticated call fails with %s',
    async (name) => {
      const fetchMock = stubWaas({ '/SignMessage': () => waasErrorResponse(name) });
      const storage = new MemoryStorageManager();
      const wallet = createWalletWithSession(walletAddress, undefined, { storage });
      const onSessionChange = listenToSessionChanges(wallet);

      const results = await Promise.allSettled([signMessage(wallet), signMessage(wallet)]);

      expect(requestCount(fetchMock, '/SignMessage')).toBe(2);
      for (const result of results) {
        expect(result).toMatchObject({
          status: 'rejected',
          reason: {
            name: 'OMSWalletSessionError',
            code: 'OMS_SESSION_EXPIRED',
            operation: 'wallet.signMessage',
            cause: { name, code: name === 'KeyNotFound' ? 7202 : 7203 }
          }
        });
        expect((result as PromiseRejectedResult).reason.upstreamError).toBeUndefined();
      }
      expect(wallet.session).toBeUndefined();
      expect(storedExpiresAt(storage)).toBe('2099-01-01T00:00:00Z');
      expect(sessionChangeReasons(onSessionChange)).toEqual(['expired']);
      expect(onSessionChange).toHaveBeenLastCalledWith({
        reason: 'expired',
        activeWallet: undefined,
        session: undefined,
        expiredSession: {
          wallet: testWalletAccount('wallet-id', walletAddress),
          session: {
            expiresAt: '2099-01-01T00:00:00Z',
            auth: { type: 'email', email: 'user@example.com' }
          },
          expiredAt: '2099-01-01T00:00:00Z'
        }
      });
    }
  );

  it('ends the session when Execute is rejected for the session credential', async () => {
    const prepared = {
      txnId: 'txn-1',
      status: 'quoted',
      feeOptions: [],
      sponsored: true,
      expiresAt: '2099-01-01T00:00:00Z'
    };
    let execute = () => waasErrorResponse('KeyExpired');
    const fetchMock = stubWaas({
      '/PrepareEthereumTransaction': () => jsonResponse(prepared),
      '/Execute': () => execute(),
      '/TransactionStatus': () => waasErrorResponse('KeyExpired')
    });
    const send = (wallet: WalletClientImpl) =>
      wallet.sendTransaction({ network: Networks.polygon, to: walletAddress, value: 0n });
    const wallet = createWalletWithSession(walletAddress);
    const onSessionChange = listenToSessionChanges(wallet);

    // The credential middleware rejects Execute before it runs, so nothing was submitted.
    const executeError = await send(wallet).catch((error: unknown) => error);
    expect((executeError as { upstreamError?: unknown }).upstreamError).toBeUndefined();
    expect(executeError).toMatchObject({
      name: 'OMSWalletSessionError',
      code: 'OMS_SESSION_EXPIRED',
      operation: 'wallet.sendTransaction',
      cause: { name: 'KeyExpired', code: 7203 }
    });
    expect(wallet.session).toBeUndefined();
    expect(sessionChangeReasons(onSessionChange)).toEqual(['expired']);

    // After a submitted transaction, a rejected status lookup keeps the txnId.
    execute = () => jsonResponse({ status: 'pending' });
    const nextWallet = createWalletWithSession(walletAddress);
    await expect(send(nextWallet)).rejects.toMatchObject({
      name: 'OMSWalletTransactionError',
      code: 'OMS_TRANSACTION_STATUS_LOOKUP_FAILED',
      txnId: 'txn-1'
    });
    expect(nextWallet.session).toBeUndefined();
    expect(requestCount(fetchMock, '/TransactionStatus')).toBe(1);
  });

  it.each([
    {
      label: 'inspectRemoteCredential',
      endpoint: '/InspectCredential',
      call: (wallet: WalletClientImpl) =>
        wallet.inspectRemoteCredential({ credentialId: '0x' + '33'.repeat(32) })
    },
    {
      label: 'isValidMessageSignature',
      endpoint: '/IsValidMessageSignature',
      call: (wallet: WalletClientImpl) =>
        wallet.isValidMessageSignature({
          walletAddress,
          network: Networks.polygon,
          message: 'hello',
          signature: '0x' + '22'.repeat(65)
        })
    }
  ])(
    'keeps the session when the public $label request fails with KeyNotFound',
    async ({ label, endpoint, call }) => {
      const fetchMock = stubWaas({ [endpoint]: () => waasErrorResponse('KeyNotFound') });
      const wallet = createWalletWithSession(walletAddress);
      const onSessionChange = listenToSessionChanges(wallet);

      await expect(call(wallet)).rejects.toMatchObject({
        name: 'OMSWalletRequestError',
        code: 'OMS_REQUEST_FAILED',
        operation: `wallet.${label}`,
        upstreamError: { service: 'waas', name: 'KeyNotFound', code: '7202' }
      });

      expect(requestCount(fetchMock, endpoint)).toBe(1);
      expect(wallet.session).toBeDefined();
      expect(sessionChangeReasons(onSessionChange)).toEqual([]);
    }
  );

  it('keeps local expiry on a server without GetCredential and does not ask again within 15 minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchMock = stubWaas({ '/GetCredential': () => waasErrorResponse('WebrpcBadRoute') });
    const wallet = createWalletWithSession(walletAddress, undefined, {
      expiresAt: '2026-01-01T00:02:00Z'
    });
    const onSessionChange = listenToSessionChanges(wallet);

    await vi.advanceTimersByTimeAsync(120_000);

    expect(wallet.session).toBeUndefined();
    expect(sessionChangeReasons(onSessionChange)).toEqual(['expired']);

    (wallet as any).persistSession(testWalletAccount('wallet-id', walletAddress), {
      expiresAt: '2000-01-01T00:00:00Z',
      auth: { type: 'email', email: 'user@example.com' },
      signerCredentialId: '0x04' + '11'.repeat(64),
      signerKeyType: 'ecdsa-p256-sha256'
    });
    await expect(signMessage(wallet)).rejects.toMatchObject({ code: 'OMS_SESSION_EXPIRED' });

    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
  });

  it('asks for GetCredential again once 15 minutes have passed since it was missing', async () => {
    // A routing error during a deploy also answers WebrpcBadRoute, so the answer is not final.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let getCredential = () => waasErrorResponse('WebrpcBadRoute');
    const fetchMock = stubWaas({ '/GetCredential': () => getCredential() });
    const wallet = createWalletWithSession(walletAddress, undefined, {
      expiresAt: '2026-01-01T00:02:00Z'
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(wallet.session).toBeUndefined();

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    getCredential = () => credentialResponse('2026-02-01T00:00:00Z');
    (wallet as any).persistSession(testWalletAccount('wallet-id', walletAddress), {
      expiresAt: '2000-01-01T00:00:00Z',
      auth: { type: 'email', email: 'user@example.com' },
      signerCredentialId: '0x04' + '11'.repeat(64),
      signerKeyType: 'ecdsa-p256-sha256'
    });
    await expect(signMessage(wallet)).rejects.toThrow();

    expect(requestCount(fetchMock, '/GetCredential')).toBe(2);
    expect(wallet.session?.expiresAt).toBe('2026-02-01T00:00:00Z');
  });

  it('keeps the session and checks again later when WaaS is unreachable at expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let getCredential: () => Promise<Response> = async () => {
      throw new TypeError('network down');
    };
    const fetchMock = stubWaas({ '/GetCredential': () => getCredential() });
    const wallet = createWalletWithSession(walletAddress, undefined, {
      expiresAt: '2026-01-01T00:02:00Z'
    });
    const onSessionChange = listenToSessionChanges(wallet);

    await vi.advanceTimersByTimeAsync(120_000);

    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
    expect(wallet.session?.expiresAt).toBe('2026-01-01T00:02:00Z');
    expect(sessionChangeReasons(onSessionChange)).toEqual([]);

    // An operation on the locally expired session surfaces the network error and keeps it.
    await expect(signMessage(wallet)).rejects.toMatchObject({
      code: 'OMS_REQUEST_FAILED',
      operation: 'wallet.signMessage'
    });
    expect(wallet.session).toBeDefined();
    expect(requestCount(fetchMock, '/GetCredential')).toBe(2);

    // The timer's read is retried a minute after it failed, doubling after that.
    getCredential = async () => credentialResponse('2026-02-01T00:00:00Z');
    await vi.advanceTimersByTimeAsync(60_000 - 1);
    expect(requestCount(fetchMock, '/GetCredential')).toBe(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(requestCount(fetchMock, '/GetCredential')).toBe(3);
    expect(wallet.session?.expiresAt).toBe('2026-02-01T00:00:00Z');
    expect(sessionChangeReasons(onSessionChange)).toEqual(['expiryUpdated']);
  });

  it('refreshes a locally expired session once before concurrent operations and continues them', async () => {
    const fetchMock = stubWaas({
      '/GetCredential': () => credentialResponse('2099-06-01T00:00:00Z'),
      '/SignMessage': () => {
        expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
        return jsonResponse({ signature: '0xsigned' });
      }
    });
    const wallet = createWalletWithSession(walletAddress, undefined, {
      expiresAt: '2000-01-01T00:00:00Z'
    });

    await expect(Promise.all([signMessage(wallet), signMessage(wallet)])).resolves.toEqual([
      '0xsigned',
      '0xsigned'
    ]);

    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
    expect(wallet.session?.expiresAt).toBe('2099-06-01T00:00:00Z');
  });

  it('refreshes in the background after session activity once the last read is 6 hours old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchMock = stubWaas({
      '/GetCredential': () => credentialResponse('2026-01-11T06:00:00Z'),
      '/SignMessage': () => jsonResponse({ signature: '0xsigned' })
    });
    const wallet = createWalletWithSession(walletAddress, undefined, {
      expiresAt: '2026-01-08T00:00:00Z'
    });

    vi.setSystemTime(new Date('2026-01-01T05:59:59Z'));
    await signMessage(wallet);
    expect(requestCount(fetchMock, '/GetCredential')).toBe(0);

    vi.setSystemTime(new Date('2026-01-01T06:00:00Z'));
    await signMessage(wallet);
    await vi.waitFor(() => expect(wallet.session?.expiresAt).toBe('2026-01-11T06:00:00Z'));
    await signMessage(wallet);

    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
  });

  it('signs a request issued during a background expiry read only after the read completes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let resolveGetCredential!: (response: Response) => void;
    const fetchMock = stubWaas({
      '/GetCredential': () => new Promise<Response>((resolve) => (resolveGetCredential = resolve)),
      '/SignMessage': () => jsonResponse({ signature: '0xsigned' })
    });
    const signer = new MockSigner();
    const wallet = createWalletWithSession(walletAddress, undefined, { signer });
    vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000);
    await signMessage(wallet);
    await vi.waitFor(() => expect(requestCount(fetchMock, '/GetCredential')).toBe(1));

    const pending = signMessage(wallet);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestCount(fetchMock, '/SignMessage')).toBe(1);
    expect(signer.preimages).toHaveLength(2);

    resolveGetCredential(credentialResponse('2099-06-01T00:00:00Z'));
    await expect(pending).resolves.toBe('0xsigned');
    expect(requestCount(fetchMock, '/SignMessage')).toBe(2);
    expect(signer.preimages).toHaveLength(3);
  });

  it('starts an expiry read only after in-flight signed session requests finish', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const signResponses: Array<(response: Response) => void> = [];
    const fetchMock = stubWaas({
      '/GetCredential': () => credentialResponse('2026-02-01T00:00:00Z'),
      '/SignMessage': () => new Promise<Response>((resolve) => signResponses.push(resolve))
    });
    const wallet = createWalletWithSession(walletAddress, undefined, {
      expiresAt: '2026-01-01T00:02:00Z'
    });

    const first = signMessage(wallet);
    await vi.waitFor(() => expect(requestCount(fetchMock, '/SignMessage')).toBe(1));
    // The session is now locally expired, so the next operation reads the expiry first.
    vi.setSystemTime(new Date('2026-01-01T00:03:00Z'));
    const second = signMessage(wallet);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestCount(fetchMock, '/GetCredential')).toBe(0);

    signResponses[0](jsonResponse({ signature: '0xfirst' }));
    await expect(first).resolves.toBe('0xfirst');
    await vi.waitFor(() => expect(requestCount(fetchMock, '/SignMessage')).toBe(2));
    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
    signResponses[1](jsonResponse({ signature: '0xsecond' }));
    await expect(second).resolves.toBe('0xsecond');
  });

  it('ignores a refresh result that arrives after the session was replaced', async () => {
    let resolveGetCredential!: (response: Response) => void;
    const fetchMock = stubWaas({
      '/GetCredential': () => new Promise<Response>((resolve) => (resolveGetCredential = resolve))
    });
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
        wallet: testWalletAccount('wallet-old', walletAddress),
        expiresAt: '2099-01-01T00:00:00Z',
        auth: { type: 'email', email: 'old@example.com' },
        signerCredentialId: '0x04' + '11'.repeat(64),
        signerKeyType: 'ecdsa-p256-sha256',
        ...testStoredExpiryBounds('2099-01-01T00:00:00Z')
      })
    );
    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      credentialSigner: new MockSigner()
    });
    await vi.waitFor(() => expect(requestCount(fetchMock, '/GetCredential')).toBe(1));

    await wallet.signOut();
    (wallet as any).persistSession(testWalletAccount('wallet-new', walletAddress), {
      expiresAt: '2098-01-01T00:00:00Z',
      auth: { type: 'email', email: 'new@example.com' },
      signerCredentialId: '0x04' + '11'.repeat(64),
      signerKeyType: 'ecdsa-p256-sha256'
    });
    resolveGetCredential(credentialResponse('2099-06-01T00:00:00Z'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(wallet.activeWallet?.id).toBe('wallet-new');
    expect(wallet.session?.expiresAt).toBe('2098-01-01T00:00:00Z');
    expect(storedExpiresAt(storage)).toBe('2098-01-01T00:00:00Z');
  });
});

describe('WalletClient credential revocation', () => {
  it('ends the session when the expiry timer finds the credential revoked', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchMock = stubWaas({ '/GetCredential': () => waasErrorResponse('Unauthorized') });
    const signer = Object.assign(new MockSigner(), { clear: vi.fn(async () => {}) });
    const wallet = createWalletWithSession(walletAddress, undefined, {
      expiresAt: '2026-01-01T00:02:00Z',
      signer
    });
    const onSessionChange = listenToSessionChanges(wallet);

    await vi.advanceTimersByTimeAsync(120_000);

    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
    expect(wallet.session).toBeUndefined();
    expect(signer.clear).toHaveBeenCalledOnce();
    expect(sessionChangeReasons(onSessionChange)).toEqual(['expired']);
    expect(onSessionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expiredSession: expect.objectContaining({ expiredAt: '2026-01-01T00:02:00Z' })
      })
    );
  });

  it('fails an operation with OMS_SESSION_EXPIRED when the expiry refresh finds the credential revoked', async () => {
    const fetchMock = stubWaas({ '/GetCredential': () => waasErrorResponse('Unauthorized') });
    const wallet = createWalletWithSession(walletAddress, undefined, {
      expiresAt: '2000-01-01T00:00:00Z'
    });
    const onSessionChange = listenToSessionChanges(wallet);

    const error = await signMessage(wallet).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      name: 'OMSWalletSessionError',
      code: 'OMS_SESSION_EXPIRED',
      operation: 'wallet.signMessage',
      cause: { name: 'Unauthorized', code: 7207 }
    });
    expect((error as { upstreamError?: unknown }).upstreamError).toBeUndefined();
    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
    expect(requestCount(fetchMock, '/SignMessage')).toBe(0);
    expect(wallet.session).toBeUndefined();
    expect(sessionChangeReasons(onSessionChange)).toEqual(['expired']);
  });

  it('keeps the session when the expiry refresh gets a gateway Unauthorized error', async () => {
    // Fake timers keep the kept session's retry timer from running into later tests.
    vi.useFakeTimers();
    const fetchMock = stubWaas({
      '/GetCredential': () =>
        jsonResponse(
          { code: 1000, name: 'Unauthorized', message: 'Unauthorized', status: 401 },
          401
        )
    });
    const wallet = createWalletWithSession(walletAddress, undefined, {
      expiresAt: '2000-01-01T00:00:00Z'
    });
    const onSessionChange = listenToSessionChanges(wallet);

    await expect(signMessage(wallet)).rejects.toMatchObject({
      name: 'OMSWalletRequestError',
      operation: 'wallet.signMessage',
      upstreamError: { service: 'waas', code: '1000' }
    });

    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
    expect(wallet.session).toBeDefined();
    expect(sessionChangeReasons(onSessionChange)).toEqual([]);
  });

  it('keeps the session when a wallet call fails with Unauthorized and the credential is valid', async () => {
    const fetchMock = stubWaas({
      '/SignMessage': () => waasErrorResponse('Unauthorized'),
      '/GetCredential': () => credentialResponse('2099-06-01T00:00:00Z')
    });
    const wallet = createWalletWithSession(walletAddress);
    const onSessionChange = listenToSessionChanges(wallet);

    await expect(signMessage(wallet)).rejects.toMatchObject({
      name: 'OMSWalletRequestError',
      code: 'OMS_REQUEST_FAILED',
      operation: 'wallet.signMessage',
      status: 401,
      upstreamError: { service: 'waas', name: 'Unauthorized', code: '7207' }
    });

    // The access error is told apart from a revoked credential by one expiry read.
    await vi.waitFor(() => expect(requestCount(fetchMock, '/GetCredential')).toBe(1));
    expect(requestCount(fetchMock, '/SignMessage')).toBe(1);
    expect(wallet.session).toBeDefined();
    expect(sessionChangeReasons(onSessionChange)).toEqual([]);
  });

  it('ends the session when a wallet call fails with Unauthorized and the credential was revoked', async () => {
    const fetchMock = stubWaas({
      '/SignMessage': () => waasErrorResponse('Unauthorized'),
      '/GetCredential': () => waasErrorResponse('Unauthorized')
    });
    const wallet = createWalletWithSession(walletAddress);
    const onSessionChange = listenToSessionChanges(wallet);

    await expect(signMessage(wallet)).rejects.toMatchObject({
      code: 'OMS_REQUEST_FAILED',
      upstreamError: { service: 'waas', name: 'Unauthorized', code: '7207' }
    });

    await vi.waitFor(() => expect(sessionChangeReasons(onSessionChange)).toEqual(['expired']));
    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
    expect(wallet.session).toBeUndefined();
  });
});

describe('WalletClient wallet activation and refreshed expiry', () => {
  const T0 = Date.parse('2026-01-01T00:00:00Z');
  const walletTwoJson = {
    id: 'wallet-2',
    networkFamily: 'evm',
    keyOrigin: 'enclave',
    address: '0x2222222222222222222222222222222222222222'
  };

  /** A session stored as a sign-in would leave it, without a client running its timer. */
  function storedSession(expiresAt: string): MemoryStorageManager {
    const seeded = new MemoryStorageManager();
    const signedIn = createWalletWithSession(walletAddress, undefined, {
      expiresAt,
      storage: seeded
    });
    (signedIn as any).clearSessionExpiryTimer();
    const storage = new MemoryStorageManager();
    storage.set(testStorageKeys.session, seeded.get(testStorageKeys.session) ?? '');
    return storage;
  }

  function restoredClient(storage: MemoryStorageManager): WalletClientImpl {
    return new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      credentialSigner: new MockSigner()
    });
  }

  it('keeps an expiry read during a wallet switch instead of the expiry from before it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    let resolveRead!: (response: Response) => void;
    let resolveUseWallet!: (response: Response) => void;
    const fetchMock = stubWaas({
      '/GetCredential': () => new Promise<Response>((resolve) => (resolveRead = resolve)),
      '/UseWallet': () => new Promise<Response>((resolve) => (resolveUseWallet = resolve))
    });
    const storage = storedSession('2026-01-11T00:00:00Z');
    const wallet = restoredClient(storage);
    await vi.advanceTimersByTimeAsync(0);
    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);

    // The switch starts while the restore read is in flight; its request waits for the read.
    const switched = wallet.useWallet({ walletId: 'wallet-2' });
    await vi.advanceTimersByTimeAsync(0);

    vi.setSystemTime(T0 + 60_000);
    resolveRead(credentialResponse('2026-01-12T00:00:00Z'));
    await vi.advanceTimersByTimeAsync(0);
    expect(wallet.session?.expiresAt).toBe('2026-01-12T00:00:00Z');

    vi.setSystemTime(T0 + 120_000);
    await vi.waitFor(() => expect(requestCount(fetchMock, '/UseWallet')).toBe(1));
    resolveUseWallet(jsonResponse({ wallet: walletTwoJson }));
    await expect(switched).resolves.toMatchObject({ wallet: { id: 'wallet-2' } });

    expect(wallet.session?.expiresAt).toBe('2026-01-12T00:00:00Z');
    expect(storedExpiresAt(storage)).toBe('2026-01-12T00:00:00Z');
    expect((wallet as any).lastCredentialRefreshAt).toBe(T0 + 60_000);
  });

  it("keeps another tab's wallet selection when this tab stores a refreshed expiry", async () => {
    const fetchMock = stubWaas({
      '/GetCredential': () => credentialResponse('2099-06-01T00:00:00Z'),
      '/UseWallet': () => jsonResponse({ wallet: walletTwoJson })
    });
    const storage = storedSession('2099-01-01T00:00:00Z');
    const tabA = restoredClient(storage);
    const tabB = restoredClient(storage);
    await vi.waitFor(() => expect(requestCount(fetchMock, '/GetCredential')).toBe(2));

    await tabA.useWallet({ walletId: 'wallet-2' });
    expect(JSON.parse(storage.get(testStorageKeys.session) ?? 'null').wallet.id).toBe('wallet-2');

    await (tabB as any).refreshSessionCredential();
    const stored = JSON.parse(storage.get(testStorageKeys.session) ?? 'null');
    expect(stored.wallet.id).toBe('wallet-2');
    expect(stored.expiresAt).toBe('2099-06-01T00:00:00Z');
    expect(tabB.activeWallet?.id).toBe('wallet-id');
  });
});

describe('WalletClient expiry timer', () => {
  it('re-arms the expiry timer of a 180-day session at the timer limit without a request', async () => {
    const maxTimerMs = 2_147_483_647;
    const lifetimeMs = 180 * 24 * 60 * 60 * 1000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchMock = stubWaas({ '/GetCredential': () => waasErrorResponse('KeyExpired') });
    const wallet = createWalletWithSession(walletAddress, undefined, {
      expiresAt: new Date(Date.now() + lifetimeMs).toISOString()
    });

    // The timer fires at the setTimeout limit (about 24.8 days), finds the session not due, and
    // re-arms.
    await vi.advanceTimersByTimeAsync(maxTimerMs);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wallet.session).toBeDefined();

    // The re-armed timer ends it at its expiry, which is also its lifetime cap.
    await vi.advanceTimersByTimeAsync(lifetimeMs - maxTimerMs - 1);
    expect(wallet.session).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(wallet.session).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('WalletClient session signer check', () => {
  const otherCredentialId = '0x04' + '33'.repeat(64);

  it('clears the session without a request and notifies when the signer key was replaced before the expiry check', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchMock = stubWaas({
      '/GetCredential': () => credentialResponse('2026-02-01T00:00:00Z')
    });
    const storage = new MemoryStorageManager();
    const signer = new MockSigner();
    const wallet = createWalletWithSession(walletAddress, undefined, {
      expiresAt: '2026-01-01T00:02:00Z',
      storage,
      signer
    });
    const onSessionChange = listenToSessionChanges(wallet);
    const storageSet = vi.spyOn(storage, 'set');

    // Another tab signed in and replaced the shared signer key.
    signer.setCredential(otherCredentialId);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(signer.preimages).toHaveLength(0);
    expect(storageSet).not.toHaveBeenCalled();
    expect(storage.get(testStorageKeys.session)).toBeNull();
    expect(wallet.session).toBeUndefined();
    // No operation reports the end, so listeners (such as the wagmi connector) learn it here.
    expect(sessionChangeReasons(onSessionChange)).toEqual(['expired']);
    expect(onSessionChange).toHaveBeenLastCalledWith({
      reason: 'expired',
      activeWallet: undefined,
      session: undefined,
      expiredSession: {
        wallet: testWalletAccount('wallet-id', walletAddress),
        session: {
          expiresAt: '2026-01-01T00:02:00Z',
          auth: { type: 'email', email: 'user@example.com' }
        },
        expiredAt: '2026-01-01T00:02:00Z'
      }
    });
  });

  it('signs out when the restore read finds the signer key replaced by another sign-in', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchMock = stubWaas({
      '/GetCredential': () => credentialResponse('2026-02-01T00:00:00Z')
    });
    const seeded = new MemoryStorageManager();
    const signedIn = createWalletWithSession(walletAddress, undefined, { storage: seeded });
    (signedIn as any).clearSessionExpiryTimer();
    const storage = new MemoryStorageManager();
    storage.set(testStorageKeys.session, seeded.get(testStorageKeys.session) ?? '');
    const signer = new MockSigner(otherCredentialId);
    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      credentialSigner: signer
    });
    const onSessionChange = listenToSessionChanges(wallet);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(wallet.session).toBeUndefined();
    // Another sign-in made a new key before storing its session, and this one had not expired.
    expect(onSessionChange.mock.calls).toEqual([
      [{ reason: 'signedOut', activeWallet: undefined, session: undefined }]
    ]);
  });

  it('treats a signer that reports no credential as a replaced key', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchMock = stubWaas({
      '/GetCredential': () => credentialResponse('2026-02-01T00:00:00Z')
    });
    const signer = new MockSigner();
    const wallet = createWalletWithSession(walletAddress, undefined, {
      expiresAt: '2026-01-01T00:02:00Z',
      signer
    });
    const onSessionChange = listenToSessionChanges(wallet);

    vi.spyOn(signer, 'credentialId').mockResolvedValue(undefined as unknown as string);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(wallet.session).toBeUndefined();
    expect(sessionChangeReasons(onSessionChange)).toEqual(['expired']);
  });

  it('keeps the stored session and key of a newer sign-in in another tab when the expiry check finds the key replaced', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchMock = stubWaas({
      '/GetCredential': () => credentialResponse('2026-02-01T00:00:00Z')
    });
    const storage = new MemoryStorageManager();
    const signer = Object.assign(new MockSigner(), { clear: vi.fn(async () => {}) });
    const wallet = createWalletWithSession(walletAddress, undefined, {
      expiresAt: '2026-01-01T00:02:00Z',
      storage,
      signer
    });

    // Another tab signed in: it replaced the shared key and stored its own session.
    const newerSession = JSON.stringify({
      ...JSON.parse(storage.get(testStorageKeys.session) ?? '{}'),
      signerCredentialId: otherCredentialId,
      expiresAt: '2026-03-01T00:00:00Z'
    });
    storage.set(testStorageKeys.session, newerSession);
    signer.setCredential(otherCredentialId);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(wallet.session).toBeUndefined();
    expect(storage.get(testStorageKeys.session)).toBe(newerSession);
    expect(signer.clear).not.toHaveBeenCalled();
  });

  it('rejects an operation on a locally expired session without a request when the signer key was replaced', async () => {
    const fetchMock = stubWaas({
      '/GetCredential': () => credentialResponse('2099-06-01T00:00:00Z'),
      '/SignMessage': () => jsonResponse({ signature: '0xsigned' })
    });
    const storage = new MemoryStorageManager();
    const signer = new MockSigner();
    const wallet = createWalletWithSession(walletAddress, undefined, {
      expiresAt: '2000-01-01T00:00:00Z',
      storage,
      signer
    });

    const onSessionChange = listenToSessionChanges(wallet);

    signer.setCredential(otherCredentialId);

    // Its expiry had passed, so the operation and listeners report it expired.
    await expect(signMessage(wallet)).rejects.toMatchObject({
      name: 'OMSWalletSessionError',
      code: 'OMS_SESSION_EXPIRED',
      operation: 'wallet.signMessage'
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.get(testStorageKeys.session)).toBeNull();
    expect(wallet.session).toBeUndefined();
    expect(sessionChangeReasons(onSessionChange)).toEqual(['expired']);
  });
});

describe('WalletClient lifetime cap', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const T0 = Date.parse('2026-01-01T00:00:00Z');
  const sessionCredentialId = '0x04' + '11'.repeat(64);
  const walletJson = {
    id: 'wallet-id',
    networkFamily: 'evm',
    keyOrigin: 'enclave',
    address: walletAddress
  };

  const iso = (ms: number) => new Date(ms).toISOString();

  /** Advances the fake clock to `ms` (epoch), running due timers. */
  async function advanceTo(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms - Date.now());
  }

  /** WaaS handlers for an email sign-in whose `CompleteAuth` reports `expiresAt` (epoch ms). */
  function emailSignInHandlers(expiresAt: number) {
    return {
      '/CommitVerifier': () => jsonResponse({ verifier: 'verifier-1', challenge: 'challenge-1' }),
      '/CompleteAuth': () =>
        jsonResponse({
          identity: { type: 'email', sub: 'user-1' },
          wallets: [walletJson],
          credential: { ...testCredential(), expiresAt: iso(expiresAt) },
          email: 'user@example.com'
        }),
      '/UseWallet': () => jsonResponse({ wallet: walletJson })
    };
  }

  function newClient(storage: MemoryStorageManager): WalletClientImpl {
    return new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      credentialSigner: new MockSigner()
    });
  }

  async function signIn(
    wallet: WalletClientImpl,
    sessionLifetimeSeconds: number,
    walletSelection: 'automatic' | 'manual' = 'automatic'
  ) {
    await wallet.startEmailAuth({ email: 'user@example.com', sessionLifetimeSeconds });
    return wallet.completeEmailAuth({ code: '123456', walletSelection });
  }

  function storedRecord(storage: MemoryStorageManager): Record<string, unknown> | null {
    return JSON.parse(storage.get(testStorageKeys.session) ?? 'null');
  }

  /** Copies the stored session into a new storage, as the next page load would find it. */
  function copyStoredSession(
    from: MemoryStorageManager,
    edit: (record: Record<string, unknown>) => void = () => {}
  ): MemoryStorageManager {
    const record = storedRecord(from);
    if (!record) throw new Error('No stored session');
    edit(record);
    const storage = new MemoryStorageManager();
    storage.set(testStorageKeys.session, JSON.stringify(record));
    return storage;
  }

  it('ends a session at its lifetime cap at its expiry, without a request', async () => {
    // A 70-second lifetime: WaaS reports the cap as the expiry, and nothing can extend it.
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const fetchMock = stubWaas({
      ...emailSignInHandlers(T0 + 70_000),
      '/GetCredential': () => credentialResponse(iso(T0 + 10 * DAY))
    });
    const wallet = newClient(new MemoryStorageManager());
    const onSessionChange = listenToSessionChanges(wallet);
    await signIn(wallet, 70);

    await advanceTo(T0 + 70_000 - 1);
    expect(wallet.session).toBeDefined();
    await advanceTo(T0 + 70_000);

    expect(wallet.session).toBeUndefined();
    expect(sessionChangeReasons(onSessionChange)).toEqual(['signedIn', 'expired']);
    expect(requestCount(fetchMock, '/GetCredential')).toBe(0);
  });

  it('fails a call on a session past its lifetime cap without a request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const fetchMock = stubWaas({
      ...emailSignInHandlers(T0 + 70_000),
      '/GetCredential': () => credentialResponse(iso(T0 + 10 * DAY)),
      '/SignMessage': () => jsonResponse({ signature: '0xsigned' })
    });
    const wallet = newClient(new MemoryStorageManager());
    await signIn(wallet, 70);

    // Past the cap before the expiry timer ran.
    vi.setSystemTime(T0 + 70_000);
    await expect(signMessage(wallet)).rejects.toMatchObject({ code: 'OMS_SESSION_EXPIRED' });

    expect(wallet.session).toBeUndefined();
    expect(requestCount(fetchMock, '/GetCredential')).toBe(0);
    expect(requestCount(fetchMock, '/SignMessage')).toBe(0);
  });

  it('ends a session at its lifetime cap after use moved its expiry there', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const ceiling = T0 + 10 * DAY + 3 * HOUR;
    const fetchMock = stubWaas({
      ...emailSignInHandlers(T0 + 10 * DAY),
      '/GetCredential': () => credentialResponse(iso(ceiling))
    });
    const wallet = newClient(new MemoryStorageManager());
    await signIn(wallet, (10 * DAY + 3 * HOUR) / 1000);
    expect((wallet as any).sessionExpiryBounds).toMatchObject({ expiryCeilingMs: ceiling });

    // Below the cap at the sign-in expiry: the timer reads, and WaaS reports the cap.
    await advanceTo(T0 + 10 * DAY);
    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
    expect(wallet.session?.expiresAt).toBe(iso(ceiling));

    // At the cap it ends without another read.
    await advanceTo(ceiling);
    expect(wallet.session).toBeUndefined();
    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
  });

  it('records the lifetime cap at a manual wallet selection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    stubWaas(emailSignInHandlers(T0 + 10 * DAY));
    const storage = new MemoryStorageManager();
    const wallet = newClient(storage);
    const selection = await signIn(wallet, 180 * 24 * 60 * 60, 'manual');

    await advanceTo(T0 + MINUTE);
    await (selection as any).selectWallet({ walletId: 'wallet-id' });

    expect(storedRecord(storage)).toMatchObject({
      expiryCeiling: iso(T0 + 180 * DAY)
    });
  });

  it.each([
    ['without the bounds', (record: Record<string, unknown>) => record],
    [
      'with invalid bounds',
      (record: Record<string, unknown>) => Object.assign(record, { expiryCeiling: 'not a date' })
    ]
  ])('discards a session stored %s on restore', async (_label, edit) => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const fetchMock = stubWaas({
      '/GetCredential': () => credentialResponse(iso(T0 + 10 * DAY))
    });
    const signInStorage = new MemoryStorageManager();
    const signedIn = createWalletWithSession(walletAddress, undefined, {
      expiresAt: iso(T0 + 10 * DAY),
      storage: signInStorage
    });
    const storage = copyStoredSession(signInStorage, (record) => {
      delete record.expiryCeiling;
      edit(record);
    });
    await signedIn.signOut();

    const wallet = newClient(storage);
    await vi.advanceTimersByTimeAsync(0);

    expect(wallet.session).toBeUndefined();
    expect(storage.get(testStorageKeys.session)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('WalletClient restore read in the foreground', () => {
  /** A stand-in for the browser document: its visibility, prerendering, and their events. */
  class FakeDocument extends EventTarget {
    constructor(
      public visibilityState: 'visible' | 'hidden',
      public prerendering = false
    ) {
      super();
    }
  }

  function restoreSession(): { fetchMock: ReturnType<typeof stubWaas>; wallet: WalletClientImpl } {
    const fetchMock = stubWaas({
      '/GetCredential': () => credentialResponse('2099-06-01T00:00:00Z')
    });
    const seeded = new MemoryStorageManager();
    const signedIn = createWalletWithSession(walletAddress, undefined, { storage: seeded });
    (signedIn as any).clearSessionExpiryTimer();
    const storage = new MemoryStorageManager();
    storage.set(testStorageKeys.session, seeded.get(testStorageKeys.session) ?? '');
    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      credentialSigner: new MockSigner()
    });
    return { fetchMock, wallet };
  }

  /** Lets an expiry read started now complete. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('reads the expiry of a session restored in a hidden page once the page is shown', async () => {
    const doc = new FakeDocument('hidden');
    vi.stubGlobal('document', doc);
    const { fetchMock, wallet } = restoreSession();
    await settle();
    expect(wallet.session).toBeDefined();
    expect(requestCount(fetchMock, '/GetCredential')).toBe(0);

    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
    expect(wallet.session?.expiresAt).toBe('2099-06-01T00:00:00Z');

    // Only once.
    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
  });

  it('reads the expiry of a session restored in a prerendered page once it is activated', async () => {
    const doc = new FakeDocument('visible', true);
    vi.stubGlobal('document', doc);
    const { fetchMock } = restoreSession();
    await settle();
    expect(requestCount(fetchMock, '/GetCredential')).toBe(0);

    doc.prerendering = false;
    doc.dispatchEvent(new Event('prerenderingchange'));
    await settle();
    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
  });

  it('stops waiting for the page to be shown once the restored session ends', async () => {
    const doc = new FakeDocument('hidden');
    const removeListener = vi.spyOn(doc, 'removeEventListener');
    vi.stubGlobal('document', doc);
    const { fetchMock, wallet } = restoreSession();
    await settle();

    await wallet.signOut();
    expect(removeListener.mock.calls.map(([type]) => type).sort()).toEqual([
      'prerenderingchange',
      'visibilitychange'
    ]);

    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(requestCount(fetchMock, '/GetCredential')).toBe(0);
  });

  it('reads the expiry of a restored session right away without a document', async () => {
    expect((globalThis as { document?: unknown }).document).toBeUndefined();
    const { fetchMock } = restoreSession();
    await settle();
    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
  });

  describe('of a session whose saved expiry has passed', () => {
    const HOUR = 60 * 60 * 1000;
    const signedInAt = Date.parse('2026-01-01T00:00:00Z');
    const savedExpiry = '2026-01-11T00:00:00.000Z';

    /** Saves a session signed in at `signedInAt` expiring 10 days later. */
    function saveSession(): MemoryStorageManager {
      vi.setSystemTime(signedInAt);
      const storage = new MemoryStorageManager();
      const signedIn = createWalletWithSession(walletAddress, undefined, {
        storage,
        expiresAt: savedExpiry
      });
      (signedIn as any).clearSessionExpiryTimer();
      return storage;
    }

    /** Loads the saved session at `now`. */
    function load(storage: MemoryStorageManager, now: number, signer = new MockSigner()) {
      vi.setSystemTime(now);
      const wallet = new WalletClientImpl({
        publishableKey: 'publishable-key',
        projectId: 'project-id',
        environment: testEnvironment(),
        storage,
        credentialSigner: signer
      });
      const onSessionChange = listenToSessionChanges(wallet);
      return { wallet, onSessionChange };
    }

    function restoreAt(now: number, getCredential: () => Response | Promise<Response>) {
      vi.useFakeTimers({ toFake: ['Date'] });
      const storage = saveSession();
      const fetchMock = stubWaas({ '/GetCredential': getCredential });
      return { fetchMock, storage, ...load(storage, now) };
    }

    it('keeps it when the read finds it extended on the server', async () => {
      // Requests after the last read extended the server expiry the saved one does not show.
      const { fetchMock, wallet, onSessionChange } = restoreAt(
        Date.parse(savedExpiry) + 4 * HOUR,
        () => credentialResponse('2026-01-21T04:00:00Z')
      );
      expect(wallet.session).toBeDefined();
      await settle();

      expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
      expect(wallet.session?.expiresAt).toBe('2026-01-21T04:00:00Z');
      expect(sessionChangeReasons(onSessionChange)).toEqual(['expiryUpdated']);
    });

    it('ends it when the read finds it ended on the server', async () => {
      const { fetchMock, wallet, onSessionChange } = restoreAt(
        Date.parse(savedExpiry) + 4 * HOUR,
        () => waasErrorResponse('KeyExpired')
      );
      await settle();

      expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
      expect(wallet.session).toBeUndefined();
      expect(sessionChangeReasons(onSessionChange)).toEqual(['expired']);
    });

    it('retries a read that could not reach the wallet API while the page is shown', async () => {
      vi.useFakeTimers();
      const storage = saveSession();
      let reads = 0;
      const fetchMock = stubWaas({
        '/GetCredential': () =>
          ++reads <= 2
            ? Promise.reject(new TypeError('fetch failed'))
            : waasErrorResponse('KeyExpired')
      });
      const { wallet, onSessionChange } = load(storage, Date.parse(savedExpiry) + 4 * HOUR);
      await vi.advanceTimersByTimeAsync(0);
      expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
      expect(wallet.session).toBeDefined();

      // Retries back off from 1 minute, doubling.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requestCount(fetchMock, '/GetCredential')).toBe(2);
      await vi.advanceTimersByTimeAsync(120_000 - 1);
      expect(requestCount(fetchMock, '/GetCredential')).toBe(2);
      await vi.advanceTimersByTimeAsync(1);

      expect(requestCount(fetchMock, '/GetCredential')).toBe(3);
      expect(wallet.session).toBeUndefined();
      expect(sessionChangeReasons(onSessionChange)).toEqual(['expired']);
    });

    it('stops retrying the read once a wallet call reads the expiry', async () => {
      vi.useFakeTimers();
      const storage = saveSession();
      let reads = 0;
      const fetchMock = stubWaas({
        '/GetCredential': () =>
          ++reads === 1
            ? Promise.reject(new TypeError('fetch failed'))
            : credentialResponse('2026-01-21T04:00:00Z'),
        '/SignMessage': () => jsonResponse({ signature: '0xsigned' })
      });
      const { wallet } = load(storage, Date.parse(savedExpiry) + 4 * HOUR);
      await vi.advanceTimersByTimeAsync(0);

      // The call reads the locally expired session's expiry before signing.
      await signMessage(wallet);
      expect(requestCount(fetchMock, '/GetCredential')).toBe(2);
      expect(wallet.session?.expiresAt).toBe('2026-01-21T04:00:00Z');

      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(requestCount(fetchMock, '/GetCredential')).toBe(2);
    });

    it('holds a retry while the page is hidden and reads once it is shown', async () => {
      vi.useFakeTimers();
      const doc = Object.assign(new EventTarget(), {
        visibilityState: 'visible',
        prerendering: false
      });
      vi.stubGlobal('document', doc);
      const storage = saveSession();
      let reads = 0;
      const fetchMock = stubWaas({
        '/GetCredential': () =>
          ++reads === 1
            ? Promise.reject(new TypeError('fetch failed'))
            : credentialResponse('2026-01-21T04:00:00Z')
      });
      const { wallet } = load(storage, Date.parse(savedExpiry) + 4 * HOUR);
      await vi.advanceTimersByTimeAsync(0);
      expect(requestCount(fetchMock, '/GetCredential')).toBe(1);

      doc.visibilityState = 'hidden';
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(requestCount(fetchMock, '/GetCredential')).toBe(1);

      doc.visibilityState = 'visible';
      doc.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(requestCount(fetchMock, '/GetCredential')).toBe(2);
      expect(wallet.session?.expiresAt).toBe('2026-01-21T04:00:00Z');
    });

    it('ends it at once when the wallet API has no GetCredential', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const storage = saveSession();
      // The answer takes a second, so the expiry timer runs first.
      stubWaas({
        '/GetCredential': () =>
          new Promise<Response>((resolve) =>
            setTimeout(() => resolve(waasErrorResponse('WebrpcBadRoute')), 1000)
          )
      });
      const { wallet, onSessionChange } = load(storage, Date.parse(savedExpiry) + 4 * HOUR);
      await vi.advanceTimersByTimeAsync(0);
      expect(wallet.session).toBeDefined();
      await vi.advanceTimersByTimeAsync(1000);
      // Reading the response body takes real event-loop turns; then the timer runs.
      for (let turn = 0; turn < 20 && wallet.session; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(1);
      }

      expect(wallet.session).toBeUndefined();
      expect(sessionChangeReasons(onSessionChange)).toEqual(['expired']);
    });

    it('ends it without a read once its lifetime cap has passed', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const storage = saveSession();
      const record = JSON.parse(storage.get(testStorageKeys.session) ?? '{}');
      record.expiryCeiling = new Date(Date.parse(savedExpiry) + HOUR).toISOString();
      storage.set(testStorageKeys.session, JSON.stringify(record));
      const fetchMock = stubWaas({
        '/GetCredential': () => credentialResponse('2026-01-21T04:00:00Z')
      });
      const { wallet } = load(storage, Date.parse(savedExpiry) + HOUR);
      await settle();

      expect(wallet.session).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps replaying the expiry on later loads after a read ended it', async () => {
      const { storage, onSessionChange } = restoreAt(Date.parse(savedExpiry) + 4 * HOUR, () =>
        waasErrorResponse('KeyExpired')
      );
      await settle();
      expect(sessionChangeReasons(onSessionChange)).toEqual(['expired']);

      // The expiry cleared the signing key and kept the record as the sign-in hint.
      for (const hours of [5, 6]) {
        const next = load(
          storage,
          Date.parse(savedExpiry) + hours * HOUR,
          new MockSigner(undefined, false)
        );
        await settle();
        expect(next.wallet.session).toBeUndefined();
        expect(sessionChangeReasons(next.onSessionChange)).toEqual(['expired']);
        expect(storage.get(testStorageKeys.session)).toBeTruthy();
      }
    });

    it('restores it however long ago its saved expiry passed, and its read decides', async () => {
      // Within its 180-day lifetime cap, only WaaS knows whether it is still active.
      const { fetchMock, wallet, onSessionChange } = restoreAt(
        Date.parse(savedExpiry) + 30 * 24 * HOUR,
        () => waasErrorResponse('KeyExpired')
      );
      expect(wallet.session).toBeDefined();
      await settle();

      expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
      expect(wallet.session).toBeUndefined();
      expect(sessionChangeReasons(onSessionChange)).toEqual(['expired']);
    });
  });
});

describe('WalletClient request deadline', () => {
  /** A signer whose signing the test can hold up or fail. */
  class ControlledSigner extends MockSigner {
    signing: 'normal' | 'hang' | 'fail' = 'normal';
    private finish?: () => void;

    async sign(preimage: string): Promise<string> {
      if (this.signing === 'fail') throw new Error('Signer unavailable');
      if (this.signing === 'hang') await new Promise<void>((resolve) => (this.finish = resolve));
      return super.sign(preimage);
    }

    finishSigning(): void {
      this.finish?.();
    }
  }

  /**
   * Routes WaaS requests like `stubWaas`; a handler returning `undefined` leaves the request
   * unanswered until it is aborted, as `fetch` does.
   */
  function stubWaasWithSignal(handlers: Record<string, () => Response | undefined>) {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = '/' + input.toString().split('/').pop();
      const handler = handlers[endpoint];
      if (!handler) return Promise.reject(new Error(`Unexpected request: ${endpoint}`));
      const response = handler();
      if (response) return Promise.resolve(response);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const sponsoredPrepareResponse = () =>
    jsonResponse({
      txnId: 'txn-1',
      status: 'quoted',
      feeOptions: [],
      sponsored: true,
      expiresAt: '2099-01-01T00:00:00Z'
    });

  function sendTransaction(wallet: WalletClientImpl) {
    return wallet
      .sendTransaction({ network: Networks.polygon, to: walletAddress, value: 0n })
      .catch((caught: unknown) => caught);
  }

  it('fails a request WaaS does not answer within 30 seconds and lets later requests run', async () => {
    vi.useFakeTimers();
    let answer = false;
    stubWaasWithSignal({
      '/SignMessage': () => (answer ? jsonResponse({ signature: '0xsigned' }) : undefined),
      '/GetCredential': () => credentialResponse('2099-01-01T00:00:00Z')
    });
    const wallet = createWalletWithSession(walletAddress);

    const unanswered = signMessage(wallet).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await unanswered).toMatchObject({
      code: 'OMS_REQUEST_FAILED',
      operation: 'wallet.signMessage'
    });
    expect((wallet as any).signedSessionRequestsInFlight).toBe(0);
    answer = true;
    await expect(signMessage(wallet)).resolves.toBe('0xsigned');
  });

  it('fails a request whose response body WaaS does not finish within 30 seconds', async () => {
    // The headers can arrive in time and the body stall.
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
          }
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      })
    );
    const wallet = createWalletWithSession(walletAddress);

    const pending = signMessage(wallet).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await pending).toMatchObject({
      code: 'OMS_REQUEST_FAILED',
      operation: 'wallet.signMessage'
    });
  });

  it('sends nothing when signing finishes after the deadline, and does not hold up expiry reads', async () => {
    vi.useFakeTimers();
    const fetchMock = stubWaasWithSignal({
      '/SignMessage': () => jsonResponse({ signature: '0xsigned' })
    });
    const signer = new ControlledSigner();
    const wallet = createWalletWithSession(walletAddress, undefined, { signer });
    signer.signing = 'hang';

    const pending = signMessage(wallet).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await pending).toMatchObject({ code: 'OMS_REQUEST_FAILED' });
    // The request can no longer reach WaaS, so expiry reads need not wait for the signer.
    expect((wallet as any).signedSessionRequestsInFlight).toBe(0);
    signer.finishSigning();
    await vi.advanceTimersByTimeAsync(0);
    expect(requestCount(fetchMock, '/SignMessage')).toBe(0);
  });

  it.each(['hang', 'fail'] as const)(
    'reports an Execute whose signing does not complete (%s) as a request failure',
    async (signing) => {
      vi.useFakeTimers();
      const signer = new ControlledSigner();
      const fetchMock = stubWaasWithSignal({
        '/PrepareEthereumTransaction': () => {
          signer.signing = signing;
          return sponsoredPrepareResponse();
        },
        '/Execute': () => jsonResponse({ status: 'pending' })
      });
      const wallet = createWalletWithSession(walletAddress, undefined, { signer });

      const result = sendTransaction(wallet);
      await vi.advanceTimersByTimeAsync(30_000);
      const caught = await result;

      // Nothing was sent, so the outcome is known.
      expect(caught).toMatchObject({ code: 'OMS_REQUEST_FAILED', operation: 'wallet.execute' });
      expect((caught as { txnId?: string }).txnId).toBeUndefined();
      expect(requestCount(fetchMock, '/Execute')).toBe(0);
    }
  );

  it('keeps an Execute that timed out after it was sent unconfirmed', async () => {
    vi.useFakeTimers();
    stubWaasWithSignal({
      '/PrepareEthereumTransaction': () => sponsoredPrepareResponse(),
      '/Execute': () => undefined
    });
    const wallet = createWalletWithSession(walletAddress);

    const result = sendTransaction(wallet);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await result).toMatchObject({
      code: 'OMS_TRANSACTION_EXECUTION_UNCONFIRMED',
      txnId: 'txn-1'
    });
  });
});
