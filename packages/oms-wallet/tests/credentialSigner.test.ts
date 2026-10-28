import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthMode, IdentityType, Waas } from '../src/generated/waas.gen';
import { Networks } from '../src/networks';
import { WebCryptoP256CredentialSigner } from '../src/credentialSigner';
import { createSignedFetch } from '../src/signedFetch';
import {
  MockSigner,
  createWalletWithSession,
  jsonResponse,
  requestCount,
  waasErrorResponse
} from './fixtures/helpers.js';

/** A fixture signer whose nonces increase with every request, as real signers' do. */
class IncreasingNonceSigner extends MockSigner {
  private nonce = 0;

  async nextNonce(): Promise<string> {
    this.nonce += 1;
    return this.nonce.toString();
  }
}

/** The nonces of the requests sent to `endpoint`, read from their signature headers. */
function sentNonces(fetchMock: ReturnType<typeof vi.fn>, endpoint: string): number[] {
  return fetchMock.mock.calls
    .filter(([input]) => input.toString().endsWith(endpoint))
    .map(([, init]) => {
      const header = (init?.headers as Record<string, string>)['OMS-Wallet-Signature'];
      return Number(/nonce=(\d+)/.exec(header)?.[1]);
    });
}

const walletAddress = '0x1111111111111111111111111111111111111111';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('wallet request signing', () => {
  it('signs generated WaaS wallet RPC requests with the canonical preimage and signature header', async () => {
    const request = {
      identityType: IdentityType.Email,
      authMode: AuthMode.OTP,
      metadata: { email: 'user@example.com' }
    };
    const body = JSON.stringify(request);
    const signer = new MockSigner();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            verifier: 'verifier-id',
            challenge: 'challenge-id'
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const signedFetch = createSignedFetch('publishable-key', signer, 'project-id');
    const client = new Waas('https://wallet.example', signedFetch);
    await client.commitVerifier(request);

    expect(signer.preimages).toEqual([
      'POST /v1/Waas/CommitVerifier\n' + 'nonce: 42\n' + 'scope: project-id\n\n' + body
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://wallet.example/v1/Waas/CommitVerifier',
      expect.objectContaining({
        method: 'POST',
        body
      })
    );

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers).toMatchObject({
      'Api-Key': 'publishable-key',
      'Content-Type': 'application/json',
      'OMS-Wallet-Signature': `alg="ecdsa-p256-sha256", scope="project-id", cred="0x04${'11'.repeat(64)}", nonce=42, sig="0x${'22'.repeat(64)}"`
    });
  });
});

describe('wallet request nonce rejection', () => {
  it('resends a request rejected for its nonce with a fresh, higher nonce', async () => {
    const responses = [
      waasErrorResponse('PreconditionFailed'),
      jsonResponse({ signature: '0xsigned' })
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      responses.shift()!
    );
    vi.stubGlobal('fetch', fetchMock);
    const wallet = createWalletWithSession(walletAddress, undefined, {
      signer: new IncreasingNonceSigner()
    });

    await expect(wallet.signMessage({ network: Networks.polygon, message: 'hello' })).resolves.toBe(
      '0xsigned'
    );

    expect(requestCount(fetchMock, '/SignMessage')).toBe(2);
    const [first, second] = sentNonces(fetchMock, '/SignMessage');
    expect(second).toBeGreaterThan(first);
  });

  it('resends an Execute rejected for its nonce and completes the transaction', async () => {
    let executeCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/PrepareEthereumTransaction')) {
        return jsonResponse({
          txnId: 'txn-1',
          status: 'quoted',
          feeOptions: [],
          sponsored: true,
          expiresAt: '2099-01-01T00:00:00Z'
        });
      }
      if (url.endsWith('/Execute')) {
        executeCalls += 1;
        return executeCalls === 1
          ? waasErrorResponse('PreconditionFailed')
          : jsonResponse({ status: 'pending' });
      }
      if (url.endsWith('/TransactionStatus')) {
        return jsonResponse({ status: 'executed', txnHash: '0xtx' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wallet = createWalletWithSession(walletAddress, undefined, {
      signer: new IncreasingNonceSigner()
    });

    await expect(
      wallet.sendTransaction({ network: Networks.polygon, to: walletAddress, value: 0n })
    ).resolves.toMatchObject({ txnId: 'txn-1', status: 'executed', txnHash: '0xtx' });

    expect(requestCount(fetchMock, '/Execute')).toBe(2);
    const [first, second] = sentNonces(fetchMock, '/Execute');
    expect(second).toBeGreaterThan(first);
  });

  it('reports an Execute still rejected for its nonce after two resends as a request failure', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/PrepareEthereumTransaction')) {
        return jsonResponse({
          txnId: 'txn-1',
          status: 'quoted',
          feeOptions: [],
          sponsored: true,
          expiresAt: '2099-01-01T00:00:00Z'
        });
      }
      if (url.endsWith('/Execute')) return waasErrorResponse('PreconditionFailed');
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wallet = createWalletWithSession(walletAddress, undefined, {
      signer: new IncreasingNonceSigner()
    });

    // WaaS rejects the nonce before Execute runs, so the transaction was never submitted.
    const error = await wallet
      .sendTransaction({ network: Networks.polygon, to: walletAddress, value: 0n })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: 'OMSWalletRequestError',
      code: 'OMS_REQUEST_FAILED',
      operation: 'wallet.execute',
      status: 412,
      retryable: false,
      upstreamError: { service: 'waas', name: 'PreconditionFailed', code: '7206' }
    });
    expect((error as { txnId?: string }).txnId).toBeUndefined();
    expect(requestCount(fetchMock, '/Execute')).toBe(3);
  });

  it('surfaces the nonce rejection after two resends', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      waasErrorResponse('PreconditionFailed')
    );
    vi.stubGlobal('fetch', fetchMock);
    const wallet = createWalletWithSession(walletAddress, undefined, {
      signer: new IncreasingNonceSigner()
    });

    await expect(
      wallet.signMessage({ network: Networks.polygon, message: 'hello' })
    ).rejects.toMatchObject({
      name: 'OMSWalletRequestError',
      code: 'OMS_REQUEST_FAILED',
      operation: 'wallet.signMessage',
      status: 412,
      retryable: false,
      upstreamError: { service: 'waas', name: 'PreconditionFailed', code: '7206' }
    });

    expect(requestCount(fetchMock, '/SignMessage')).toBe(3);
    expect(wallet.session).toBeDefined();
  });
});

