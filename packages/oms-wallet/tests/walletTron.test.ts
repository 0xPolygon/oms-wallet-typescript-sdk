import { afterEach, describe, expect, it, vi } from 'vitest';

import { WalletClientImpl } from '../src/clients/walletClient';
import { Networks, TronNetworks } from '../src/networks';
import { MemoryStorageManager } from '../src/storageManager';
import { FeeOptionSelector } from '../src/types/transactionTypes';
import { TransactionStatus, WalletType } from '../src/types/waas';
import { testWalletAccount } from './fixtures/walletAccount.js';
import { MockSigner, jsonResponse } from './fixtures/helpers.js';

const tronWalletAddress = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL';
const tronWalletHex = '0x8840e6c55b9ada326d211d818c34a994aeced808';
const tronRecipient = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const tronUsdt = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WalletClient Tron', () => {
  it('sends a plain TRX transfer without a data field in native mode', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);

      if (url.endsWith('/PrepareTronTransaction')) {
        expect(body).toEqual({
          network: 'tron:nile',
          walletId: 'wallet-id',
          to: tronRecipient,
          value: '1000000',
          mode: 'native'
        });
        expect(body).not.toHaveProperty('data');
        return jsonResponse(sponsoredPrepareResponse('txn-trx'));
      }
      if (url.endsWith('/Execute')) {
        expect(body).toEqual({ txnId: 'txn-trx' });
        return jsonResponse({ status: 'pending' });
      }
      if (url.endsWith('/TransactionStatus')) {
        return jsonResponse({ status: 'executed', txnHash: 'tron-txid' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const wallet = createTronWalletWithSession();

    await expect(
      wallet.sendTronTransaction({
        network: TronNetworks.nile,
        to: tronRecipient,
        value: 1_000_000n
      })
    ).resolves.toEqual({
      txnId: 'txn-trx',
      status: TransactionStatus.Executed,
      txnHash: 'tron-txid',
      statusResolution: 'resolved'
    });
  });

  it("forwards data: '0x' as a contract call to the payable fallback", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);

      if (url.endsWith('/PrepareTronTransaction')) {
        expect(body).toEqual({
          network: 'tron:nile',
          walletId: 'wallet-id',
          to: tronUsdt,
          value: '0',
          data: '0x',
          mode: 'native'
        });
        return jsonResponse(sponsoredPrepareResponse('txn-fallback'));
      }
      if (url.endsWith('/Execute')) {
        return jsonResponse({ status: 'pending' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const wallet = createTronWalletWithSession();

    await expect(
      wallet.sendTronTransaction({
        network: TronNetworks.nile,
        to: tronUsdt,
        data: '0x',
        waitForStatus: false
      })
    ).resolves.toMatchObject({ txnId: 'txn-fallback', status: TransactionStatus.Pending });
  });

  it('prepares a TRC-20 contract call through the wallet service ABI encoder', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);

      if (url.endsWith('/PrepareTronContractCall')) {
        expect(body).toEqual({
          network: 'tron:mainnet',
          walletId: 'wallet-id',
          contract: tronUsdt,
          method: 'transfer',
          args: [
            { type: 'address', value: tronRecipient },
            { type: 'uint256', value: '1000000' }
          ],
          mode: 'native'
        });
        return jsonResponse(sponsoredPrepareResponse('txn-trc20'));
      }
      if (url.endsWith('/Execute')) {
        return jsonResponse({ status: 'pending' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const wallet = createTronWalletWithSession();

    await expect(
      wallet.callTronContract({
        network: TronNetworks.mainnet,
        contractAddress: tronUsdt,
        method: 'transfer',
        args: [
          { type: 'address', value: tronRecipient },
          { type: 'uint256', value: '1000000' }
        ],
        waitForStatus: false
      })
    ).resolves.toMatchObject({ txnId: 'txn-trc20' });
  });

  it('rejects a full function signature as the contract method before any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createTronWalletWithSession().callTronContract({
        network: TronNetworks.nile,
        contractAddress: tronUsdt,
        method: 'transfer(address,uint256)',
        args: [{ type: 'uint256', value: '1' }]
      })
    ).rejects.toMatchObject({ code: 'OMS_VALIDATION_ERROR', operation: 'wallet.callTronContract' });
    await expect(
      createWalletWithSession('0x9999999999999999999999999999999999999999').callContract({
        network: Networks.polygon,
        contractAddress: '0x1111111111111111111111111111111111111111',
        method: 'transfer(address,uint256)'
      })
    ).rejects.toMatchObject({ code: 'OMS_VALIDATION_ERROR', operation: 'wallet.callContract' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('acknowledges a sponsored Tron transaction with an empty fee option list', async () => {
    const selectFeeOption = vi.fn(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.endsWith('/PrepareTronTransaction')) {
          return jsonResponse(sponsoredPrepareResponse('txn-sponsored'));
        }
        if (url.endsWith('/Execute')) {
          expect(JSON.parse(init?.body as string)).toEqual({ txnId: 'txn-sponsored' });
          return jsonResponse({ status: 'pending' });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const wallet = createTronWalletWithSession();
    await wallet.sendTronTransaction({
      network: TronNetworks.nile,
      to: tronRecipient,
      value: 1n,
      selectFeeOption,
      waitForStatus: false
    });

    expect(selectFeeOption).toHaveBeenCalledWith([]);
  });

  it('firstAvailable pays an unsponsored Tron fee using the TRX balance', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);

      if (url.endsWith('/PrepareTronTransaction')) {
        return jsonResponse({
          txnId: 'txn-burn',
          status: 'quoted',
          feeOptions: [
            {
              token: { network: 'tron:nile', name: 'TRX', symbol: 'TRX', type: 'NATIVE' },
              value: '345000',
              displayValue: '0.345'
            }
          ],
          sponsored: false,
          expiresAt: '2099-01-01T00:00:00Z'
        });
      }
      if (url === 'https://tron-indexer.example/GetTokenBalancesDetails') {
        expect(body).toEqual({
          networks: ['tron:nile'],
          filter: { accountAddresses: [tronWalletAddress], omitNativeBalances: false },
          omitMetadata: true
        });
        return jsonResponse({
          balances: [
            {
              network: 'tron:nile',
              accountAddress: tronWalletAddress,
              assetType: 'native',
              name: 'Tron',
              symbol: 'TRX',
              decimals: 6,
              balance: '2000000',
              formattedBalance: '2',
              verificationStatus: 'unknown',
              verificationSource: 'none'
            }
          ],
          errors: []
        });
      }
      if (url.endsWith('/Execute')) {
        expect(body).toEqual({ txnId: 'txn-burn', feeOption: { token: 'TRX', index: 0 } });
        return jsonResponse({ status: 'pending' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const wallet = createTronWalletWithSession();
    const selectFeeOption = vi.fn((options: Parameters<FeeOptionSelector>[0]) => {
      expect(options[0]).toMatchObject({ availableRaw: '2000000', available: '2', decimals: 6 });
      return FeeOptionSelector.firstAvailable(options);
    });

    await expect(
      wallet.sendTronTransaction({
        network: TronNetworks.nile,
        to: tronRecipient,
        value: 1_000_000n,
        selectFeeOption,
        waitForStatus: false
      })
    ).resolves.toMatchObject({ txnId: 'txn-burn' });
    expect(selectFeeOption).toHaveBeenCalledOnce();
  });

  it('signs Tron messages and typed data without an EVM network', async () => {
    const bodies: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        bodies[url.slice(url.lastIndexOf('/') + 1)] = JSON.parse(init?.body as string);
        return jsonResponse({ signature: '0xtron-signature' });
      })
    );

    const wallet = createTronWalletWithSession();
    const typedData = {
      domain: { name: 'Example', chainId: 3448148188n, verifyingContract: tronUsdt },
      types: { Mail: [{ name: 'to', type: 'address' }] },
      primaryType: 'Mail',
      message: { to: tronRecipient }
    };

    await expect(wallet.signTronMessage({ message: 'hello' })).resolves.toBe('0xtron-signature');
    await expect(wallet.signTronTypedData({ typedData })).resolves.toBe('0xtron-signature');
    expect(bodies.SignMessage).toEqual({ network: '', walletId: 'wallet-id', message: 'hello' });
    expect(bodies.SignTypedData).toEqual({
      network: '',
      walletId: 'wallet-id',
      typedData: { ...typedData, domain: { ...typedData.domain, chainId: '3448148188' } }
    });
  });

  it('validates Tron signatures with the tron network family', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string));
        return jsonResponse({ isValid: true });
      })
    );

    const wallet = createTronWalletWithSession();

    await expect(
      wallet.isValidTronMessageSignature({
        walletAddress: tronWalletAddress,
        message: 'hello',
        signature: '0xsig'
      })
    ).resolves.toBe(true);
    await expect(
      wallet.isValidTronTypedDataSignature({
        typedData: { primaryType: 'Mail' },
        signature: '0xsig'
      })
    ).resolves.toBe(true);
    expect(bodies).toEqual([
      {
        networkFamily: 'tron',
        walletAddress: tronWalletAddress,
        message: 'hello',
        signature: '0xsig'
      },
      {
        networkFamily: 'tron',
        walletAddress: tronWalletAddress,
        typedData: { primaryType: 'Mail' },
        signature: '0xsig'
      }
    ]);
  });

  it('rejects Tron operations for an active Ethereum or Solana wallet before any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const address of [
      '0x9999999999999999999999999999999999999999',
      '4Nd1mYQbqjVU2aR7cJNPyqW9XjHnBYvWQd7ZxYxvT6uP'
    ]) {
      const wallet = createWalletWithSession(address);
      await expect(
        wallet.sendTronTransaction({ network: TronNetworks.nile, to: tronRecipient, value: 1n })
      ).rejects.toMatchObject({
        code: 'OMS_VALIDATION_ERROR',
        operation: 'wallet.sendTronTransaction'
      });
      await expect(wallet.signTronMessage({ message: 'hello' })).rejects.toMatchObject({
        code: 'OMS_VALIDATION_ERROR',
        operation: 'wallet.signTronMessage'
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects EVM and Solana operations for an active Tron wallet before any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const wallet = createTronWalletWithSession();

    await expect(
      wallet.sendTransaction({ network: Networks.polygon, to: tronWalletHex, value: 1n })
    ).rejects.toMatchObject({ code: 'OMS_VALIDATION_ERROR', operation: 'wallet.sendTransaction' });
    await expect(
      wallet.signMessage({ network: Networks.polygon, message: 'hello' })
    ).rejects.toMatchObject({ code: 'OMS_VALIDATION_ERROR', operation: 'wallet.signMessage' });
    await expect(wallet.signSolanaMessage({ message: 'hello' })).rejects.toMatchObject({
      code: 'OMS_VALIDATION_ERROR',
      operation: 'wallet.signSolanaMessage'
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates and activates a Tron wallet through the tron network family', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        expect(url.endsWith('/CreateWallet')).toBe(true);
        expect(JSON.parse(init?.body as string)).toMatchObject({ networkFamily: 'tron' });
        return jsonResponse({
          wallet: {
            id: 'wallet-tron',
            address: tronWalletAddress,
            networkFamily: 'tron',
            keyOrigin: 'enclave'
          }
        });
      })
    );
    const wallet = createWalletWithSession('0x9999999999999999999999999999999999999999');

    const result = await wallet.createWallet({ walletType: WalletType.Tron });

    const expected = {
      id: 'wallet-tron',
      type: 'tron',
      address: tronWalletAddress,
      reference: undefined,
      keyOrigin: 'enclave'
    };
    expect(result).toEqual({ wallet: expected });
    expect(wallet.activeWallet).toEqual(expected);
  });
});

