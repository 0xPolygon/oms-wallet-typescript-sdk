import { describe, expect, it } from 'vitest';

import {
  nextWalletNonce,
  walletRequestPreimage,
  walletSignatureHeader
} from '../src/requestSigning.js';

describe('request signing', () => {
  it('builds the signed preimage', () => {
    expect(walletRequestPreimage('/v1/Waas/SignMessage', '7', 'prj_a', '{"x":1}')).toBe(
      'POST /v1/Waas/SignMessage\nnonce: 7\nscope: prj_a\n\n{"x":1}'
    );
  });

  it('builds the signature header', () => {
    expect(
      walletSignatureHeader({
        algorithm: 'ecdsa-p256-sha256',
        scope: 'prj_a',
        credential: '0x04ab',
        nonce: '7',
        signature: '0xcd'
      })
    ).toBe('alg="ecdsa-p256-sha256", scope="prj_a", cred="0x04ab", nonce=7, sig="0xcd"');
  });

  it('takes the clock, or one more than the previous nonce when the clock is behind', () => {
    expect(nextWalletNonce(5n, 1_000)).toBe(1_000n);
    expect(nextWalletNonce(2_000n, 1_000)).toBe(2_001n);
    expect(nextWalletNonce(1_000n, 1_000)).toBe(1_001n);
  });
});
