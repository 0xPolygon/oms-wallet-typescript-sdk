import type { vi } from 'vitest';

import type { CredentialSigner } from '../../src/credentialSigner';
import type { OMSWalletEnvironment } from '../../src/omsEnvironment';

/** A credential signer with a fixed P-256 credential that always reports a stored credential. */
export class MockSigner implements CredentialSigner {
  readonly signingAlgorithm = 'ecdsa-p256-sha256';

  async credentialId(): Promise<string> {
    return '0x04' + '11'.repeat(64);
  }

  async nextNonce(): Promise<string> {
    return '42';
  }

  async sign(): Promise<string> {
    return '0x' + '22'.repeat(64);
  }

  async hasCredential(): Promise<boolean> {
    return true;
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
