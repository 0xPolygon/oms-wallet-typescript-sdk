import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletClientImpl } from '../src/clients/walletClient';
import { OMSWalletRequestError } from '../src/errors';
import { MemoryStorageManager } from '../src/storageManager';
import { Constants } from '../src/utils/constants';
import { WalletType } from '../src/types/waas';
import { base64UrlEncodeString } from '../src/utils/oidcRedirect';
import {
  MockSigner,
  createWalletWithSession,
  jsonResponse,
  requestCount,
  testCredential,
  testEnvironment,
  waasErrorResponse,
  waitForRequest
} from './fixtures/helpers.js';

const ownedEthereum = waasWallet('wallet-owned-eth', WalletType.Ethereum, '0x' + '11'.repeat(20));
const ownedSolana = waasWallet(
  'wallet-owned-sol',
  WalletType.Solana,
  '3gFktQX6vki5M2DzN8Y1ESPUJ4fJ8o6hVQWf8vYvPypD'
);
const claimableEthereum = waasWallet(
  'wallet-claimable-eth',
  WalletType.Ethereum,
  '0x' + 'aa'.repeat(20)
);
const claimableSolana = waasWallet(
  'wallet-claimable-sol',
  WalletType.Solana,
  '4Nd1mYQbqjVU2aR7cJNPyqW9XjHnBYvWQd7ZxYxvT6uP'
);
const claimableTron = waasWallet(
  'wallet-claimable-trx',
  WalletType.Tron,
  'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
);
const createdEthereum = waasWallet(
  'wallet-created-eth',
  WalletType.Ethereum,
  '0x' + 'cc'.repeat(20)
);

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => waasErrorResponse('WebrpcBadRoute'))
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WalletClient claimable wallets', () => {
  it('automatic email sign-in claims a claimable wallet of the requested type instead of creating one', async () => {
    const storage = new MemoryStorageManager();
    const claimRequests: unknown[] = [];
    const fetchMock = mockWaas({
      completeAuth: () =>
        completeAuthResponse({
          wallets: [ownedSolana],
          claimable: [claimableEthereum, claimableTron]
        }),
      claimWallet: (body) => {
        claimRequests.push(body);
        return jsonResponse({ wallet: { ...claimableEthereum } });
      }
    });
    const wallet = createWalletClient(storage);
    seedEmailAuthAttempt(wallet);

    const result = await wallet.completeEmailAuth({
      code: '123456',
      walletType: WalletType.Ethereum
    });

    expect(claimRequests).toEqual([{ walletId: 'wallet-claimable-eth' }]);
    expect(requestCount(fetchMock, '/CreateWallet')).toBe(0);
    expect(requestCount(fetchMock, '/UseWallet')).toBe(0);
    expect(result).toEqual({
      wallet: account(claimableEthereum),
      wallets: [account(ownedSolana), account(claimableEthereum)],
      claimableWallets: [account(claimableTron)],
      credential: testCredential()
    });
    expect(wallet.activeWallet).toEqual(account(claimableEthereum));
    expect(storedSession(storage)?.wallet).toEqual(account(claimableEthereum));
  });

  it('automatic OIDC ID-token sign-in claims a claimable wallet of the requested type', async () => {
    const storage = new MemoryStorageManager();
    const fetchMock = mockWaas({
      commitVerifier: () => jsonResponse({ verifier: 'oidc-verifier-1', challenge: 'challenge-1' }),
      completeAuth: () =>
        completeAuthResponse({
          identity: { type: 'oidc', iss: 'https://accounts.google.com', sub: 'google-sub-1' },
          wallets: [],
          claimable: [claimableSolana]
        }),
      claimWallet: (body) => {
        expect(body).toEqual({ walletId: 'wallet-claimable-sol' });
        return jsonResponse({ wallet: { ...claimableSolana } });
      }
    });
    const wallet = createWalletClient(storage);

    const result = await wallet.signInWithOidcIdToken({
      idToken: fakeJwt({ exp: 1_910_000_100 }),
      issuer: 'https://accounts.google.com',
      audience: 'google-client-id',
      walletType: WalletType.Solana
    });

    expect(result.wallet).toEqual(account(claimableSolana));
    expect(result.claimableWallets).toEqual([]);
    expect(requestCount(fetchMock, '/ClaimWallet')).toBe(1);
    expect(requestCount(fetchMock, '/CreateWallet')).toBe(0);
    expect(storedSession(storage)?.wallet).toEqual(account(claimableSolana));
  });

  it('automatic sign-in uses an owned wallet before a claimable one', async () => {
    const fetchMock = mockWaas({
      completeAuth: () =>
        completeAuthResponse({ wallets: [ownedEthereum], claimable: [claimableEthereum] }),
      useWallet: (body) => {
        expect(body).toEqual({ walletId: 'wallet-owned-eth' });
        return jsonResponse({ wallet: { ...ownedEthereum } });
      }
    });
    const wallet = createWalletClient();
    seedEmailAuthAttempt(wallet);

    const result = await wallet.completeEmailAuth({ code: '123456' });

    expect(result.wallet).toEqual(account(ownedEthereum));
    expect(result.claimableWallets).toEqual([account(claimableEthereum)]);
    expect(requestCount(fetchMock, '/ClaimWallet')).toBe(0);
    expect(requestCount(fetchMock, '/CreateWallet')).toBe(0);
  });

  it('automatic sign-in creates a wallet when only other wallet types are claimable', async () => {
    const fetchMock = mockWaas({
      completeAuth: () =>
        completeAuthResponse({ wallets: [], claimable: [claimableSolana, claimableTron] }),
      createWallet: (body) => {
        expect(body).toEqual({ networkFamily: 'evm' });
        return jsonResponse({ wallet: { ...createdEthereum } });
      }
    });
    const wallet = createWalletClient();
    seedEmailAuthAttempt(wallet);

    const result = await wallet.completeEmailAuth({ code: '123456' });

    expect(result.wallet).toEqual(account(createdEthereum));
    expect(result.claimableWallets).toEqual([account(claimableSolana), account(claimableTron)]);
    expect(requestCount(fetchMock, '/ClaimWallet')).toBe(0);
    expect(requestCount(fetchMock, '/CreateWallet')).toBe(1);
  });

  it('fails automatic sign-in when the claim is rejected, without creating a wallet', async () => {
    const storage = new MemoryStorageManager();
    const fetchMock = mockWaas({
      completeAuth: () => completeAuthResponse({ wallets: [], claimable: [claimableEthereum] }),
      claimWallet: () => accountNotFoundResponse()
    });
    const wallet = createWalletClient(storage);
    seedEmailAuthAttempt(wallet);

    const error = await wallet.completeEmailAuth({ code: '123456' }).catch((e: unknown) => e);

    expectAccountNotFound(error, 'wallet.completeEmailAuth');
    expect(requestCount(fetchMock, '/CreateWallet')).toBe(0);
    expect(wallet.activeWallet).toBeUndefined();
    expect(storage.get(Constants.sessionStorageKey)).toBeNull();
  });

  it('exposes claimable wallets of the requested type on a pending selection and claims one', async () => {
    const storage = new MemoryStorageManager();
    const fetchMock = mockWaas({
      completeAuth: () =>
        completeAuthResponse({
          wallets: [ownedEthereum, ownedSolana],
          claimable: [claimableEthereum, claimableSolana]
        }),
      claimWallet: (body) => {
        expect(body).toEqual({ walletId: 'wallet-claimable-eth' });
        return jsonResponse({ wallet: { ...claimableEthereum } });
      }
    });
    const wallet = createWalletClient(storage);
    seedEmailAuthAttempt(wallet);

    const selection = await wallet.completeEmailAuth({
      code: '123456',
      walletSelection: 'manual'
    });

    expect(selection.wallets).toEqual([account(ownedEthereum)]);
    expect(selection.claimableWallets).toEqual([account(claimableEthereum)]);
    expect(requestCount(fetchMock, '/ClaimWallet')).toBe(0);

    await expect(
      selection.claimAndSelectWallet({ walletId: 'wallet-claimable-sol' })
    ).rejects.toMatchObject({
      code: 'OMS_WALLET_SELECTION_UNAVAILABLE',
      operation: 'wallet.pendingWalletSelection.claimAndSelectWallet'
    });
    await expect(
      selection.claimAndSelectWallet({ walletId: 'wallet-owned-eth' })
    ).rejects.toMatchObject({ code: 'OMS_WALLET_SELECTION_UNAVAILABLE' });
    expect(requestCount(fetchMock, '/ClaimWallet')).toBe(0);

    const activated = await selection.claimAndSelectWallet({ walletId: 'wallet-claimable-eth' });

    expect(activated).toEqual({ wallet: account(claimableEthereum) });
    expect(wallet.activeWallet).toEqual(account(claimableEthereum));
    expect(storedSession(storage)?.wallet).toEqual(account(claimableEthereum));
    await expect(selection.selectWallet({ walletId: 'wallet-owned-eth' })).rejects.toMatchObject({
      code: 'OMS_WALLET_SELECTION_STALE'
    });
  });

  it('keeps a pending selection usable after a rejected claim', async () => {
    const storage = new MemoryStorageManager();
    mockWaas({
      completeAuth: () =>
        completeAuthResponse({ wallets: [ownedEthereum], claimable: [claimableEthereum] }),
      claimWallet: () => accountNotFoundResponse(),
      useWallet: () => jsonResponse({ wallet: { ...ownedEthereum } })
    });
    const wallet = createWalletClient(storage);
    seedEmailAuthAttempt(wallet);
    const selection = await wallet.completeEmailAuth({
      code: '123456',
      walletSelection: 'manual'
    });

    const error = await selection
      .claimAndSelectWallet({ walletId: 'wallet-claimable-eth' })
      .catch((e: unknown) => e);

    expectAccountNotFound(error, 'wallet.pendingWalletSelection.claimAndSelectWallet');
    expect(wallet.activeWallet).toBeUndefined();
    expect(storage.get(Constants.sessionStorageKey)).toBeNull();
    await expect(selection.selectWallet({ walletId: 'wallet-owned-eth' })).resolves.toEqual({
      wallet: account(ownedEthereum)
    });
  });

  it('claimWallet switches the active wallet of an active session', async () => {
    const storage = new MemoryStorageManager();
    const fetchMock = mockWaas({
      claimWallet: (body) => {
        expect(body).toEqual({ walletId: 'wallet-claimable-eth' });
        return jsonResponse({ wallet: { ...claimableEthereum } });
      }
    });
    const wallet = createWalletWithSession(undefined, undefined, { storage });

    const result = await wallet.claimWallet({ walletId: 'wallet-claimable-eth' });

    expect(result).toEqual({ wallet: account(claimableEthereum) });
    expect(wallet.activeWallet).toEqual(account(claimableEthereum));
    expect(storedSession(storage)?.wallet).toEqual(account(claimableEthereum));
    expect(storedSession(storage)).toMatchObject({
      auth: { type: 'email', email: 'user@example.com' },
      expiresAt: '2099-01-01T00:00:00Z'
    });
    expect(requestCount(fetchMock, '/ClaimWallet')).toBe(1);
  });

  it('claimWallet surfaces a rejected claim as a request error and keeps the active wallet', async () => {
    const storage = new MemoryStorageManager();
    mockWaas({ claimWallet: () => accountNotFoundResponse() });
    const wallet = createWalletWithSession(undefined, undefined, { storage });
    const before = storage.get(Constants.sessionStorageKey);

    const error = await wallet
      .claimWallet({ walletId: 'wallet-claimable-eth' })
      .catch((e: unknown) => e);

    expectAccountNotFound(error, 'wallet.claimWallet');
    expect(wallet.activeWallet?.id).toBe('wallet-id');
    expect(storage.get(Constants.sessionStorageKey)).toBe(before);
  });

  it('claimWallet does not persist a claim that resolves after sign-out', async () => {
    const storage = new MemoryStorageManager();
    let resolveClaim!: (response: Response) => void;
    const fetchMock = mockWaas({
      claimWallet: () =>
        new Promise<Response>((resolve) => {
          resolveClaim = resolve;
        })
    });
    const wallet = createWalletWithSession(undefined, undefined, { storage });

    const claim = wallet.claimWallet({ walletId: 'wallet-claimable-eth' });
    await waitForRequest(fetchMock, '/ClaimWallet');
    await wallet.signOut();
    resolveClaim(jsonResponse({ wallet: { ...claimableEthereum } }));

    await expect(claim).rejects.toMatchObject({
      code: 'OMS_SESSION_MISSING',
      operation: 'wallet.claimWallet'
    });
    expect(wallet.activeWallet).toBeUndefined();
    expect(storage.get(Constants.sessionStorageKey)).toBeNull();
  });

  it('claimWallet requires an active session while a manual selection is pending', async () => {
    const fetchMock = mockWaas({
      completeAuth: () => completeAuthResponse({ wallets: [], claimable: [claimableEthereum] })
    });
    const wallet = createWalletClient();
    seedEmailAuthAttempt(wallet);
    await wallet.completeEmailAuth({ code: '123456', walletSelection: 'manual' });

    await expect(wallet.claimWallet({ walletId: 'wallet-claimable-eth' })).rejects.toMatchObject({
      code: 'OMS_SESSION_MISSING',
      operation: 'wallet.claimWallet'
    });
    expect(requestCount(fetchMock, '/ClaimWallet')).toBe(0);
  });
});

