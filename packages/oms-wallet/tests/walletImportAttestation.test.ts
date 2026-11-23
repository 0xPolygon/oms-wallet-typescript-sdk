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

const verify = vi.mocked(verifyAttestationDocument);

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function attestedResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Attestation-Document': 'document' }
  });
}

function walletWithSession(credentialSigner = new MockSigner()): WalletClientImpl {
  const wallet = new WalletClientImpl({
    publishableKey: 'publishable-key',
    projectId: 'project-id',
    environment: testEnvironment(),
    storage: new MemoryStorageManager(),
    credentialSigner,
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
  return wallet;
}

function recipientKey(wallet: WalletClientImpl) {
  return wallet.getWalletImportRecipientKey({
    cipherSuite: WalletImportCipherSuite.P256Sha256Aes256Gcm
  });
}

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>, call: number): Headers {
  return new Headers((fetchMock.mock.calls[call] as unknown as [string, RequestInit])[1].headers);
}

describe('wallet import attestation', () => {
  it('verifies each response against the signature header and nonce that were sent', async () => {
    const fetchMock = vi.fn(async () => attestedResponse({ keyId: 'key-1', publicKey: 'AQID' }));
    vi.stubGlobal('fetch', fetchMock);

    await recipientKey(walletWithSession());

    expect(fetchMock).toHaveBeenCalledOnce();
    const sent = sentHeaders(fetchMock, 0);
    expect(sent.get('OMS-Wallet-Signature')).toMatch(/^alg="/);
    expect(verify).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        encodedDocument: 'document',
        boundHeader: sent.get('OMS-Wallet-Signature'),
        nonce: sent.get('X-Attestation-Nonce'),
        path: expect.stringMatching(/\/GetRecipientKey$/)
      })
    );
  });

  it('resends an attested nonce rejection with a fresh signature and attestation nonce', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(attestedResponse({ code: 7206, error: 'PreconditionFailed' }, 412))
      .mockResolvedValueOnce(attestedResponse({ keyId: 'key-1', publicKey: 'AQID' }));
    vi.stubGlobal('fetch', fetchMock);

    const signer = new MockSigner();
    let nonce = 0;
    vi.spyOn(signer, 'nextNonce').mockImplementation(async () => String((nonce += 1)));

    await expect(recipientKey(walletWithSession(signer))).resolves.toBeDefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
    const [first, second] = [sentHeaders(fetchMock, 0), sentHeaders(fetchMock, 1)];
    expect(second.get('OMS-Wallet-Signature')).not.toBe(first.get('OMS-Wallet-Signature'));
    expect(second.get('X-Attestation-Nonce')).not.toBe(first.get('X-Attestation-Nonce'));
    expect(verify.mock.calls[1][0].boundHeader).toBe(second.get('OMS-Wallet-Signature'));
  });

  it('fails closed on a nonce rejection that is not attested', async () => {
    const fetchMock = vi.fn(async () =>
      attestedResponse({ code: 7206, error: 'PreconditionFailed' }, 412)
    );
    vi.stubGlobal('fetch', fetchMock);
    verify.mockRejectedValueOnce(new Error('WaaS attestation signature is invalid'));

    await expect(recipientKey(walletWithSession())).rejects.toMatchObject({
      code: 'OMS_ATTESTATION_VERIFICATION_FAILED'
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('releases the signed-request queue when verification stalls past the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchMock = vi.fn(async () => attestedResponse({ keyId: 'key-1', publicKey: 'AQID' }));
    vi.stubGlobal('fetch', fetchMock);
    verify.mockImplementationOnce(() => new Promise<void>(() => {}));
    const wallet = walletWithSession();

    const stalled = recipientKey(wallet);
    stalled.catch(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(stalled).rejects.toThrow();

    // The next request signed with the same credential is sent and completes.
    await expect(recipientKey(wallet)).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
