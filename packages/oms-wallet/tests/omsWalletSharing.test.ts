import { afterEach, describe, expect, it, vi } from 'vitest';

import { OMSWalletValidationError } from '../src/errors';
import { Networks } from '../src/networks';
import { OMSWallet } from '../src/omsWallet';
import { MemoryStorageManager } from '../src/storageManager';
import { MockSigner, jsonResponse, testCredential } from './fixtures/helpers.js';
import { testWalletAccount } from './fixtures/walletAccount.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A dev sandbox key of `project`; `keyId` tells keys of one project apart. */
function publishableKey(project: string, keyId = 'key1'): string {
  return `pk_dev_sdbx_${project}_${keyId}`;
}

/** A stand-in for the browser's localStorage. */
function stubLocalStorage(): void {
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key)
  });
}

describe('OMSWallet instances', () => {
  it('share one wallet in a browser, where the default storage and signing key are shared', () => {
    stubLocalStorage();
    vi.stubGlobal('indexedDB', {});

    const first = new OMSWallet({ publishableKey: publishableKey('browser') });
    const second = new OMSWallet({ publishableKey: publishableKey('browser') });

    expect(second.wallet).toBe(first.wallet);
    expect(second.indexer).toBe(first.indexer);
  });

  it('keep other projects and environments separate', () => {
    stubLocalStorage();
    vi.stubGlobal('indexedDB', {});

    const project = new OMSWallet({ publishableKey: publishableKey('scoped') });
    const otherProject = new OMSWallet({ publishableKey: publishableKey('scopedother') });
    const otherEnvironment = new OMSWallet({ publishableKey: 'pk_sdbx_scoped_key1' });

    expect(otherProject.wallet).not.toBe(project.wallet);
    expect(otherEnvironment.wallet).not.toBe(project.wallet);
  });

  it('stay separate sessions where the default session lives only in memory, as in Node', () => {
    // A server that builds one instance per user relies on this.
    expect(globalThis.localStorage).toBeUndefined();

    const firstUser = new OMSWallet({ publishableKey: publishableKey('server') });
    const secondUser = new OMSWallet({ publishableKey: publishableKey('server') });

    expect(secondUser.wallet).not.toBe(firstUser.wallet);
  });

  it('share one wallet for the same custom storage and signer, and not for others', () => {
    const storage = new MemoryStorageManager();
    const signer = new MockSigner();

    const first = new OMSWallet({
      publishableKey: publishableKey('custom'),
      storage,
      credentialSigner: signer
    });
    const second = new OMSWallet({
      publishableKey: publishableKey('custom'),
      storage,
      credentialSigner: signer
    });
    const otherUser = new OMSWallet({
      publishableKey: publishableKey('custom'),
      storage: new MemoryStorageManager(),
      credentialSigner: new MockSigner()
    });

    expect(second.wallet).toBe(first.wallet);
    expect(otherUser.wallet).not.toBe(first.wallet);
  });

  it.each([
    { label: 'a different signer', credentialSigner: () => new MockSigner() },
    { label: 'the default in-memory signer', credentialSigner: () => undefined }
  ])('refuse to share one storage with $label', ({ credentialSigner }) => {
    // Two signers saving their sessions in one storage would overwrite each other's.
    const storage = new MemoryStorageManager();
    new OMSWallet({
      publishableKey: publishableKey('clash'),
      storage,
      credentialSigner: credentialSigner()
    });

    expect(
      () =>
        new OMSWallet({
          publishableKey: publishableKey('clash'),
          storage,
          credentialSigner: credentialSigner()
        })
    ).toThrow(OMSWalletValidationError);
  });

  it('keep the session when the key of the same project changes, and send the new key', async () => {
    const storage = new MemoryStorageManager();
    const signer = new MockSigner();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith('/SignMessage')) return jsonResponse({ signature: '0xsigned' });
      if (url.endsWith('/GetCredential')) return jsonResponse({ credential: testCredential() });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = new OMSWallet({
      publishableKey: publishableKey('rotated', 'old'),
      storage,
      credentialSigner: signer
    });
    (first.wallet as any).persistSession(
      testWalletAccount('wallet-id', '0x1111111111111111111111111111111111111111'),
      {
        expiresAt: '2099-01-01T00:00:00Z',
        auth: { type: 'email', email: 'user@example.com' },
        signerCredentialId: '0x04' + '11'.repeat(64),
        signerKeyType: 'ecdsa-p256-sha256'
      }
    );

    // The session belongs to the project and environment, not to a key.
    const rotated = new OMSWallet({
      publishableKey: publishableKey('rotated', 'new'),
      storage,
      credentialSigner: signer
    });
    await rotated.wallet.signMessage({ network: Networks.polygon, message: 'hello' });

    expect(rotated.wallet).toBe(first.wallet);
    expect(first.wallet.activeWallet?.id).toBe('wallet-id');
    const [, init] = fetchMock.mock.calls.find(([input]) =>
      input.toString().endsWith('/SignMessage')
    )!;
    expect((init?.headers as Record<string, string>)['Api-Key']).toBe(
      publishableKey('rotated', 'new')
    );
  });
});
