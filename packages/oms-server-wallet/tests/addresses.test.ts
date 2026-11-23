import { describe, expect, it } from 'vitest';

import {
  base58Decode,
  base58Encode,
  hexToTron,
  isSolanaAddress,
  isTronAddress,
  tronToHex
} from '../src/addresses.js';
import { isWalletAddress } from '../src/protocol.js';

// USDT on Tron mainnet, in both of its published forms.
const usdtTron = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const usdtHex = '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c';

describe('base58', () => {
  it('round-trips bytes, keeping leading zeros', () => {
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array([0]),
      new Uint8Array([0, 0, 1, 2, 255]),
      new Uint8Array(32).fill(0xff)
    ])
      expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });
  it('rejects characters outside the alphabet', () => {
    for (const value of ['0', 'O', 'I', 'l', 'abc+']) expect(base58Decode(value)).toBeUndefined();
  });
});

describe('Solana addresses', () => {
  it('accepts 32-byte keys and program addresses', () => {
    expect(isSolanaAddress('11111111111111111111111111111111')).toBe(true);
    expect(isSolanaAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe(true);
    expect(isSolanaAddress('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')).toBe(true);
  });
  it.each([
    ['too short', '1111111111111111111111111111111'],
    ['33 bytes', base58Encode(new Uint8Array(33).fill(9))],
    ['not base58', '0OIl000000000000000000000000000000'],
    ['an EVM address', '0x1111111111111111111111111111111111111111'],
    ['not a string', 42]
  ])('rejects %s', (_, value) => {
    expect(isSolanaAddress(value)).toBe(false);
  });
});

describe('Tron addresses', () => {
  it('decodes Base58Check and converts both ways', () => {
    expect(isTronAddress(usdtTron)).toBe(true);
    expect(tronToHex(usdtTron).toLowerCase()).toBe(usdtHex);
    expect(hexToTron(usdtHex)).toBe(usdtTron);
  });
  it.each([
    ['a bad checksum', `${usdtTron.slice(0, -1)}u`],
    ['a wrong version byte', base58Encode(new Uint8Array(25).fill(0x42))],
    ['the hex form', usdtHex],
    ['a Solana address', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
    ['not a string', null]
  ])('rejects %s', (_, value) => {
    expect(isTronAddress(value)).toBe(false);
  });
  it('refuses to convert invalid input', () => {
    expect(() => tronToHex(usdtHex)).toThrow();
    expect(() => hexToTron(usdtTron)).toThrow();
  });
});

describe('wallet addresses per family', () => {
  it('checks each family against its own encoding', () => {
    expect(isWalletAddress('evm', usdtHex)).toBe(true);
    expect(isWalletAddress('tron', usdtTron)).toBe(true);
    expect(isWalletAddress('solana', '11111111111111111111111111111111')).toBe(true);
    for (const [family, address] of [
      ['evm', usdtTron],
      ['tron', usdtHex],
      ['solana', usdtTron]
    ] as const)
      expect(isWalletAddress(family, address)).toBe(false);
  });
});
