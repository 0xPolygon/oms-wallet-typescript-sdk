import type { WalletAccount } from '../../src/index.js';

/** Builds a wallet account for seeding sessions; non-hex addresses default to Solana. */
export function testWalletAccount(
  id: string,
  address: string,
  type: WalletAccount['type'] = address.startsWith('0x') ? 'ethereum' : 'solana'
): WalletAccount {
  return { id, type, address, keyOrigin: 'enclave' } as WalletAccount;
}
