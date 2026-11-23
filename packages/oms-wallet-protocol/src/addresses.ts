import { bytesToHex, getAddress, isAddress, sha256 } from 'viem';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode base58, or return undefined for any character outside the alphabet. */
export function base58Decode(value: string): Uint8Array | undefined {
  let decoded = 0n;
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) return undefined;
    decoded = decoded * 58n + BigInt(index);
  }
  const bytes: number[] = [];
  for (; decoded > 0n; decoded >>= 8n) bytes.unshift(Number(decoded & 0xffn));
  for (let i = 0; i < value.length && value[i] === '1'; i++) bytes.unshift(0);
  return Uint8Array.from(bytes);
}

export function base58Encode(value: Uint8Array): string {
  let number = 0n;
  for (const byte of value) number = (number << 8n) | BigInt(byte);
  let result = '';
  for (; number > 0n; number /= 58n) result = alphabet[Number(number % 58n)] + result;
  for (let i = 0; i < value.length && value[i] === 0; i++) result = '1' + result;
  return result;
}

/** A Solana address is a base58 Ed25519 public key or program-derived address of 32 bytes. */
export function isSolanaAddress(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 32 &&
    value.length <= 44 &&
    base58Decode(value)?.length === 32
  );
}

const tronChecksum = (raw: Uint8Array) => sha256(sha256(raw, 'bytes'), 'bytes').subarray(0, 4);

/** The 20-byte account behind a Base58Check `T…` address, or undefined if it is not one. */
export function tronAddressBytes(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'string' || value.length !== 34 || value[0] !== 'T') return;
  const decoded = base58Decode(value);
  if (decoded?.length !== 25 || decoded[0] !== 0x41) return;
  const checksum = tronChecksum(decoded.subarray(0, 21));
  if (checksum.some((byte, i) => byte !== decoded[21 + i])) return;
  return decoded.slice(1, 21);
}

export function isTronAddress(value: unknown): value is string {
  return tronAddressBytes(value) !== undefined;
}

/** The `0x` form of a Tron address, as TIP-712 encodes it. */
export function tronToHex(value: string): `0x${string}` {
  const bytes = tronAddressBytes(value);
  if (!bytes) throw new Error('Invalid Tron address');
  return getAddress(bytesToHex(bytes));
}

export function hexToTron(value: string): string {
  if (!isAddress(value)) throw new Error('Invalid hex address');
  const raw = new Uint8Array(21);
  raw[0] = 0x41;
  raw.set(
    Uint8Array.from(value.slice(2).match(/../g)!, (hex) => parseInt(hex, 16)),
    1
  );
  const full = new Uint8Array(25);
  full.set(raw);
  full.set(tronChecksum(raw), 21);
  return base58Encode(full);
}
