import { afterEach, describe, expect, it, vi } from 'vitest';

import { WalletClientImpl } from '../src/clients/walletClient';
import {
  WebCryptoP256CredentialSigner,
  deleteStoredWebCryptoCredential
} from '../src/credentialSigner';
import { Networks } from '../src/networks';
import { MemoryStorageManager } from '../src/storageManager';
import { sessionStorageKeys } from '../src/utils/constants';
import { testWalletAccount } from './fixtures/walletAccount.js';
import { jsonResponse, testEnvironment, waasErrorResponse } from './fixtures/helpers.js';

// Tabs of one origin share the default signer's IndexedDB key. A session that ends on its own in
// one tab (expiry, or a key it no longer holds) must not delete a key another tab's newer sign-in
// stored, or that sign-in is lost on its next page load.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface StoredRecord {
  id: string;
  credentialId: string;
}

/**
 * An in-memory `indexedDB` whose read/write transactions on the store run one at a time, in the
 * order they were created, as the IndexedDB specification requires: a transaction's requests run
 * only while it is active, and it completes a macrotask after its last request. Without that, a
 * write from another tab could land between a transaction's read and its delete.
 */
let transactionsCreated = 0;

function stubSerializedIndexedDb(): Map<string, StoredRecord> {
  const records = new Map<string, StoredRecord>();
  const queue: Array<{ activate: () => void }> = [];
  transactionsCreated = 0;

  const transaction = () => {
    transactionsCreated += 1;
    const buffered: Array<() => void> = [];
    let active = false;
    let pending = 0;
    let completion: ReturnType<typeof setTimeout> | undefined;
    const tx: {
      oncomplete?: () => void;
      onerror?: () => void;
      onabort?: () => void;
      objectStore: () => typeof store;
    } = { objectStore: () => store };

    const scheduleCompletion = () => {
      clearTimeout(completion);
      completion = setTimeout(() => {
        if (pending > 0) return;
        tx.oncomplete?.();
        queue.shift();
        queue[0]?.activate();
      }, 0);
    };
    const request = <T>(run: () => T) => {
      const req: { result?: T; onsuccess?: () => void; onerror?: () => void } = {};
      pending += 1;
      clearTimeout(completion);
      const execute = () =>
        queueMicrotask(() => {
          req.result = run();
          pending -= 1;
          req.onsuccess?.();
          scheduleCompletion();
        });
      if (active) execute();
      else buffered.push(execute);
      return req;
    };
    const store = {
      get: (id: string) => request(() => records.get(id)),
      put: (record: StoredRecord) => request(() => void records.set(record.id, record)),
      delete: (id: string) => request(() => void records.delete(id))
    };

    queue.push({
      activate: () => {
        active = true;
        buffered.splice(0).forEach((run) => run());
        scheduleCompletion();
      }
    });
    if (queue.length === 1) queueMicrotask(() => queue[0]?.activate());
    return tx;
  };

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => undefined,
    close: () => {},
    transaction
  };
  vi.stubGlobal('indexedDB', {
    open: () => {
      const req: { result?: unknown; onsuccess?: () => void } = {};
      queueMicrotask(() => {
        req.result = db;
        req.onsuccess?.();
      });
      return req;
    }
  });
  return records;
}

/** Writes `record` in its own read/write transaction, as another tab's signer does. */
async function putRecord(record: StoredRecord): Promise<void> {
  const db = await new Promise<any>((resolve) => {
    const request = (globalThis as any).indexedDB.open('oms-wallet-sdk', 1);
    request.onsuccess = () => resolve(request.result);
  });
  const tx = db.transaction('credentials', 'readwrite');
  await new Promise<void>((resolve) => {
    tx.oncomplete = resolve;
    tx.objectStore('credentials').put(record);
  });
}

const scope = sessionStorageKeys('project-id', testEnvironment().walletApiUrl);
const credentialRecordId = scope.webCryptoCredential;
const walletAddress = '0x1111111111111111111111111111111111111111';

