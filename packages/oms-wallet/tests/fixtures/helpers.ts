import type { vi } from 'vitest';

import { WalletClientImpl } from '../../src/clients/walletClient';
import type { CredentialSigner } from '../../src/credentialSigner';
import type { OMSWalletEnvironment } from '../../src/omsEnvironment';
import { MemoryStorageManager } from '../../src/storageManager';
import { testWalletAccount } from './walletAccount.js';

/**
 * A credential signer with a fixed P-256 credential. It records every signed preimage, can switch
 * credentials mid-test, and reports `available` from `hasCredential` (default true, which is how
 * the SDK treats signers without `hasCredential`).
 */
export class MockSigner implements CredentialSigner {
  readonly signingAlgorithm = 'ecdsa-p256-sha256';
  readonly preimages: string[] = [];

  constructor(
    private credential = '0x04' + '11'.repeat(64),
    private readonly available = true
  ) {}

  async credentialId(): Promise<string> {
    return this.credential;
  }

  setCredential(credential: string): void {
    this.credential = credential;
  }

  async nextNonce(): Promise<string> {
    return '42';
  }

  async sign(preimage: string): Promise<string> {
    this.preimages.push(preimage);
    return '0x' + '22'.repeat(64);
  }

  async hasCredential(): Promise<boolean> {
    return this.available;
  }
}

export function testEnvironment(): OMSWalletEnvironment {
  return {
    walletApiUrl: 'https://wallet.example',
    indexerGatewayUrl: 'https://indexer.example',
    solanaIndexerGatewayUrl: 'https://solana-indexer.example',
    tronIndexerGatewayUrl: 'https://tron-indexer.example'
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/** A WaaS error body: `KeyExpired` (7203) by default, or `KeyNotFound` (7202), `WebrpcBadRoute` (-2). */
export function waasErrorResponse(
  name: 'KeyExpired' | 'KeyNotFound' | 'WebrpcBadRoute' = 'KeyExpired'
) {
  const { code, status } = {
    KeyExpired: { code: 7203, status: 400 },
    KeyNotFound: { code: 7202, status: 404 },
    WebrpcBadRoute: { code: -2, status: 404 }
  }[name];
  return jsonResponse({ code, name, message: name, status }, status);
}

export function requestCount(fetchMock: ReturnType<typeof vi.fn>, endpoint: string): number {
  return fetchMock.mock.calls.filter(([input]) => input.toString().endsWith(endpoint)).length;
}

export function testCredential() {
  return {
    type: 'direct',
    credentialId: '0x' + '11'.repeat(32),
    expiresAt: '2099-01-01T00:00:00Z',
    isCaller: true
  };
}

/**
 * A wallet client with an active email session seeded for `walletAddress` (default an Ethereum
 * address). The session is seeded through private state, as the established fixtures do.
 */
export function createWalletWithSession(
  walletAddress = '0x1111111111111111111111111111111111111111',
  walletType?: Parameters<typeof testWalletAccount>[2],
  options: { expiresAt?: string; storage?: MemoryStorageManager; signer?: MockSigner } = {}
): WalletClientImpl {
  const wallet = new WalletClientImpl({
    publishableKey: 'publishable-key',
    projectId: 'project-id',
    environment: testEnvironment(),
    storage: options.storage ?? new MemoryStorageManager(),
    credentialSigner: options.signer ?? new MockSigner()
  });
  (wallet as any).persistSession(testWalletAccount('wallet-id', walletAddress, walletType), {
    expiresAt: options.expiresAt ?? '2099-01-01T00:00:00Z',
    auth: { type: 'email', email: 'user@example.com' },
    signerCredentialId: '0x04' + '11'.repeat(64),
    signerKeyType: 'ecdsa-p256-sha256'
  });
  return wallet;
}

/** Waits (macrotask ticks) until `fetchMock` has sent `count` requests to `endpoint`. */
export async function waitForRequest(
  fetchMock: ReturnType<typeof vi.fn>,
  endpoint: string,
  count = 1
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (requestCount(fetchMock, endpoint) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${endpoint}`);
}
