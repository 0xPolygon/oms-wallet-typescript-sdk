import { afterEach, describe, expect, it, vi } from 'vitest';

import { WalletClientImpl } from '../src/clients/walletClient';
import { Networks } from '../src/networks';
import { MemoryStorageManager } from '../src/storageManager';
import { Constants } from '../src/utils/constants';
import { testWalletAccount } from './fixtures/walletAccount.js';
import {
  MockSigner,
  createWalletWithSession,
  jsonResponse,
  requestCount,
  testCredential,
  testEnvironment,
  waasErrorResponse
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

/** Routes each WaaS request by endpoint to `handlers`; unknown endpoints fail the test. */
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
  return JSON.parse(storage.get(Constants.sessionStorageKey) ?? 'null')?.expiresAt;
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
    const onSessionExpired = vi.fn();
    wallet.onSessionExpired(onSessionExpired);

    await vi.advanceTimersByTimeAsync(120_000);

    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
    expect(wallet.session?.expiresAt).toBe('2026-01-01T00:10:00Z');
    expect(storedExpiresAt(storage)).toBe('2026-01-01T00:10:00Z');
    expect(onSessionExpired).not.toHaveBeenCalled();

    // The rescheduled timer checks again at the new expiry.
    getCredential = () => waasErrorResponse('KeyExpired');
    await vi.advanceTimersByTimeAsync(479_999);
    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(requestCount(fetchMock, '/GetCredential')).toBe(2);
    expect(wallet.session).toBeUndefined();
    expect(onSessionExpired).toHaveBeenCalledOnce();
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
    const onSessionExpired = vi.fn();
    wallet.onSessionExpired(onSessionExpired);
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);

    try {
      await vi.advanceTimersByTimeAsync(120_000);

      expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
      expect(wallet.session?.expiresAt).toBe('2026-01-01T00:10:00Z');
      expect(storedExpiresAt(storage)).toBe('2026-01-01T00:02:00Z');
      expect(onSessionExpired).not.toHaveBeenCalled();

      // The timer was rescheduled to the in-memory expiry.
      getCredential = () => waasErrorResponse('KeyExpired');
      await vi.advanceTimersByTimeAsync(479_999);
      expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(requestCount(fetchMock, '/GetCredential')).toBe(2);
      expect(onSessionExpired).toHaveBeenCalledOnce();

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
      const onSessionExpired = vi.fn();
      wallet.onSessionExpired(onSessionExpired);

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
      expect(onSessionExpired).toHaveBeenCalledOnce();
      expect(onSessionExpired).toHaveBeenCalledWith({
        wallet: testWalletAccount('wallet-id', walletAddress),
        session: {
          expiresAt: '2099-01-01T00:00:00Z',
          auth: { type: 'email', email: 'user@example.com' }
        },
        expiredAt: '2099-01-01T00:00:00Z'
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
    const onSessionExpired = vi.fn();
    wallet.onSessionExpired(onSessionExpired);

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
    expect(onSessionExpired).toHaveBeenCalledOnce();

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
      const onSessionExpired = vi.fn();
      wallet.onSessionExpired(onSessionExpired);

      await expect(call(wallet)).rejects.toMatchObject({
        name: 'OMSWalletRequestError',
        code: 'OMS_REQUEST_FAILED',
        operation: `wallet.${label}`,
        upstreamError: { service: 'waas', name: 'KeyNotFound', code: '7202' }
      });

      expect(requestCount(fetchMock, endpoint)).toBe(1);
      expect(wallet.session).toBeDefined();
      expect(onSessionExpired).not.toHaveBeenCalled();
    }
  );

  it('keeps local expiry on a server without GetCredential and does not ask again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchMock = stubWaas({ '/GetCredential': () => waasErrorResponse('WebrpcBadRoute') });
    const wallet = createWalletWithSession(walletAddress, undefined, {
      expiresAt: '2026-01-01T00:02:00Z'
    });
    const onSessionExpired = vi.fn();
    wallet.onSessionExpired(onSessionExpired);

    await vi.advanceTimersByTimeAsync(120_000);

    expect(wallet.session).toBeUndefined();
    expect(onSessionExpired).toHaveBeenCalledOnce();

    (wallet as any).persistSession(testWalletAccount('wallet-id', walletAddress), {
      expiresAt: '2000-01-01T00:00:00Z',
      auth: { type: 'email', email: 'user@example.com' },
      signerCredentialId: '0x04' + '11'.repeat(64),
      signerKeyType: 'ecdsa-p256-sha256'
    });
    await expect(signMessage(wallet)).rejects.toMatchObject({ code: 'OMS_SESSION_EXPIRED' });

    expect(requestCount(fetchMock, '/GetCredential')).toBe(1);
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
    const onSessionExpired = vi.fn();
    wallet.onSessionExpired(onSessionExpired);

    await vi.advanceTimersByTimeAsync(120_000);

    expect(wallet.session?.expiresAt).toBe('2026-01-01T00:02:00Z');
    expect(onSessionExpired).not.toHaveBeenCalled();

    // An operation on the locally expired session surfaces the network error and keeps it.
    await expect(signMessage(wallet)).rejects.toMatchObject({
      code: 'OMS_REQUEST_FAILED',
      operation: 'wallet.signMessage'
    });
    expect(wallet.session).toBeDefined();
    expect(requestCount(fetchMock, '/GetCredential')).toBe(2);

    getCredential = async () => credentialResponse('2026-02-01T00:00:00Z');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(requestCount(fetchMock, '/GetCredential')).toBe(3);
    expect(wallet.session?.expiresAt).toBe('2026-02-01T00:00:00Z');
    expect(onSessionExpired).not.toHaveBeenCalled();
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
      Constants.sessionStorageKey,
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
        signerKeyType: 'ecdsa-p256-sha256'
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
