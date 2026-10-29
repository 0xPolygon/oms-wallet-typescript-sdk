import { afterEach, describe, expect, it, vi } from 'vitest';

import { WalletClientImpl } from '../src/clients/walletClient';
import { MemoryStorageManager } from '../src/storageManager';
import { testWalletAccount } from './fixtures/walletAccount.js';
import {
  MockSigner,
  createWalletWithSession,
  jsonResponse,
  listenToSessionChanges,
  sessionChangeReasons,
  testCredential,
  testEnvironment,
  testStorageKeys,
  waasErrorResponse
} from './fixtures/helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const firstAddress = '0x1111111111111111111111111111111111111111';
const secondAddress = '0x2222222222222222222222222222222222222222';
const otherCredentialId = '0x04' + '33'.repeat(64);

function evmWallet(id: string, address: string) {
  return { id, networkFamily: 'evm', keyOrigin: 'enclave', address };
}

/** Answers a sign-in with two wallets, and activates whichever wallet is asked for. */
function stubWaas(handlers: Record<string, () => Response> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = '/' + input.toString().split('/').pop();
      if (handlers[endpoint]) return handlers[endpoint]();
      if (endpoint === '/CompleteAuth') {
        return jsonResponse({
          identity: { type: 'email', sub: 'user-1' },
          wallets: [evmWallet('wallet-1', firstAddress), evmWallet('wallet-2', secondAddress)],
          credential: testCredential()
        });
      }
      if (endpoint === '/UseWallet') {
        const { walletId } = JSON.parse(init?.body as string);
        return jsonResponse({
          wallet: evmWallet(walletId, walletId === 'wallet-1' ? firstAddress : secondAddress)
        });
      }
      if (endpoint === '/CommitVerifier') {
        return jsonResponse({ verifier: 'verifier-2', challenge: 'challenge-2' });
      }
      throw new Error(`Unexpected request: ${endpoint}`);
    })
  );
}

function newClient(storage = new MemoryStorageManager(), signer = new MockSigner()) {
  return new WalletClientImpl({
    publishableKey: 'publishable-key',
    projectId: 'project-id',
    environment: testEnvironment(),
    storage,
    credentialSigner: signer
  });
}

/** Completes an email sign-in, as after `startEmailAuth` sent the code. */
function signIn(wallet: WalletClientImpl, walletSelection: 'automatic' | 'manual' = 'automatic') {
  (wallet as any).activeEmailAuthAttempt = {
    email: 'user@example.com',
    verifier: 'verifier-1',
    challenge: 'challenge-1',
    sessionLifetimeSeconds: 604_800
  };
  return wallet.completeEmailAuth({ code: '123456', walletSelection } as any);
}

/** A session whose expiry has passed, which WaaS reports ended at the next call. */
function expiredSessionWallet() {
  stubWaas({ '/GetCredential': () => waasErrorResponse('KeyExpired') });
  return createWalletWithSession(firstAddress, undefined, { expiresAt: '2000-01-01T00:00:00Z' });
}

async function expireNow(wallet: WalletClientImpl) {
  await expect(wallet.listWallets()).rejects.toMatchObject({ code: 'OMS_SESSION_EXPIRED' });
}

