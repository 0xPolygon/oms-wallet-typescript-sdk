import { afterEach, describe, expect, it, vi } from 'vitest';

import { WalletClientImpl } from '../src/clients/walletClient';
import { verifyAttestationDocument } from '../src/internal/protocol/attestation';
import { MemoryStorageManager } from '../src/storageManager';
import { WalletImportCipherSuite } from '../src/types/waas';
import { MockSigner, testEnvironment, testExpiryBounds } from './fixtures/helpers';
import { testWalletAccount } from './fixtures/walletAccount';

vi.mock('../src/internal/protocol/attestation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/internal/protocol/attestation')>()),
  verifyAttestationDocument: vi.fn(async () => undefined)
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('wallet import attestation', () => {
  it('verifies each response against the signature header and nonce that were sent', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ keyId: 'key-1', publicKey: 'AQID' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Attestation-Document': 'document' }
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const wallet = new WalletClientImpl({
      publishableKey: 'publishable-key',
      projectId: 'project-id',
      environment: testEnvironment(),
      storage: new MemoryStorageManager(),
      credentialSigner: new MockSigner(),
      walletImportTrustedPcr0s: ['1'.repeat(96)]
    });
    const expiresAt = '2099-01-01T00:00:00Z';
    (wallet as any).persistSession(testWalletAccount('wallet-id', '0x' + '11'.repeat(20)), {
      expiresAt,
      auth: { type: 'email', email: 'user@example.com' },
      signerCredentialId: '0x04' + '11'.repeat(64),
      signerKeyType: 'ecdsa-p256-sha256',
      expiryBounds: testExpiryBounds(expiresAt)
    });

    await wallet.getWalletImportRecipientKey({
      cipherSuite: WalletImportCipherSuite.P256Sha256Aes256Gcm
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const sent = new Headers(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers
    );
    expect(sent.get('OMS-Wallet-Signature')).toMatch(/^alg="/);
    expect(verifyAttestationDocument).toHaveBeenCalledOnce();
    expect(verifyAttestationDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        encodedDocument: 'document',
        boundHeader: sent.get('OMS-Wallet-Signature'),
        nonce: sent.get('X-Attestation-Nonce'),
        path: expect.stringMatching(/\/GetRecipientKey$/)
      })
    );
  });
});
