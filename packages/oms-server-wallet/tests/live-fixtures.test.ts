import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { verifyAttestationDocument } from '../src/internal/protocol/attestation.js';

interface LiveFixture {
  method: string;
  path: string;
  requestBody: string;
  responseBody: string;
  nonce: string;
  encodedDocument: string;
  trustedPcr0s: string[];
  now: string;
}
const directory = new URL('./fixtures/live/', import.meta.url);
const files = readdirSync(directory).filter((file) => file.endsWith('.json'));

describe.skipIf(!files.length)('recorded live WaaS responses', () => {
  it.each(files)('%s verifies against its recorded request and response', async (file) => {
    const fixture = JSON.parse(readFileSync(new URL(file, directory), 'utf8')) as LiveFixture;
    await expect(
      verifyAttestationDocument({
        ...fixture,
        trustedPcr0s: new Set(fixture.trustedPcr0s.map((pcr0) => pcr0.replace(/^0x/, ''))),
        now: new Date(fixture.now)
      })
    ).resolves.toBeUndefined();
  });
});
