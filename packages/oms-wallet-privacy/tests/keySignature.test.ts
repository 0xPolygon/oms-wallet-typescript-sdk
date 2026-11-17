import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, type Address, type Hex } from 'viem';

import { KeySignatureError, innerKeySignature } from '../src/keySignature.js';
import { KEY_MESSAGE } from '../src/session.js';

// Real signatures over the key message from WaaS's local stack (throwaway wallets), exported by a
// WaaS integration test: an undeployed (ERC-6492) and deployed smart-contract wallet, then after a
// smart-session grant and revocation (chained signatures), and the same steps for an EOA wallet.
const fixture = JSON.parse(
  readFileSync(new URL('./vectors/waas-key-signatures.json', import.meta.url), 'utf8')
) as {
  message: string;
  vectors: Array<{
    mode: 'SCW' | 'EOA';
    label: string;
    wallet: Address;
    chainId: number;
    signature: Hex;
    inner: Hex;
    signer: Address;
  }>;
};

describe('innerKeySignature', () => {
  it('uses the current key message', () => {
    expect(fixture.message).toBe(KEY_MESSAGE);
  });

  it.each(fixture.vectors.map((vector) => [`${vector.mode} ${vector.label}`, vector] as const))(
    'extracts the wallet key signature: %s',
    async (_label, vector) => {
      const result = await innerKeySignature({
        signature: vector.signature,
        wallet: vector.wallet,
        chainId: vector.chainId,
        message: fixture.message
      });
      expect(result.signature).toBe(vector.inner);
      expect(result.signer).toBe(vector.signer);
    }
  );

  it('gives the same key signature through deployment and configuration changes', async () => {
    for (const mode of ['SCW', 'EOA'] as const) {
      const vectors = fixture.vectors.filter((vector) => vector.mode === mode);
      const fullSignatures = new Set(vectors.map((vector) => vector.signature));
      const inner = new Set(
        await Promise.all(
          vectors.map(
            async (vector) =>
              (
                await innerKeySignature({
                  signature: vector.signature,
                  wallet: vector.wallet,
                  chainId: vector.chainId,
                  message: fixture.message
                })
              ).signature
          )
        )
      );
      if (mode === 'SCW') expect(fullSignatures.size).toBeGreaterThan(1);
      expect(inner.size).toBe(1);
    }
  });

  it('rejects an EOA signature from another address', async () => {
    const eoa = fixture.vectors.find((vector) => vector.mode === 'EOA')!;
    await expect(
      innerKeySignature({
        signature: eoa.signature,
        wallet: '0x1111111111111111111111111111111111111111',
        chainId: eoa.chainId,
        message: fixture.message
      })
    ).rejects.toThrow(KeySignatureError);
  });

  it('rejects a non-canonical (high-s) signature', async () => {
    const eoa = fixture.vectors.find((vector) => vector.mode === 'EOA')!;
    const bytes = hexToBytes(eoa.signature);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(bytesToHex(bytes.slice(32, 64)));
    bytes.set(hexToBytes(`0x${(n - s).toString(16).padStart(64, '0')}`), 32);
    bytes[64] = bytes[64] === 27 ? 28 : 27;
    await expect(
      innerKeySignature({
        signature: bytesToHex(bytes),
        wallet: eoa.wallet,
        chainId: eoa.chainId,
        message: fixture.message
      })
    ).rejects.toThrow('Non-canonical');
  });

  it('rejects malformed signatures', async () => {
    const scw = fixture.vectors.find(
      (vector) => vector.mode === 'SCW' && vector.label === 'deployed'
    )!;
    for (const signature of ['0x', '0x01', `${scw.signature.slice(0, -10)}` as Hex]) {
      await expect(
        innerKeySignature({
          signature: signature as Hex,
          wallet: scw.wallet,
          chainId: scw.chainId,
          message: fixture.message
        })
      ).rejects.toThrow(KeySignatureError);
    }
  });
});