describe('deleteStoredWebCryptoCredential', () => {
  it('deletes the stored credential only while it is the given one', async () => {
    const records = stubSerializedIndexedDb();
    const signer = new WebCryptoP256CredentialSigner(credentialRecordId);
    const oldId = await signer.credentialId();

    await signer.clear();
    const newId = await new WebCryptoP256CredentialSigner(credentialRecordId).credentialId();
    await expect(deleteStoredWebCryptoCredential(credentialRecordId, oldId)).resolves.toBe(true);
    expect(records.get(credentialRecordId)?.credentialId).toBe(newId);

    await deleteStoredWebCryptoCredential(credentialRecordId, newId.toUpperCase());
    expect(records.has(credentialRecordId)).toBe(false);
  });

  it('keeps a credential another tab writes while the delete is in progress', async () => {
    const records = stubSerializedIndexedDb();
    const oldId = await new WebCryptoP256CredentialSigner(credentialRecordId).credentialId();

    // The other tab's write starts once the delete's transaction exists: it runs after that
    // transaction, never between its read and its delete.
    const before = transactionsCreated;
    const deleting = deleteStoredWebCryptoCredential(credentialRecordId, oldId);
    await vi.waitFor(() => expect(transactionsCreated).toBe(before + 1), { interval: 0 });
    const replacing = putRecord({ id: credentialRecordId, credentialId: '0x04bb' });
    await Promise.all([deleting, replacing]);

    expect(records.get(credentialRecordId)?.credentialId).toBe('0x04bb');
  });

  it('reports no IndexedDB, where the key lives only in the signer', async () => {
    expect((globalThis as { indexedDB?: unknown }).indexedDB).toBeUndefined();
    await expect(deleteStoredWebCryptoCredential(credentialRecordId, '0x04aa')).resolves.toBe(
      false
    );
  });
});

