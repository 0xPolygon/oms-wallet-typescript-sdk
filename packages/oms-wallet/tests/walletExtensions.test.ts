import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringToHex } from 'viem';

import {
  type FeeOptionSelector,
  Networks,
  OMSWallet,
  OMSWalletSessionError,
  OMSWalletValidationError
} from '../src';
import { MemoryStorageManager } from '../src/storageManager';
import {
  MockSigner,
  createWalletWithSession,
  jsonResponse,
  requestCount,
  testExpiryBounds
} from './fixtures/helpers.js';
import { testWalletAccount } from './fixtures/walletAccount.js';

const walletAddress = '0x1111111111111111111111111111111111111111';
const otherAddress = '0x2222222222222222222222222222222222222222';
const reservedMessage = 'OMS Wallet reserved message: test key v1';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function signingFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.endsWith('/SignMessage')) {
      const body = JSON.parse(init?.body as string);
      return jsonResponse({ signature: `signed:${body.walletId}:${body.message}` });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function omsWithSession(): OMSWallet {
  const oms = new OMSWallet({
    publishableKey: 'pk_dev_sdbx_project_key',
    storage: new MemoryStorageManager(),
    credentialSigner: new MockSigner()
  });
  const expiresAt = '2099-01-01T00:00:00Z';
  (oms.wallet as any).persistSession(testWalletAccount('wallet-id', walletAddress), {
    expiresAt,
    auth: { type: 'email', email: 'user@example.com' },
    signerCredentialId: '0x04' + '11'.repeat(64),
    signerKeyType: 'ecdsa-p256-sha256',
    expiryBounds: testExpiryBounds(expiresAt)
  });
  return oms;
}

describe('reserved messages', () => {
  it('refuses reserved messages in signMessage, as text or hex, without a request', async () => {
    const fetchMock = signingFetch();
    const wallet = createWalletWithSession(walletAddress);

    for (const message of [
      reservedMessage,
      stringToHex(reservedMessage),
      // Invalid UTF-8 after the prefix.
      `${stringToHex(reservedMessage)}ff` as const
    ]) {
      await expect(wallet.signMessage({ network: Networks.polygon, message })).rejects.toThrow(
        OMSWalletValidationError
      );
    }
    expect(requestCount(fetchMock, 'SignMessage')).toBe(0);
  });

  it('signs reserved messages through the extension context only', async () => {
    signingFetch();
    let signed: Promise<string> | undefined;
    const oms = omsWithSession().extend((_oms, context) => {
      signed = context.signReservedMessage({ network: Networks.polygon, message: reservedMessage });
      return { probe: true };
    });

    expect(oms.probe).toBe(true);
    await expect(signed).resolves.toBe(`signed:wallet-id:${reservedMessage}`);
  });

  it('refuses ordinary messages through the extension context', async () => {
    signingFetch();
    let signed: Promise<string> | undefined;
    omsWithSession().extend((_oms, context) => {
      signed = context.signReservedMessage({ network: Networks.polygon, message: 'hello' });
      return {};
    });

    await expect(signed).rejects.toThrow(OMSWalletValidationError);
  });
});

describe('wallet binding', () => {
  it('fails, without a request, when another wallet becomes active while the call waits', async () => {
    const fetchMock = signingFetch();
    const calls = [
      (wallet: ReturnType<typeof createWalletWithSession>) =>
        wallet.signMessage({ network: Networks.polygon, message: 'hello' }),
      (wallet: ReturnType<typeof createWalletWithSession>) =>
        wallet.signTypedData({ network: Networks.polygon, typedData: {} }),
      (wallet: ReturnType<typeof createWalletWithSession>) =>
        wallet.sendTransaction({ network: Networks.polygon, to: otherAddress, value: 1n })
    ];

    for (const call of calls) {
      const wallet = createWalletWithSession(walletAddress);
      const pending = call(wallet);
      // Switch before the call's session check finishes.
      (wallet as any).activeWalletAccount = testWalletAccount('other-id', otherAddress);
      await expect(pending).rejects.toThrow(OMSWalletSessionError);
      await expect(pending).rejects.toThrow('Active wallet session changed');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the arguments as they were when the call was made', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        bodies.push(JSON.parse(init?.body as string));
        if (url.endsWith('/SignMessage')) return jsonResponse({ signature: '0x01' });
        throw new Error('stop after the first request');
      })
    );
    const wallet = createWalletWithSession(walletAddress);
    const message = { network: Networks.polygon, message: 'ordinary' };
    const signing = wallet.signMessage(message);
    message.message = reservedMessage;
    await signing;
    const transaction = { network: Networks.polygon, to: otherAddress, value: 1n };
    const sending = wallet.sendTransaction(transaction);
    transaction.to = walletAddress;
    transaction.value = 2n;
    await sending.catch(() => undefined);

    expect(bodies[0]).toMatchObject({ message: 'ordinary' });
    expect(bodies[1]).toMatchObject({ to: otherAddress, value: '1' });
  });

  it('signs for the wallet active when the call was made', async () => {
    signingFetch();
    const wallet = createWalletWithSession(walletAddress);

    await expect(wallet.signMessage({ network: Networks.polygon, message: 'hello' })).resolves.toBe(
      'signed:wallet-id:hello'
    );
  });
});

