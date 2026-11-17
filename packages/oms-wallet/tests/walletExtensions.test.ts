import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringToHex } from 'viem';

import { Networks, OMSWallet, OMSWalletSessionError, OMSWalletValidationError } from '../src';
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

    for (const message of [reservedMessage, stringToHex(reservedMessage)]) {
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

  it('refuses reserved and existing members', () => {
    const base = new OMSWallet({ publishableKey: 'pk_dev_sdbx_project_key' }).extend(() => ({
      a: 1
    }));

    for (const key of ['wallet', 'indexer', 'extend']) {
      expect(() => base.extend(() => ({ [key]: 1 }) as object)).toThrow(OMSWalletValidationError);
    }
    expect(() => base.extend(() => ({ a: 2 }) as object)).toThrow(OMSWalletValidationError);
  });
});
