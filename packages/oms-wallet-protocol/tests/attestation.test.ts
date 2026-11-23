import { readFileSync } from 'node:fs';

import { Decoder, Encoder, Tag } from 'cbor-x';
import { describe, expect, it } from 'vitest';

import {
  attestationUserData,
  normalizeTrustedPcr0s,
  trustsDebugEnclave,
  verifyAttestationDocument
} from '../src/attestation.js';
import { base64DecodeBytes, base64EncodeBytes } from '../src/encoding.js';

interface AttestationFixture {
  encodedDocument: string;
  method: string;
  path: string;
  requestBody: string;
  responseBody: string;
  nonce: string;
  pcr0: string;
  now: string;
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/attestation.json', import.meta.url), 'utf8')
) as AttestationFixture;

describe('AWS Nitro attestation verification', () => {
  it('verifies a real WaaS attestation bound to its request and response', async () => {
    await expect(verifyFixture()).resolves.toBeUndefined();
  });

  it('rejects attestations outside the freshness window', async () => {
    const staleNow = new Date(new Date(fixture.now).getTime() + 6 * 60 * 1_000);

    await expect(verifyFixture({ now: staleNow })).rejects.toThrow(
      'timestamp is outside the accepted freshness window'
    );
  });

  it.each([
    { field: 'method', overrides: { method: 'GET' } },
    { field: 'path', overrides: { path: '/v1/Waas/GetRecipientKey' } },
    { field: 'request body', overrides: { requestBody: '{"changed":true}' } }
  ])('rejects a mismatched $field binding', async ({ overrides }) => {
    await expect(verifyFixture(overrides)).rejects.toThrow('not bound to the request and response');
  });

  it('rejects a COSE document that does not use ES384', async () => {
    const encodedDocument = mutateCoseDocument((value, decoder, encoder) => {
      const protectedHeader = decoder.decode(value[0]);
      if (!(protectedHeader instanceof Map)) throw new Error('Fixture header is not a map');
      protectedHeader.set(1, -7);
      value[0] = encoder.encode(protectedHeader);
    });

    await expect(verifyFixture({ encodedDocument })).rejects.toThrow('does not use COSE ES384');
  });

  it('rejects an invalid COSE_Sign1 structure', async () => {
    const encodedDocument = mutateCoseDocument((value) => {
      value[1] = new Map([[4, new Uint8Array([1])]]);
    });

    await expect(verifyFixture({ encodedDocument })).rejects.toThrow(
      'invalid COSE_Sign1 structure'
    );
  });

  it('rejects a certificate bundle without the pinned AWS Nitro root', async () => {
    const encodedDocument = mutateAttestationPayload((payload) => {
      const certificates = payload.get('cabundle');
      if (!Array.isArray(certificates) || certificates.length < 2) {
        throw new Error('Fixture certificate bundle is incomplete');
      }
      payload.set('cabundle', [certificates[1], ...certificates.slice(1)]);
    });

    await expect(verifyFixture({ encodedDocument })).rejects.toThrow(
      'does not use the AWS Nitro root'
    );
  });

  it('rejects an incomplete AWS Nitro certificate bundle', async () => {
    const encodedDocument = mutateAttestationPayload((payload) => {
      const certificates = payload.get('cabundle');
      if (!Array.isArray(certificates) || certificates.length < 2) {
        throw new Error('Fixture certificate bundle is incomplete');
      }
      payload.set('cabundle', certificates.slice(0, -1));
    });

    await expect(verifyFixture({ encodedDocument })).rejects.toThrow(
      'certificate chain is incomplete'
    );
  });

  it('rejects untrusted measurements and mismatched request bindings', async () => {
    await expect(verifyFixture({ trustedPcr0s: new Set(['1'.repeat(96)]) })).rejects.toThrow(
      'PCR0 is not trusted'
    );
    await expect(verifyFixture({ nonce: 'different' })).rejects.toThrow('nonce does not match');
    await expect(verifyFixture({ responseBody: '{}' })).rejects.toThrow(
      'not bound to the request and response'
    );
    const tamperedBytes = base64DecodeBytes(fixture.encodedDocument);
    tamperedBytes[tamperedBytes.length - 1] ^= 1;
    const tamperedDocument = base64EncodeBytes(tamperedBytes);
    await expect(verifyFixture({ encodedDocument: tamperedDocument })).rejects.toThrow(
      'signature is invalid'
    );
  });

  it('rejects user data of an unsupported version', async () => {
    const encodedDocument = mutateAttestationPayload((payload) => {
      const userData = new TextDecoder().decode(payload.get('user_data') as Uint8Array);
      payload.set(
        'user_data',
        new TextEncoder().encode(userData.replace('Sequence/1', 'Sequence/3'))
      );
    });

    await expect(verifyFixture({ encodedDocument })).rejects.toThrow(
      'unsupported user data version'
    );
  });
});