describe('onPrepared', () => {
  function transactionFetch(order: string[]) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith('/PrepareEthereumTransaction')) {
        order.push('prepare');
        return jsonResponse({
          txnId: 'txn-1',
          status: 'quoted',
          feeOptions: [],
          sponsored: true,
          expiresAt: '2099-01-01T00:00:00Z'
        });
      }
      if (url.endsWith('/Execute')) {
        order.push('execute');
        return jsonResponse({ status: 'pending' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('reports the transaction ID after Prepare and before Execute', async () => {
    const order: string[] = [];
    transactionFetch(order);
    const wallet = createWalletWithSession(walletAddress);

    await wallet.sendTransaction({
      network: Networks.polygon,
      to: otherAddress,
      value: 1n,
      waitForStatus: false,
      onPrepared: (txnId) => {
        order.push(`prepared:${txnId}`);
      }
    });

    expect(order).toEqual(['prepare', 'prepared:txn-1', 'execute']);
  });

  it('shows fee balances of the call wallet and stops before Execute after a switch', async () => {
    const indexerBodies: Array<Record<string, any>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/PrepareEthereumTransaction')) {
        return jsonResponse({
          txnId: 'txn-1',
          status: 'quoted',
          feeOptions: [
            {
              token: { network: '137', name: 'POL', symbol: 'POL', type: 'NATIVE' },
              value: '1',
              displayValue: '0.000000000000000001'
            }
          ],
          sponsored: false,
          expiresAt: '2099-01-01T00:00:00Z'
        });
      }
      if (url.endsWith('/GetTokenBalancesDetails')) {
        indexerBodies.push(JSON.parse(init?.body as string));
        return jsonResponse({
          page: { page: 0, pageSize: 40, more: false },
          nativeBalances: [],
          balances: []
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wallet = createWalletWithSession(walletAddress);
    const network = { ...Networks.polygon };
    const selectFeeOption = vi.fn(
      (options: Parameters<FeeOptionSelector>[0]) => options[0]!.selection
    );

    await expect(
      wallet.sendTransaction({
        network,
        to: otherAddress,
        value: 1n,
        selectFeeOption,
        onPrepared: () => {
          (wallet as any).activeWalletAccount = testWalletAccount('other-id', otherAddress);
          network.id = Networks.mainnet.id;
        }
      })
    ).rejects.toThrow('Active wallet session changed');
    expect(indexerBodies[0]).toMatchObject({
      chainIds: [137],
      filter: { accountAddresses: [walletAddress] }
    });
    expect(selectFeeOption).toHaveBeenCalledOnce();
    expect(requestCount(fetchMock, 'Execute')).toBe(0);
  });

  it('stops the transaction before Execute when the callback throws', async () => {
    const order: string[] = [];
    const fetchMock = transactionFetch(order);
    const wallet = createWalletWithSession(walletAddress);

    await expect(
      wallet.sendTransaction({
        network: Networks.polygon,
        to: otherAddress,
        value: 1n,
        onPrepared: () => {
          throw new Error('cannot persist');
        }
      })
    ).rejects.toThrow('cannot persist');
    expect(requestCount(fetchMock, 'Execute')).toBe(0);
  });
});

describe('OMSWallet.extend', () => {
  it('returns an extended OMSWallet without changing the original', () => {
    const base = new OMSWallet({ publishableKey: 'pk_dev_sdbx_project_key' });
    const extended = base.extend(() => ({ a: 1 }));

    expect(extended).toBeInstanceOf(OMSWallet);
    expect(extended.a).toBe(1);
    expect(extended.wallet).toBe(base.wallet);
    expect(extended.indexer).toBe(base.indexer);
    expect('a' in base).toBe(false);
  });

  it('chains extensions', () => {
    const oms = new OMSWallet({ publishableKey: 'pk_dev_sdbx_project_key' })
      .extend(() => ({ a: 1 }))
      .extend((inner) => ({ b: (inner as OMSWallet & { a: number }).a + 1 }));

    expect(oms.a).toBe(1);
    expect(oms.b).toBe(2);
  });

  it('adds several extensions in order, like chained calls', () => {
    const seen: unknown[] = [];
    const oms = new OMSWallet({ publishableKey: 'pk_dev_sdbx_project_key' }).extend(
      () => ({ a: 1 }),
      (inner) => {
        seen.push((inner as OMSWallet & { a: number }).a);
        return { b: 2 };
      }
    );

    expect(seen).toEqual([1]);
    expect(oms.a).toBe(1);
    expect(oms.b).toBe(2);
    expect(oms).toBeInstanceOf(OMSWallet);
  });

  it('refuses a repeated member within one call and an empty call', () => {
    const base = new OMSWallet({ publishableKey: 'pk_dev_sdbx_project_key' });
    const extend = base.extend.bind(base) as (...extensions: unknown[]) => unknown;

    expect(() =>
      extend(
        () => ({ a: 1 }),
        () => ({ a: 2 })
      )
    ).toThrow('"a" is already added to this OMSWallet by an extension. Add each extension once.');
    expect(() => extend()).toThrow('Pass at least one OMSWallet extension');
    expect('a' in base).toBe(false);
  });

  it('refuses reserved and existing members', () => {
    const base = new OMSWallet({ publishableKey: 'pk_dev_sdbx_project_key' }).extend(() => ({
      a: 1
    }));

    for (const key of ['wallet', 'indexer', 'extend']) {
      expect(() => base.extend(() => ({ [key]: 1 }) as object)).toThrow(OMSWalletValidationError);
    }
    expect(() => base.extend(() => ({ a: 2 }) as object)).toThrow(OMSWalletValidationError);
    expect(() => base.extend(() => ({ toString: 1 }) as object)).toThrow(
      'An OMSWallet extension cannot replace "toString"'
    );
  });

  it('refuses class instances, whose prototype methods would be lost', () => {
    class Plugin {
      run() {
        return 1;
      }
    }
    expect(() =>
      new OMSWallet({ publishableKey: 'pk_dev_sdbx_project_key' }).extend(() => new Plugin())
    ).toThrow('An OMSWallet extension must return a plain object, not a class instance');
    const bare = Object.assign(Object.create(null) as object, { run: () => 1 });
    expect(
      new OMSWallet({ publishableKey: 'pk_dev_sdbx_project_key' }).extend(() => bare).run()
    ).toBe(1);
  });

  it('checks and adds one snapshot of the members', () => {
    let calls = 0;
    const shifty = new Proxy(
      {},
      {
        ownKeys: () => (calls++ === 0 ? [] : ['wallet']),
        getOwnPropertyDescriptor: () => ({
          value: 'replaced',
          enumerable: true,
          configurable: true,
          writable: true
        })
      }
    );
    const base = new OMSWallet({ publishableKey: 'pk_dev_sdbx_project_key' });
    const extended = base.extend(() => shifty);
    expect(extended.wallet).toBe(base.wallet);
  });

  it('keeps getters as getters', () => {
    let count = 1;
    const oms = new OMSWallet({ publishableKey: 'pk_dev_sdbx_project_key' }).extend(() => ({
      get count() {
        return count;
      }
    }));
    count = 2;
    expect(oms.count).toBe(2);
  });

  it('names the member when the same extension is added twice', () => {
    const counter = () => () => ({ counter: { value: 1 } });
    const once = new OMSWallet({ publishableKey: 'pk_dev_sdbx_project_key' }).extend(counter());
    const later = once.extend(() => ({ other: 1 }));

    for (const oms of [once, later]) {
      expect(() => oms.extend(counter() as () => object)).toThrow(
        '"counter" is already added to this OMSWallet by an extension. Add each extension once.'
      );
    }
  });
});
