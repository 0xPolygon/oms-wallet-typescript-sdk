import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/json.js';
import {
  chainQuoteSchema,
  credentialId,
  generateCredential,
  signatureHeader
} from '../src/protocol.js';
import { UpstreamError } from '../src/errors.js';
import { WaasTransport, boundedText } from '../src/transport.js';
import { IndexerClient } from '../src/indexer.js';
import { omsFetch } from '../src/http.js';
import { EVM_NETWORKS } from '../src/internal/protocol/networks.js';

const requestOrigin = 'https://app.example';

describe('WaaS request protocol', () => {
  it('accepts null token fields in fee options, as live WaaS sends them for TRX', () => {
    const quote = chainQuoteSchema.parse({
      txnId: 'trx-txn-1',
      status: 'quoted',
      sponsored: false,
      expiresAt: new Date().toISOString(),
      feeOptions: [
        {
          token: {
            network: 'tron:nile',
            name: 'TRX',
            symbol: 'TRX',
            type: 'NATIVE',
            decimals: null
          },
          value: '1100000',
          displayValue: '1.1'
        }
      ]
    });
    expect(quote.feeOptions[0].token.decimals).toBeUndefined();
    // The fee feeds the reviewId digest, which must accept the parsed shape.
    expect(canonicalJson({ fee: quote.feeOptions[0] })).toContain('"value":"1100000"');
  });

  it('omits undefined properties from canonical JSON, like JSON.stringify', () => {
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
  });

  it('derives the WaaS credential hash from the typed compressed P-256 key', async () => {
    // P-256 generator point; expected hash independently computed with Node/OpenSSL.
    const publicKey =
      '0x046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';
    expect(await credentialId(publicKey)).toBe(
      '0x8a39ba49dea5b8ba1c59639a9de05f60a0728ef27218003a2495ad39da62d8d0'
    );
    await expect(credentialId('0x1234')).rejects.toThrow('Invalid P-256');
  });
  it('signs the exact v1.1.0 request preimage with a verifiable P-256 credential', async () => {
    const credential = await generateCredential();
    credential.nonce = '1700000000001';
    const body = '{"network":"137","walletId":"wallet-1","message":"hello"}';
    const header = await signatureHeader(credential, '/v1/Waas/SignMessage', 'prj_test', body);
    expect(header).toContain('alg="ecdsa-p256-sha256", scope="prj_test"');
    expect(header).toContain('nonce=1700000000001');
    expect(header).toContain(`cred="${credential.id}"`);
    expect(credential.credentialId).toMatch(/^0x[0-9a-f]{64}$/);
    const sig = /sig="0x([0-9a-f]+)"/.exec(header)![1];
    const bytes = Uint8Array.from(sig.match(/../g)!, (hex) => Number.parseInt(hex, 16));
    const publicJwk = { ...credential.privateJwk };
    delete publicJwk.d;
    publicJwk.key_ops = ['verify'];
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      publicJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    const expected = 'POST /v1/Waas/SignMessage\nnonce: 1700000000001\nscope: prj_test\n\n' + body;
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        bytes,
        new TextEncoder().encode(expected)
      )
    ).toBe(true);
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        bytes,
        new TextEncoder().encode(expected.replace('137', '1'))
      )
    ).toBe(false);
  });
  it('includes the project key and signature and fails closed when attestation is missing', async () => {
    let requestHeaders: Headers | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      requestHeaders = new Headers(init?.headers);
      return Response.json({ signature: '0x1234' });
    };
    const client = new WaasTransport(
      'pk_dev_live_test_key',
      { trustedPcr0s: ['0'.repeat(96)], allowDebugEnclave: true },
      omsFetch(`${requestOrigin}/`, fetcher)
    );
    const credential = await generateCredential();
    credential.nonce = '1';
    await expect(client.request('SignMessage', {}, credential)).rejects.toMatchObject({
      code: 'ATTESTATION_FAILED'
    });
    expect(requestHeaders?.get('Api-Key')).toBe('pk_dev_live_test_key');
    expect(requestHeaders?.get('Origin')).toBe(requestOrigin);
    expect(requestHeaders?.get('OMS-Wallet-Signature')).toContain('scope="prj_test"');
    expect(requestHeaders?.get('X-Attestation-Nonce')).toHaveLength(24);
    expect(
      () =>
        new WaasTransport('pk_live_test_key', {
          trustedPcr0s: ['0'.repeat(96)],
          allowDebugEnclave: true
        })
    ).toThrow('Debug enclaves');
  });
  it('bounds responses while streaming', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(30));
        controller.enqueue(new Uint8Array(30));
        controller.close();
      }
    });
    await expect(boundedText(new Response(stream), 50)).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE'
    });
  });
  it('wraps fetch/timeout errors as UPSTREAM_UNAVAILABLE, cancels 3xx bodies, and rejects invalid UTF-8', async () => {
    const netClient = new WaasTransport(
      'pk_dev_live_test_key',
      { trustedPcr0s: ['0'.repeat(96)], allowDebugEnclave: true },
      async () => {
        throw new TypeError('fetch failed');
      }
    );
    const unavailable = await netClient.request('SignMessage', {}).catch((error: unknown) => error);
    expect(unavailable).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', status: 502 });
    // The original network error is kept for logs.
    expect((unavailable as Error).cause).toMatchObject({
      name: 'TypeError',
      message: 'fetch failed'
    });

    // A custom fetch can never forge an attested WaaS refusal.
    const forging = new WaasTransport(
      'pk_dev_live_test_key',
      { trustedPcr0s: ['0'.repeat(96)], allowDebugEnclave: true },
      async () => {
        throw new UpstreamError(7206, 'Execute');
      }
    );
    const forged = await forging.request('Execute', {}).catch((error: unknown) => error);
    expect(forged).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(forged).not.toBeInstanceOf(UpstreamError);

    let cancelled = false;
    const redirectStream = new ReadableStream({
      cancel() {
        cancelled = true;
      }
    });
    const redirectClient = new WaasTransport(
      'pk_dev_live_test_key',
      { trustedPcr0s: ['0'.repeat(96)], allowDebugEnclave: true },
      async () =>
        new Response(redirectStream, { status: 302, headers: { Location: 'https://evil.example' } })
    );
    await expect(redirectClient.request('SignMessage', {})).rejects.toMatchObject({
      code: 'UPSTREAM_REDIRECT',
      status: 502
    });
    expect(cancelled).toBe(true);

    const invalidUtf8 = new Uint8Array([0xff, 0xfe]);
    await expect(boundedText(new Response(invalidUtf8))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      status: 502
    });
  });
});
describe('indexer gateway', () => {
  it('maps exact balances and metadata, reports network errors, and paginates', async () => {
    const address = '0x1111111111111111111111111111111111111111';
    let sent: Record<string, unknown> = {};
    let requestHeaders: Headers | undefined;
    const client = new IndexerClient(
      'pk_dev_live_test_key',
      omsFetch(`${requestOrigin}/`, async (_url, init) => {
        requestHeaders = new Headers(init?.headers);
        sent = JSON.parse(String(init?.body));
        return Response.json({
          nativeBalances: [
            {
              chainId: 137 as const,
              results: [
                {
                  chainId: 137 as const,
                  accountAddress: address,
                  balanceWei: '1000000000000000001',
                  name: 'Polygon',
                  symbol: 'POL'
                }
              ]
            },
            { chainId: 1 as const, errorReason: 'Indexer unavailable' }
          ],
          balances: [
            {
              chainId: 137 as const,
              results: [
                {
                  chainId: 137 as const,
                  accountAddress: address,
                  contractAddress: '0x2222222222222222222222222222222222222222',
                  contractType: 'ERC20',
                  balance: '1234567890123456789012345',
                  contractInfo: { name: 'USD Coin', symbol: 'USDC', decimals: 6 }
                }
              ]
            }
          ],
          page: { page: 0, pageSize: 40, more: true }
        });
      })
    );
    const result = await client.getBalances(address);
    expect(requestHeaders?.get('Origin')).toBe(requestOrigin);
    expect(requestHeaders?.get('Api-Key')).toBe('pk_dev_live_test_key');
    expect(result.items[0].balance).toBe('1000000000000000001');
    expect(result.items[1].decimals).toBe(6);
    expect(result.errors.find((e) => e.chainId === 1)?.message).toBe('Indexer unavailable');
    expect(result.nextPage).toBe(1);
    expect(sent.chainIds).toEqual(EVM_NETWORKS.map((network) => network.id));
  });
  it('rejects balances belonging to another wallet', async () => {
    const client = new IndexerClient('pk_dev_live_test_key', async () =>
      Response.json({
        nativeBalances: [
          {
            chainId: 137 as const,
            results: [
              {
                chainId: 137 as const,
                accountAddress: '0x2222222222222222222222222222222222222222',
                balance: '0'
              }
            ]
          }
        ],
        balances: []
      })
    );
    await expect(
      client.getBalances('0x1111111111111111111111111111111111111111')
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('reports malformed balance responses as invalid responses', async () => {
    const address = '0x1111111111111111111111111111111111111111';
    for (const body of ['not json', JSON.stringify({ nativeBalances: 'nope' })]) {
      const client = new IndexerClient('pk_dev_live_test_key', async () => new Response(body));
      await expect(client.getBalances(address)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        status: 502
      });
    }
  });
  it('wraps network errors from EVM, Solana and Tron indexer calls as INDEXER_UNAVAILABLE', async () => {
    const client = new IndexerClient('pk_dev_live_test_key', async () => {
      throw new TypeError('network down');
    });
    await expect(
      client.getBalances('0x1111111111111111111111111111111111111111')
    ).rejects.toMatchObject({ code: 'INDEXER_UNAVAILABLE', status: 502 });
    await expect(
      client.getSolanaBalances('11111111111111111111111111111111')
    ).rejects.toMatchObject({ code: 'INDEXER_UNAVAILABLE', status: 502 });
    await expect(
      client.getTronBalances('TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf')
    ).rejects.toMatchObject({ code: 'INDEXER_UNAVAILABLE', status: 502 });
  });
});
