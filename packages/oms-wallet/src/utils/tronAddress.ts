import type { Hex } from 'viem';

import { bytesToHex, sha256 } from 'viem';

import { decodeBase58 } from './base58.js';

const tronAddressPrefix = 0x41;

/**
 * Converts a Base58Check Tron address (`T…`) to the 20-byte hex account that Tron's
 * Ethereum-compatible JSON-RPC expects. Returns undefined for anything that is not a valid
 * Tron address.
 */
export function tronAddressToHex(address: string): Hex | undefined {
  const decoded = decodeBase58(address.trim());
  if (!decoded || decoded.length !== 25 || decoded[0] !== tronAddressPrefix) return undefined;

  const payload = decoded.subarray(0, 21);
  const checksum = sha256(sha256(payload, 'bytes'), 'bytes').subarray(0, 4);
  if (checksum.some((byte, index) => byte !== decoded[21 + index])) return undefined;

  return bytesToHex(payload.subarray(1));
}