describe('session changes', () => {
  it('reports each change of the active wallet or session once, with the state after it', async () => {
    stubWaas();
    const wallet = newClient();
    const onSessionChange = listenToSessionChanges(wallet);

    await signIn(wallet);
    await wallet.useWallet({ walletId: 'wallet-2' });
    // Activating the active wallet again changes nothing.
    await wallet.useWallet({ walletId: 'wallet-2' });
    await wallet.signOut();
    await wallet.signOut();

    expect(onSessionChange.mock.calls.map(([event]) => event)).toEqual([
      {
        reason: 'signedIn',
        activeWallet: testWalletAccount('wallet-1', firstAddress),
        session: {
          expiresAt: '2099-01-01T00:00:00Z',
          auth: { type: 'email', email: 'user@example.com' }
        }
      },
      {
        reason: 'walletChanged',
        activeWallet: testWalletAccount('wallet-2', secondAddress),
        session: {
          expiresAt: '2099-01-01T00:00:00Z',
          auth: { type: 'email', email: 'user@example.com' }
        }
      },
      { reason: 'signedOut', activeWallet: undefined, session: undefined }
    ]);
  });

  it('reports a manual sign-in once a wallet is chosen', async () => {
    stubWaas();
    const wallet = newClient();
    const onSessionChange = listenToSessionChanges(wallet);

    const selection = await signIn(wallet, 'manual');
    await Promise.resolve();
    expect(sessionChangeReasons(onSessionChange)).toEqual([]);

    await (selection as any).selectWallet({ walletId: 'wallet-2' });
    expect(sessionChangeReasons(onSessionChange)).toEqual(['signedIn']);
  });

  it('reports the end of the session when another sign-in starts', async () => {
    stubWaas();
    const wallet = createWalletWithSession(firstAddress);
    const onSessionChange = listenToSessionChanges(wallet);

    await wallet.startEmailAuth({ email: 'other@example.com' });

    expect(sessionChangeReasons(onSessionChange)).toEqual(['signedOut']);
  });

  it('reports nothing for the session restored at construction', async () => {
    const storage = new MemoryStorageManager();
    createWalletWithSession(firstAddress, undefined, { storage });
    stubWaas({ '/GetCredential': () => jsonResponse({ credential: testCredential() }) });

    const restored = newClient(storage);
    const onSessionChange = listenToSessionChanges(restored);
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    await Promise.resolve();

    expect(restored.activeWallet?.address).toBe(firstAddress);
    expect(sessionChangeReasons(onSessionChange)).toEqual([]);
  });

  it('delivers a change after the call that made it, never during it', async () => {
    const wallet = newClient();
    const order: string[] = [];
    wallet.onSessionChange(({ reason }) => {
      order.push(reason);
    });

    (wallet as any).persistSession(testWalletAccount('wallet-1', firstAddress), {
      expiresAt: '2099-01-01T00:00:00Z',
      auth: { type: 'email', email: 'user@example.com' },
      signerCredentialId: '0x04' + '11'.repeat(64),
      signerKeyType: 'ecdsa-p256-sha256'
    });
    order.push('returned');
    await Promise.resolve();

    expect(order).toEqual(['returned', 'signedIn']);
  });

  it('delivers changes in order to every listener, including one a listener causes', async () => {
    stubWaas();
    const wallet = createWalletWithSession(firstAddress);
    wallet.onSessionChange(({ reason }) => {
      if (reason === 'walletChanged') void wallet.signOut();
    });
    const second = listenToSessionChanges(wallet);

    await wallet.useWallet({ walletId: 'wallet-2' });

    await vi.waitFor(() =>
      expect(sessionChangeReasons(second)).toEqual(['walletChanged', 'signedOut'])
    );
    expect(wallet.activeWallet).toBeUndefined();
  });

  it('leaves no state of the old session when a listener signs out right after a sign-in', async () => {
    stubWaas();
    const wallet = newClient();
    wallet.onSessionChange(({ reason }) => {
      if (reason === 'signedIn') void wallet.signOut();
    });
    const selection = await signIn(wallet, 'manual');

    await (selection as any).selectWallet({ walletId: 'wallet-1' });
    await vi.waitFor(() => expect(wallet.activeWallet).toBeUndefined());

    expect((wallet as any).activePendingWalletSelection).toBeUndefined();
    expect((wallet as any).lastCredentialRefreshAt).toBeUndefined();
  });

  it('reports a sign-out only after the signer cleared its key', async () => {
    const signer = new MockSigner();
    let finishClear!: () => void;
    (signer as any).clear = vi.fn(() => new Promise<void>((resolve) => (finishClear = resolve)));
    const wallet = createWalletWithSession(firstAddress, undefined, { signer });
    const onSessionChange = listenToSessionChanges(wallet);

    const signingOut = wallet.signOut();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wallet.activeWallet).toBeUndefined();
    expect(sessionChangeReasons(onSessionChange)).toEqual([]);

    finishClear();
    await signingOut;
    await Promise.resolve();
    expect(sessionChangeReasons(onSessionChange)).toEqual(['signedOut']);
  });

  it('keeps other listeners and the operation unaffected by a failing listener', async () => {
    stubWaas();
    const wallet = createWalletWithSession(firstAddress);
    wallet.onSessionChange(() => {
      throw new Error('listener failed');
    });
    wallet.onSessionChange(() => Promise.reject(new Error('listener rejected')));
    const onSessionChange = listenToSessionChanges(wallet);

    await expect(wallet.useWallet({ walletId: 'wallet-2' })).resolves.toBeDefined();
    await Promise.resolve();

    expect(sessionChangeReasons(onSessionChange)).toEqual(['walletChanged']);
  });

  it('delivers nothing more to a listener once it unsubscribes, including queued changes', async () => {
    stubWaas();
    const wallet = createWalletWithSession(firstAddress);
    const listener = vi.fn();
    const unsubscribe = wallet.onSessionChange(listener);

    void wallet.signOut();
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(wallet.activeWallet).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  describe('expiry replay', () => {
    it('replays an expiry once to a listener added inside another listener', async () => {
      const wallet = expiredSessionWallet();
      const late = vi.fn();
      wallet.onSessionChange(({ reason }) => {
        if (reason === 'expired') wallet.onSessionChange(late);
      });

      await expireNow(wallet);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(late).toHaveBeenCalledOnce();
      expect(late.mock.calls[0][0]).toMatchObject({ reason: 'expired' });
    });

    it.each([
      ['signing out', (wallet: WalletClientImpl) => wallet.signOut()],
      [
        'starting a sign-in',
        (wallet: WalletClientImpl) => wallet.startEmailAuth({ email: 'user@example.com' })
      ]
    ])('stops replaying an expiry after %s, which changes nothing else', async (_, act) => {
      const wallet = expiredSessionWallet();
      await expireNow(wallet);
      stubWaas();

      const onSessionChange = listenToSessionChanges(wallet);
      await act(wallet);
      const late = listenToSessionChanges(wallet);
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The first listener got the replay; nothing changed after it, so nothing else.
      expect(sessionChangeReasons(onSessionChange)).toEqual(['expired']);
      expect(late).not.toHaveBeenCalled();
    });
  });
});

/**
 * Browser events for clients created after this: `storage` events from other tabs, and the page
 * becoming visible.
 */
function stubBrowserEvents() {
  const handlers: Array<{ type: string; handler: (event?: { key?: string | null }) => void }> = [];
  const document = {
    visibilityState: 'visible',
    addEventListener: (type: string, handler: () => void) => handlers.push({ type, handler }),
    removeEventListener: () => {}
  };
  vi.stubGlobal('document', document);
  vi.stubGlobal('addEventListener', (type: string, handler: () => void) =>
    handlers.push({ type, handler })
  );
  const fire = (type: string, event?: { key?: string | null }) =>
    handlers.filter((entry) => entry.type === type).forEach(({ handler }) => handler(event));
  return {
    /** Another tab wrote the stored session. */
    storageChanged: () => fire('storage', { key: testStorageKeys.session }),
    pageShown: () => fire('visibilitychange')
  };
}

describe('session changes from other tabs', () => {
  /** Two tabs of one origin: shared storage, and one signing key both see. */
  function twoTabs() {
    const browser = stubBrowserEvents();
    stubWaas({ '/GetCredential': () => jsonResponse({ credential: testCredential() }) });
    const storage = new MemoryStorageManager();
    const signer = new MockSigner();
    const tabA = newClient(storage, signer);
    const tabB = newClient(storage, signer);
    return { browser, storage, signer, tabA, tabB, onTabBChange: listenToSessionChanges(tabB) };
  }

  it("follows another tab's sign-in, wallet switch and sign-out", async () => {
    const { browser, tabA, tabB, onTabBChange } = twoTabs();

    await signIn(tabA);
    browser.storageChanged();
    await vi.waitFor(() => expect(sessionChangeReasons(onTabBChange)).toEqual(['signedIn']));
    expect(tabB.activeWallet).toEqual(tabA.activeWallet);

    await tabA.useWallet({ walletId: 'wallet-2' });
    browser.storageChanged();
    await vi.waitFor(() =>
      expect(sessionChangeReasons(onTabBChange)).toEqual(['signedIn', 'walletChanged'])
    );
    expect(tabB.activeWallet?.address).toBe(secondAddress);

    await tabA.signOut();
    browser.storageChanged();
    await vi.waitFor(() =>
      expect(sessionChangeReasons(onTabBChange)).toEqual(['signedIn', 'walletChanged', 'signedOut'])
    );
  });

  it("follows another tab's later expiry and ignores an earlier one", async () => {
    const { browser, storage, tabA, tabB, onTabBChange } = twoTabs();
    await signIn(tabA);
    browser.storageChanged();
    await vi.waitFor(() => expect(tabB.activeWallet).toBeDefined());
    const writeExpiry = (expiresAt: string) => {
      const record = JSON.parse(storage.get(testStorageKeys.session)!);
      storage.set(testStorageKeys.session, JSON.stringify({ ...record, expiresAt }));
      browser.storageChanged();
    };

    writeExpiry('2099-06-01T00:00:00Z');
    await vi.waitFor(() => expect(tabB.session?.expiresAt).toBe('2099-06-01T00:00:00Z'));
    writeExpiry('2099-02-01T00:00:00Z');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(tabB.session?.expiresAt).toBe('2099-06-01T00:00:00Z');
    expect(sessionChangeReasons(onTabBChange)).toEqual(['signedIn', 'expiryUpdated']);
  });

  it('ignores a sign-in whose key this tab does not hold', async () => {
    const browser = stubBrowserEvents();
    stubWaas();
    const storage = new MemoryStorageManager();
    const tabA = newClient(storage, new MockSigner());
    const tabB = newClient(storage, new MockSigner(otherCredentialId));
    const onTabBChange = listenToSessionChanges(tabB);

    await signIn(tabA);
    browser.storageChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(tabB.activeWallet).toBeUndefined();
    expect(onTabBChange).not.toHaveBeenCalled();
  });

  it('ends a session that ended on its own in another tab once this tab is shown', async () => {
    const { browser, signer, tabA, tabB, onTabBChange } = twoTabs();
    await signIn(tabA);
    browser.storageChanged();
    await vi.waitFor(() => expect(tabB.activeWallet).toBeDefined());

    // WaaS rejected the session in tab A: its key is gone and its record stays, with no storage event.
    vi.spyOn(signer, 'hasCredential').mockResolvedValue(false);
    browser.pageShown();

    await vi.waitFor(() =>
      expect(sessionChangeReasons(onTabBChange)).toEqual(['signedIn', 'expired'])
    );
    expect(tabB.activeWallet).toBeUndefined();
  });

  it('follows a burst of storage events once, writing nothing', async () => {
    const { browser, storage, tabA, tabB, onTabBChange } = twoTabs();
    await signIn(tabA);
    const set = vi.spyOn(storage, 'set');
    const remove = vi.spyOn(storage, 'delete');

    browser.storageChanged();
    browser.storageChanged();
    browser.storageChanged();
    await vi.waitFor(() => expect(tabB.activeWallet).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sessionChangeReasons(onTabBChange)).toEqual(['signedIn']);
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