function sponsoredPrepareResponse(txnId: string) {
  return {
    txnId,
    status: 'quoted',
    feeOptions: [],
    sponsored: true,
    expiresAt: '2099-01-01T00:00:00Z'
  };
}

function createTronWalletWithSession(): WalletClientImpl {
  return createWalletWithSession(tronWalletAddress, 'tron');
}

function createWalletWithSession(
  walletAddress: string,
  type?: 'ethereum' | 'solana' | 'tron'
): WalletClientImpl {
  const wallet = new WalletClientImpl({
    publishableKey: 'publishable-key',
    projectId: 'project-id',
    environment: {
      walletApiUrl: 'https://wallet.example',
      indexerGatewayUrl: 'https://indexer.example',
      solanaIndexerGatewayUrl: 'https://solana-indexer.example',
      tronIndexerGatewayUrl: 'https://tron-indexer.example'
    },
    storage: new MemoryStorageManager(),
    credentialSigner: new MockSigner()
  });
  (wallet as any).persistSession(testWalletAccount('wallet-id', walletAddress, type), {
    expiresAt: '2099-01-01T00:00:00Z',
    auth: { type: 'email', email: 'user@example.com' },
    signerCredentialId: '0x04' + '11'.repeat(64),
    signerKeyType: 'ecdsa-p256-sha256'
  });
  return wallet;
}
