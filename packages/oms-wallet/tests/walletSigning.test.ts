import { afterEach, describe, expect, it, vi } from 'vitest';

import { WalletClientImpl } from '../src/clients/walletClient';
import { WalletOperation } from '../src/index';
import { Networks } from '../src/networks';
import { MemoryStorageManager } from '../src/storageManager';
import { testWalletAccount } from './fixtures/walletAccount.js';
import { MockSigner, jsonResponse, testEnvironment } from './fixtures/helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WalletClient signing', () => {
  it('gets an ID token for the active wallet session', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);
      const headers = init?.headers as Record<string, string>;

      expect(headers['Api-Key']).toBe('publishable-key');
      expect(headers['OMS-Wallet-Signature']).toContain('alg="ecdsa-p256-sha256"');
      expect(headers.Authorization).toBeUndefined();

      if (url.endsWith('/GetIDToken')) {
        expect(body).toEqual({
          walletId: 'wallet-id',
          ttlSeconds: 300,
          customClaims: { role: 'admin' }
        });
        return jsonResponse({ idToken: 'jwt-token' });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const wallet = createWalletWithSession('0x1111111111111111111111111111111111111111');

    await expect(
      wallet.getIdToken({
        ttlSeconds: 300,
        customClaims: { role: 'admin' }
      })
    ).resolves.toBe('jwt-token');
  });

  it('signs typed data through the generated wallet client', async () => {
    const typedData = {
      domain: { name: 'Test', chainId: 137n },
      types: {
        Message: [
          { name: 'contents', type: 'string' },
          { name: 'amount', type: 'uint256' },
          { name: 'ids', type: 'uint256[]' }
        ]
      },
      message: {
        contents: 'hello',
        amount: 12345678901234567890n,
        ids: [1n, 2n]
      },
      primaryType: 'Message'
    };
    const serializedTypedData = {
      domain: { name: 'Test', chainId: '137' },
      types: {
        Message: [
          { name: 'contents', type: 'string' },
          { name: 'amount', type: 'uint256' },
          { name: 'ids', type: 'uint256[]' }
        ]
      },
      message: {
        contents: 'hello',
        amount: '12345678901234567890',
        ids: ['1', '2']
      },
      primaryType: 'Message'
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);

      expect((init?.headers as Record<string, string>)['Api-Key']).toBe('publishable-key');
      const headers = init?.headers as Record<string, string>;
      expect(headers['OMS-Wallet-Signature']).toContain('alg="ecdsa-p256-sha256"');
      expect(headers.Authorization).toBeUndefined();

      if (url.endsWith('/SignTypedData')) {
        expect(body).toEqual({
          network: '137',
          walletId: 'wallet-id',
          typedData: serializedTypedData
        });
        return jsonResponse({ signature: '0xsigned' });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const wallet = createWalletWithSession('0x1111111111111111111111111111111111111111');

    await expect(wallet.signTypedData({ network: Networks.polygon, typedData })).resolves.toBe(
      '0xsigned'
    );
  });

  it('validates signatures through the generated wallet public client', async () => {
    const typedData = {
      domain: { name: 'Test', chainId: 137n },
      types: {
        Message: [
          { name: 'contents', type: 'string' },
          { name: 'amount', type: 'uint256' }
        ]
      },
      message: { contents: 'hello', amount: 12345678901234567890n },
      primaryType: 'Message'
    };
    const serializedTypedData = {
      domain: { name: 'Test', chainId: '137' },
      types: {
        Message: [
          { name: 'contents', type: 'string' },
          { name: 'amount', type: 'uint256' }
        ]
      },
      message: { contents: 'hello', amount: '12345678901234567890' },
      primaryType: 'Message'
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);
      const headers = init?.headers as Record<string, string>;

      expect(headers['Api-Key']).toBe('publishable-key');
      expect(headers['OMS-Wallet-Signature']).toBeUndefined();
      expect(headers.Authorization).toBeUndefined();

      if (url.endsWith('/IsValidMessageSignature')) {
        expect(body).toEqual({
          network: '137',
          networkFamily: 'evm',
          walletAddress: '0x1111111111111111111111111111111111111111',
          message: 'hello',
          signature: '0xmessage'
        });
        return jsonResponse({ isValid: true });
      }

      if (url.endsWith('/IsValidTypedDataSignature')) {
        expect(body).toEqual({
          network: '137',
          networkFamily: 'evm',
          walletAddress: '0x1111111111111111111111111111111111111111',
          typedData: serializedTypedData,
          signature: '0xtyped'
        });
        return jsonResponse({ isValid: false });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const wallet = createWalletWithSession('0x1111111111111111111111111111111111111111');

    await expect(
      wallet.isValidMessageSignature({
        network: Networks.polygon,
        message: 'hello',
        signature: '0xmessage'
      })
    ).resolves.toBe(true);

    await expect(
      wallet.isValidTypedDataSignature({
        network: Networks.polygon,
        walletAddress: '0x1111111111111111111111111111111111111111',
        typedData,
        signature: '0xtyped'
      })
    ).resolves.toBe(false);
  });

  it('validates Solana message signatures through the generated wallet public client', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(init?.body as string);
      const headers = init?.headers as Record<string, string>;

      expect(headers['Api-Key']).toBe('publishable-key');
      expect(headers['OMS-Wallet-Signature']).toBeUndefined();
      expect(headers.Authorization).toBeUndefined();

      if (url.endsWith('/IsValidMessageSignature')) {
        expect(body).toEqual({
          networkFamily: 'solana',
          walletAddress: '9xQeWvG816bUx9EPjHmaT23yvVMuZwHngkQF5JC9YjCy',
          message: 'hello solana',
          signature: 'base58-signature'
        });
        return jsonResponse({ isValid: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const wallet = createWalletWithSession('9xQeWvG816bUx9EPjHmaT23yvVMuZwHngkQF5JC9YjCy');

    await expect(
      wallet.isValidSolanaMessageSignature({
        walletAddress: '9xQeWvG816bUx9EPjHmaT23yvVMuZwHngkQF5JC9YjCy',
        message: 'hello solana',
        signature: 'base58-signature'
      })
    ).resolves.toBe(true);
  });
});

describe('WalletClient signature verification target', () => {
  const ethereumAddress = '0x1111111111111111111111111111111111111111';
  const solanaAddress = '9xQeWvG816bUx9EPjHmaT23yvVMuZwHngkQF5JC9YjCy';
  const tronAddress = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL';

  type VerificationCall = {
    label: keyof typeof WalletOperation;
    walletType: 'ethereum' | 'solana' | 'tron';
    path: string;
    networkFamily: string;
    verify: (wallet: WalletClientImpl, walletAddress?: string) => Promise<boolean>;
  };

  const verificationCalls: VerificationCall[] = [
    {
      label: 'isValidMessageSignature',
      walletType: 'ethereum',
      path: '/IsValidMessageSignature',
      networkFamily: 'evm',
      verify: (wallet, walletAddress) =>
        wallet.isValidMessageSignature({
          walletAddress: walletAddress as `0x${string}` | undefined,
          message: 'hello',
          signature: '0xsig'
        })
    },
    {
      label: 'isValidTypedDataSignature',
      walletType: 'ethereum',
      path: '/IsValidTypedDataSignature',
      networkFamily: 'evm',
      verify: (wallet, walletAddress) =>
        wallet.isValidTypedDataSignature({
          walletAddress: walletAddress as `0x${string}` | undefined,
          typedData: { primaryType: 'Mail' },
          signature: '0xsig'
        })
    },
    {
      label: 'isValidSolanaMessageSignature',
      walletType: 'solana',
      path: '/IsValidMessageSignature',
      networkFamily: 'solana',
      verify: (wallet, walletAddress) =>
        wallet.isValidSolanaMessageSignature({
          walletAddress,
          message: 'hello',
          signature: 'base58-signature'
        })
    },
    {
      label: 'isValidTronMessageSignature',
      walletType: 'tron',
      path: '/IsValidMessageSignature',
      networkFamily: 'tron',
      verify: (wallet, walletAddress) =>
        wallet.isValidTronMessageSignature({
          walletAddress,
          message: 'hello',
          signature: '0xsig'
        })
    },
    {
      label: 'isValidTronTypedDataSignature',
      walletType: 'tron',
      path: '/IsValidTypedDataSignature',
      networkFamily: 'tron',
      verify: (wallet, walletAddress) =>
        wallet.isValidTronTypedDataSignature({
          walletAddress,
          typedData: { primaryType: 'Mail' },
          signature: '0xsig'
        })
    }
  ];

  const addressFor = {
    ethereum: ethereumAddress,
    solana: solanaAddress,
    tron: tronAddress
  } as const;

  function recordVerificationRequests() {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['Api-Key']).toBe('publishable-key');
      expect(headers['OMS-Wallet-Signature']).toBeUndefined();
      requests.push({ url: input.toString(), body: JSON.parse(init?.body as string) });
      return jsonResponse({ isValid: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, requests };
  }

  it.each(verificationCalls)(
    '$label verifies a given address while signed out without walletId',
    async ({ walletType, path, networkFamily, verify }) => {
      const { requests } = recordVerificationRequests();
      const wallet = createSignedOutWallet();

      await expect(verify(wallet, addressFor[walletType])).resolves.toBe(true);

      expect(requests).toHaveLength(1);
      expect(requests[0].url.endsWith(path)).toBe(true);
      expect(requests[0].body).toMatchObject({
        networkFamily,
        walletAddress: addressFor[walletType]
      });
      expect(requests[0].body).not.toHaveProperty('walletId');
    }
  );

  it.each(verificationCalls)(
    '$label sends the active wallet address when walletAddress is omitted',
    async ({ walletType, path, networkFamily, verify }) => {
      const { requests } = recordVerificationRequests();
      const wallet = createWalletWithSession(addressFor[walletType], walletType);

      await expect(verify(wallet)).resolves.toBe(true);

      expect(requests).toHaveLength(1);
      expect(requests[0].url.endsWith(path)).toBe(true);
      expect(requests[0].body).toMatchObject({
        networkFamily,
        walletAddress: addressFor[walletType]
      });
      expect(requests[0].body).not.toHaveProperty('walletId');
    }
  );

  it.each(verificationCalls)(
    '$label rejects an omitted walletAddress without a session before any request',
    async ({ label, verify }) => {
      const { fetchMock } = recordVerificationRequests();
      const wallet = createSignedOutWallet();

      await expect(verify(wallet)).rejects.toMatchObject({
        name: 'OMSWalletSessionError',
        code: 'OMS_SESSION_MISSING',
        operation: WalletOperation[label]
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each(verificationCalls)(
    '$label rejects an omitted walletAddress for an expired session before any request',
    async ({ label, walletType, verify }) => {
      const { fetchMock } = recordVerificationRequests();
      const wallet = createWalletWithSession(
        addressFor[walletType],
        walletType,
        '2000-01-01T00:00:00Z'
      );

      await expect(verify(wallet)).rejects.toMatchObject({
        name: 'OMSWalletSessionError',
        code: 'OMS_SESSION_EXPIRED',
        operation: `wallet.${label}`
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(wallet.activeWallet).toBeUndefined();
    }
  );

  it.each(
    verificationCalls.flatMap((call) =>
      ['', '   '].map((walletAddress) => ({
        ...call,
        walletAddress,
        description: walletAddress ? 'a whitespace-only' : 'an empty'
      }))
    )
  )(
    '$label rejects $description walletAddress before any request',
    async ({ label, walletType, walletAddress, verify }) => {
      const { fetchMock } = recordVerificationRequests();
      const wallet = createWalletWithSession(addressFor[walletType], walletType);

      await expect(verify(wallet, walletAddress)).rejects.toMatchObject({
        name: 'OMSWalletValidationError',
        code: 'OMS_VALIDATION_ERROR',
        operation: `wallet.${label}`,
        message: 'walletAddress must not be empty'
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each(
    verificationCalls.flatMap((call) =>
      (['ethereum', 'solana', 'tron'] as const)
        .filter((activeType) => activeType !== call.walletType)
        .map((activeType) => ({ ...call, activeType }))
    )
  )(
    '$label rejects an omitted walletAddress for an active $activeType wallet before any request',
    async ({ label, activeType, verify }) => {
      const { fetchMock } = recordVerificationRequests();
      const wallet = createWalletWithSession(addressFor[activeType], activeType);

      await expect(verify(wallet)).rejects.toMatchObject({
        name: 'OMSWalletValidationError',
        code: 'OMS_VALIDATION_ERROR',
        operation: `wallet.${label}`
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});

function createSignedOutWallet(): WalletClientImpl {
  return new WalletClientImpl({
    publishableKey: 'publishable-key',
    projectId: 'project-id',
    environment: testEnvironment(),
    storage: new MemoryStorageManager(),
    credentialSigner: new MockSigner()
  });
}

function createWalletWithSession(
  walletAddress: string,
  walletType?: 'ethereum' | 'solana' | 'tron',
  expiresAt = '2099-01-01T00:00:00Z'
): WalletClientImpl {
  const wallet = new WalletClientImpl({
    publishableKey: 'publishable-key',
    projectId: 'project-id',
    environment: testEnvironment(),
    storage: new MemoryStorageManager(),
    credentialSigner: new MockSigner()
  });
  (wallet as any).persistSession(testWalletAccount('wallet-id', walletAddress, walletType), {
    expiresAt,
    auth: { type: 'email', email: 'user@example.com' },
    signerCredentialId: '0x04' + '11'.repeat(64),
    signerKeyType: 'ecdsa-p256-sha256'
  });
  return wallet;
}
