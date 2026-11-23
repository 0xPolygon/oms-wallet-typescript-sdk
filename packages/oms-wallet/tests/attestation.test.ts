import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  normalizeTrustedPcr0s,
  verifyAttestationDocument
} from '../src/internal/protocol/attestation';

// Runs the protocol copy against this package's own @peculiar/x509 and cbor-x, which the protocol
// package's tests do not use.
const fixture = JSON.parse(
  readFileSync(
    new URL('../../oms-wallet-protocol/tests/fixtures/attestation.json', import.meta.url),
    'utf8'
  )
) as {
  encodedDocument: string;
  method: string;
  path: string;
  requestBody: string;
  responseBody: string;
  nonce: string;
  pcr0: string;
  now: string;
};

describe('attestation with this package’s dependencies', () => {
  it('verifies a real WaaS attestation', async () => {
    await expect(
      verifyAttestationDocument({
        ...fixture,
        trustedPcr0s: normalizeTrustedPcr0s([fixture.pcr0]),
        now: new Date(fixture.now)
      })
    ).resolves.toBeUndefined();
  });

  it('rejects a response it does not bind', async () => {
    await expect(
      verifyAttestationDocument({
        ...fixture,
        responseBody: '{}',
        trustedPcr0s: normalizeTrustedPcr0s([fixture.pcr0]),
        now: new Date(fixture.now)
      })
    ).rejects.toThrow('not bound to the request and response');
  });
});
