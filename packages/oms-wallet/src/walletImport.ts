import type { ImportWalletParams } from './wallet.js';

import { decodeBase58 } from './utils/base58.js';
import { base64DecodeBytes, base64EncodeBytes, toArrayBuffer } from './utils/base64.js';

const secp256k1Order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export function walletImportPlaintext(params: ImportWalletParams): Uint8Array {
  validateWalletImportReference(params.reference);
  switch (params.type) {
    case 'ethereum':
      return secp256k1PrivateKeyPlaintext(params.privateKey, 'Ethereum');
    case 'tron':
      // Tron uses the same secp256k1 private key as Ethereum.
      return secp256k1PrivateKeyPlaintext(params.privateKey, 'Tron');
    case 'solana':
      return solanaPrivateKeyPlaintext(params.privateKey);
  }
}

export function validateWalletImportReference(reference: string | undefined): void {
  if (reference && new TextEncoder().encode(reference).length > 128) {
    throw new Error('reference must be at most 128 UTF-8 bytes');
  }
}

export async function sealWalletImportPrivateKey(
  publicKey: string,
  privateKey: Uint8Array
): Promise<{ encapsulatedKey: string; ciphertext: string }> {
  const { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } = await import('@hpke/core');
  const cipherSuite = new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm()
  });
  const recipientPublicKey = await crypto.subtle.importKey(
    'spki',
    toArrayBuffer(base64DecodeBytes(publicKey)),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
  const sealed = await cipherSuite.seal({ recipientPublicKey }, privateKey);
  return {
    encapsulatedKey: base64EncodeBytes(new Uint8Array(sealed.enc)),
    ciphertext: base64EncodeBytes(new Uint8Array(sealed.ct))
  };
}

export function requireBase64(value: string, field: string): string {
  try {
    const decoded = base64DecodeBytes(value);
    if (decoded.length === 0 || base64EncodeBytes(decoded) !== value) throw new Error();
    return value;
  } catch {
    throw new Error(`${field} must be canonical base64`);
  }
}

function secp256k1PrivateKeyPlaintext(value: string | Uint8Array, label: string): Uint8Array {
  if (typeof value === 'string') {
    const privateKey = trimAsciiWhitespace(value);
    if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new Error(`${label} privateKey must be 32 bytes or 64 hexadecimal characters`);
    }
    requireValidSecp256k1Scalar(hexToBytes(privateKey.replace(/^0x/, '')), label);
    return new TextEncoder().encode(privateKey);
  }
  if (value.length !== 32) throw new Error(`${label} privateKey must contain exactly 32 bytes`);
  requireValidSecp256k1Scalar(value, label);
  return Uint8Array.from(value);
}

function solanaPrivateKeyPlaintext(value: string | Uint8Array): Uint8Array {
  if (typeof value === 'string') {
    const privateKey = trimAsciiWhitespace(value);
    if (!privateKey) throw new Error('Solana privateKey is required');
    const decoded = decodeBase58(privateKey);
    if (!decoded) throw new Error('Solana privateKey must be base58 encoded');
    if (decoded.length !== 32 && decoded.length !== 64) {
      throw new Error('Solana privateKey must decode to a 32-byte seed or 64-byte keypair');
    }
    if (privateKey.length === 32 || privateKey.length === 64) {
      throw new Error('Solana privateKey string is ambiguous; provide the raw bytes instead');
    }
    return new TextEncoder().encode(privateKey);
  }
  if (value.length !== 32 && value.length !== 64) {
    throw new Error('Solana privateKey must contain a 32-byte seed or 64-byte keypair');
  }
  return Uint8Array.from(value);
}

function requireValidSecp256k1Scalar(bytes: Uint8Array, label: string): void {
  let scalar = 0n;
  for (const byte of bytes) scalar = (scalar << 8n) | BigInt(byte);
  if (scalar === 0n || scalar >= secp256k1Order) {
    throw new Error(`${label} privateKey is outside the valid secp256k1 scalar range`);
  }
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function trimAsciiWhitespace(value: string): string {
  return value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
}