describe('a session that ends on its own', () => {
  /** A tab with the default signer, whose session was signed in with that tab's key. */
  async function signedInTab(
    storage: MemoryStorageManager,
    redirectAuthStorage: MemoryStorageManager
  ) {
    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      redirectAuthStorage
    });
    const credentialId = await (wallet as any).credentialSigner.credentialId();
    (wallet as any).persistSession(testWalletAccount('wallet-a', walletAddress), {
      expiresAt: '2099-01-01T00:00:00Z',
      auth: { type: 'email', email: 'user@example.com' },
      signerCredentialId: credentialId,
      signerKeyType: 'ecdsa-p256-sha256',
      expiryBounds: {
        idleWindowMs: 10 * 24 * 60 * 60 * 1000,
        expiryCeilingMs: Date.parse('2099-01-01T00:00:00Z')
      }
    });
    const onSessionExpired = vi.fn();
    wallet.onSessionExpired(onSessionExpired);
    return { wallet, credentialId: credentialId as string, onSessionExpired };
  }

  /** Another tab signs in again: a new shared key, and its own pending redirect state. */
  async function otherTabSignsIn(redirectAuthStorage: MemoryStorageManager): Promise<string> {
    const otherTab = new WebCryptoP256CredentialSigner(credentialRecordId);
    await otherTab.clear();
    redirectAuthStorage.set(scope.redirectAuth, '{"pending":"other tab"}');
    return otherTab.credentialId();
  }

  /** Holds the first SignMessage response until `answer` is called. */
  function holdSignMessage() {
    let answer!: (response: Response) => void;
    let sent!: () => void;
    const requestSent = new Promise<void>((resolve) => (sent = resolve));
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (!input.toString().endsWith('/SignMessage')) {
          return Promise.reject(new Error(`Unexpected request: ${input.toString()}`));
        }
        sent();
        return new Promise<Response>((resolve) => (answer = resolve));
      })
    );
    return { requestSent, answer: (response: Response) => answer(response) };
  }

  it("keeps the key of another tab's newer sign-in when its rejected request returns", async () => {
    const records = stubSerializedIndexedDb();
    const storage = new MemoryStorageManager();
    const redirectAuthStorage = new MemoryStorageManager();
    const tabA = await signedInTab(storage, redirectAuthStorage);
    const held = holdSignMessage();

    const signing = tabA.wallet
      .signMessage({ network: Networks.polygon, message: 'hello' })
      .catch((error: unknown) => error);
    await held.requestSent;
    const newId = await otherTabSignsIn(redirectAuthStorage);
    held.answer(waasErrorResponse('KeyExpired'));

    await expect(signing).resolves.toMatchObject({ code: 'OMS_SESSION_EXPIRED' });
    expect(tabA.wallet.session).toBeUndefined();
    expect(tabA.onSessionExpired).toHaveBeenCalledOnce();
    expect(records.get(credentialRecordId)?.credentialId).toBe(newId);
    expect(redirectAuthStorage.get(scope.redirectAuth)).toBe('{"pending":"other tab"}');
  });

  it("keeps the key of another tab's sign-in in progress when this tab finds its key replaced", async () => {
    const records = stubSerializedIndexedDb();
    const storage = new MemoryStorageManager();
    const redirectAuthStorage = new MemoryStorageManager();
    const tabA = await signedInTab(storage, redirectAuthStorage);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ signature: '0xsigned' }))
    );

    // The other tab made its key but has not stored its session yet, so the record is still A's.
    const newId = await otherTabSignsIn(redirectAuthStorage);
    await expect(
      tabA.wallet.signMessage({ network: Networks.polygon, message: 'hello' })
    ).rejects.toMatchObject({ code: 'OMS_SESSION_MISSING' });

    expect(records.get(credentialRecordId)?.credentialId).toBe(newId);
    expect(redirectAuthStorage.get(scope.redirectAuth)).toBe('{"pending":"other tab"}');
  });

  it("keeps the key of another tab's newer sign-in when an expired stored session is replayed", async () => {
    const records = stubSerializedIndexedDb();
    const storage = new MemoryStorageManager();
    const redirectAuthStorage = new MemoryStorageManager();
    const tabA = await signedInTab(storage, redirectAuthStorage);
    const record = JSON.parse(storage.get(scope.session) ?? '{}');
    storage.set(scope.session, JSON.stringify({ ...record, expiresAt: '2000-01-01T00:00:00Z' }));
    const newId = await otherTabSignsIn(redirectAuthStorage);

    const reloaded = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage,
      redirectAuthStorage
    });
    const onSessionExpired = vi.fn();
    reloaded.onSessionExpired(onSessionExpired);
    await vi.waitFor(() => expect(onSessionExpired).toHaveBeenCalledOnce());

    expect(records.get(credentialRecordId)?.credentialId).toBe(newId);
    expect(tabA.credentialId).not.toBe(newId);
  });

  it('still deletes its own key when nothing replaced it', async () => {
    const records = stubSerializedIndexedDb();
    const storage = new MemoryStorageManager();
    const redirectAuthStorage = new MemoryStorageManager();
    const tabA = await signedInTab(storage, redirectAuthStorage);
    const held = holdSignMessage();

    const signing = tabA.wallet
      .signMessage({ network: Networks.polygon, message: 'hello' })
      .catch((error: unknown) => error);
    await held.requestSent;
    held.answer(waasErrorResponse('KeyExpired'));

    await expect(signing).resolves.toMatchObject({ code: 'OMS_SESSION_EXPIRED' });
    expect(tabA.onSessionExpired).toHaveBeenCalledOnce();
    expect(records.has(credentialRecordId)).toBe(false);
    // The record stays as the sign-in hint the expiry event replays.
    expect(storage.get(scope.session)).toBeTruthy();
  });
});