type Handler = (body: any) => Response | Promise<Response>;

function mockWaas(handlers: {
  commitVerifier?: Handler;
  completeAuth?: Handler;
  claimWallet?: Handler;
  useWallet?: Handler;
  createWallet?: Handler;
}) {
  const routes: Record<string, Handler | undefined> = {
    '/CommitVerifier': handlers.commitVerifier,
    '/CompleteAuth': handlers.completeAuth,
    '/ClaimWallet': handlers.claimWallet,
    '/UseWallet': handlers.useWallet,
    '/CreateWallet': handlers.createWallet
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const route = Object.keys(routes).find((path) => url.endsWith(path));
    const handler = route ? routes[route] : undefined;
    if (!handler) throw new Error(`Unexpected request: ${url}`);
    return handler(JSON.parse(init?.body as string));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function completeAuthResponse(params: {
  identity?: Record<string, string>;
  wallets: Array<ReturnType<typeof waasWallet>>;
  claimable?: Array<ReturnType<typeof waasWallet>>;
}) {
  return jsonResponse({
    identity: params.identity ?? { type: 'email', sub: 'user@example.com' },
    email: 'user@example.com',
    wallets: params.wallets,
    ...(params.claimable ? { claimable: params.claimable } : {}),
    credential: testCredential()
  });
}

function accountNotFoundResponse(): Response {
  return jsonResponse(
    { error: 'AccountNotFound', code: 7301, msg: 'Account not found', status: 404 },
    404
  );
}

function expectAccountNotFound(error: unknown, operation: string): void {
  expect(error).toBeInstanceOf(OMSWalletRequestError);
  expect(error).toMatchObject({
    code: 'OMS_REQUEST_FAILED',
    operation,
    status: 404,
    retryable: false,
    upstreamError: { service: 'waas', name: 'AccountNotFound', code: '7301' }
  });
}

/** A WaaS wallet body as the generated client decodes it. */
function waasWallet(id: string, type: WalletType, address: string) {
  const networkFamily = { ethereum: 'evm', solana: 'solana', tron: 'tron' }[type];
  return {
    id,
    type,
    networkFamily,
    implementation: 'eoa',
    keyOrigin: 'enclave',
    address
  };
}

function account(wallet: ReturnType<typeof waasWallet>) {
  return {
    id: wallet.id,
    type: wallet.type,
    address: wallet.address,
    reference: undefined,
    keyOrigin: 'enclave'
  };
}

function createWalletClient(storage = new MemoryStorageManager()): WalletClientImpl {
  return new WalletClientImpl({
    publishableKey: 'publishable-key',
    projectId: 'project-id',
    environment: testEnvironment(),
    storage,
    credentialSigner: new MockSigner()
  });
}

function seedEmailAuthAttempt(wallet: WalletClientImpl): void {
  (wallet as any).activeEmailAuthAttempt = {
    email: 'user@example.com',
    verifier: 'verifier-1',
    challenge: 'challenge-1',
    sessionLifetimeSeconds: 604_800
  };
}

function storedSession(storage: MemoryStorageManager): Record<string, any> | null {
  return JSON.parse(storage.get(Constants.sessionStorageKey) ?? 'null');
}

function fakeJwt(payload: Record<string, unknown>): string {
  return [
    base64UrlEncodeString(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    base64UrlEncodeString(JSON.stringify(payload)),
    'signature'
  ].join('.');
}