/**
 * A minimal in-memory `indexedDB` for the WebCrypto signer: one database whose object stores keep
 * records by `id`. Requests succeed in a microtask; a transaction completes in the next macrotask,
 * after the requests chained on it.
 */
function stubIndexedDb(): Map<string, unknown> {
  const records = new Map<string, unknown>();
  const request = <T>(run: () => T) => {
    const req: { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
    queueMicrotask(() => {
      try {
        req.result = run();
        req.onsuccess?.();
      } catch (error) {
        req.error = error;
        req.onerror?.();
      }
    });
    return req;
  };
  const store = {
    get: (id: string) => request(() => records.get(id)),
    put: (record: { id: string }) => request(() => void records.set(record.id, record)),
    delete: (id: string) => request(() => void records.delete(id))
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    close: () => {},
    transaction: () => {
      const tx: { oncomplete?: () => void; objectStore: () => typeof store } = {
        objectStore: () => store
      };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    }
  };
  vi.stubGlobal('indexedDB', { open: () => request(() => db) });
  return records;
}

describe('WebCryptoP256CredentialSigner', () => {
  it('loads or creates a key again after another client removed the stored one', async () => {
    const records = stubIndexedDb();
    const signer = new WebCryptoP256CredentialSigner();
    const first = await signer.credentialId();
    expect(first).toMatch(/^0x04/);

    // Another tab signed out and removed the shared key.
    records.clear();
    await expect(signer.nextNonce()).rejects.toThrow('WebCrypto credential signer was cleared');

    const next = await signer.credentialId();
    expect(next).toMatch(/^0x04/);
    expect(next).not.toBe(first);
    await expect(signer.nextNonce()).resolves.toMatch(/^\d+$/);
  });

  it('reports the stored key after another tab replaced it', async () => {
    stubIndexedDb();
    const tab = new WebCryptoP256CredentialSigner();
    const otherTab = new WebCryptoP256CredentialSigner();
    const oldId = await tab.credentialId();

    // The other tab signs out and in again, which replaces the shared key.
    await otherTab.clear();
    const newId = await otherTab.credentialId();
    expect(newId).not.toBe(oldId);

    await expect(tab.hasCredential()).resolves.toBe(true);
    await expect(tab.credentialId()).resolves.toBe(newId);
    await otherTab.clear();
    await expect(tab.hasCredential()).resolves.toBe(false);
  });

  it('refuses a nonce when the key was replaced after its credential ID was read', async () => {
    stubIndexedDb();
    const tab = new WebCryptoP256CredentialSigner();
    const otherTab = new WebCryptoP256CredentialSigner();
    const oldId = await tab.credentialId();

    await otherTab.clear();
    const newId = await otherTab.credentialId();

    // A request signed now would carry the old ID with a signature from the new key.
    await expect(tab.nextNonce()).rejects.toThrow('WebCrypto credential signer key was replaced');
    expect(oldId).not.toBe(newId);
    await expect(tab.credentialId()).resolves.toBe(newId);
    await expect(tab.nextNonce()).resolves.toMatch(/^\d+$/);
  });
});
