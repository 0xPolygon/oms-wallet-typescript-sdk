import { describe, expect, it } from 'vitest';

import {
  base64DecodeBytes,
  base64EncodeBytes,
  base64UrlDecodeBytes,
  base64UrlEncodeBytes,
  bytesToHex,
  equalBytes
} from '../src/encoding.js';

describe('encoding', () => {
  const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);

  it('round-trips base64 and base64url', () => {
    expect(base64DecodeBytes(base64EncodeBytes(bytes))).toEqual(bytes);
    expect(base64UrlEncodeBytes(bytes)).not.toMatch(/[+/=]/);
    expect(base64UrlDecodeBytes(base64UrlEncodeBytes(bytes))).toEqual(bytes);
  });

  it('prints hex and compares bytes', () => {
    expect(bytesToHex(bytes)).toBe('0001fafbfcfdfeff');
    expect(equalBytes(bytes, bytes.slice())).toBe(true);
    expect(equalBytes(bytes, bytes.slice(1))).toBe(false);
    expect(equalBytes(new Uint8Array([1]), new Uint8Array([2]))).toBe(false);
  });
});
