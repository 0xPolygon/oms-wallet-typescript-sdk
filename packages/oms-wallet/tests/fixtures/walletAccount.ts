import type { WalletAccount } from '../../src/index.js';

/**
 * Builds a wallet account for seeding sessions. Addresses without a `0x` prefix default to Solana;
 * pass `type` for Tron.
 */
export function testWalletAccount(
  id: string,
  address: string,
  type: WalletAccount['type'] = address.startsWith('0x') ? 'ethereum' : 'solana'
): WalletAccount {
  return { id, type, address, keyOrigin: 'enclave' } as WalletAccount;
}