// The same cases as nitrocontrol's attestation/middleware_test.go (TestMiddlewareUserData): a POST
// to /rpc with body "request" answered by "response".
describe('attestation user data', () => {
  const binding = {
    method: 'POST',
    path: '/rpc',
    requestBody: 'request',
    responseBody: 'response'
  };

  it.each([
    {
      name: 'Sequence/1 ignores the header',
      version: 1 as const,
      boundHeader: 'sig',
      preimage: 'POST /rpc\nrequest\nresponse'
    },
    {
      name: 'Sequence/2 with the header',
      version: 2 as const,
      boundHeader: 'sig',
      preimage: 'POST /rpc\nsig\nrequest\nresponse'
    },
    {
      name: 'Sequence/2 without the header',
      version: 2 as const,
      boundHeader: undefined,
      preimage: 'POST /rpc\n\nrequest\nresponse'
    }
  ])('$name', async ({ version, boundHeader, preimage }) => {
    const hash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(preimage))
    );
    expect(
      new TextDecoder().decode(await attestationUserData(version, { ...binding, boundHeader }))
    ).toBe(`Sequence/${version}:${base64EncodeBytes(hash)}`);
  });

  it('a Sequence/2 hash changes with the bound header', async () => {
    const signed = await attestationUserData(2, { ...binding, boundHeader: 'sig' });
    const swapped = await attestationUserData(2, { ...binding, boundHeader: 'attacker' });
    expect(new TextDecoder().decode(signed)).not.toBe(new TextDecoder().decode(swapped));
  });
});

describe('trusted PCR0s', () => {
  it('normalizes case, whitespace and a 0x prefix', () => {
    expect(normalizeTrustedPcr0s([` 0x${'AB'.repeat(48)} `])).toEqual(new Set(['ab'.repeat(48)]));
  });

  it.each([[[]], [['00']], [['zz'.repeat(48)]]])('rejects %j', (pcr0s) => {
    expect(() => normalizeTrustedPcr0s(pcr0s)).toThrow('at least one 48-byte hex PCR0');
  });

  it('recognises a trusted debug enclave', () => {
    expect(trustsDebugEnclave(normalizeTrustedPcr0s(['0'.repeat(96)]))).toBe(true);
    expect(trustsDebugEnclave(normalizeTrustedPcr0s(['1'.repeat(96)]))).toBe(false);
  });
});

function verifyFixture(
  overrides: Partial<Parameters<typeof verifyAttestationDocument>[0]> = {}
): Promise<void> {
  return verifyAttestationDocument({
    encodedDocument: fixture.encodedDocument,
    method: fixture.method,
    path: fixture.path,
    requestBody: fixture.requestBody,
    responseBody: fixture.responseBody,
    nonce: fixture.nonce,
    trustedPcr0s: new Set([fixture.pcr0]),
    now: new Date(fixture.now),
    ...overrides
  });
}

type CoseSign1Value = [Uint8Array, Map<unknown, unknown>, Uint8Array, Uint8Array];

function mutateCoseDocument(
  mutate: (value: CoseSign1Value, decoder: Decoder, encoder: Encoder) => void
): string {
  const decoder = new Decoder({ mapsAsObjects: false, copyBuffers: true });
  const encoder = new Encoder({ mapsAsObjects: false, tagUint8Array: false, useRecords: false });
  const decoded = decoder.decode(base64DecodeBytes(fixture.encodedDocument));
  const value = decoded instanceof Tag ? decoded.value : decoded;
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error('Fixture is not a COSE_Sign1 document');
  }
  mutate(value as CoseSign1Value, decoder, encoder);
  return base64EncodeBytes(
    encoder.encode(decoded instanceof Tag ? new Tag(value, decoded.tag) : value)
  );
}

function mutateAttestationPayload(mutate: (payload: Map<unknown, unknown>) => void): string {
  return mutateCoseDocument((value, decoder, encoder) => {
    const payload = decoder.decode(value[2]);
    if (!(payload instanceof Map)) throw new Error('Fixture payload is not a map');
    mutate(payload);
    value[2] = encoder.encode(payload);
  });
}
