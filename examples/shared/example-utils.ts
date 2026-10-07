import {
  WalletType,
  type FeeOptionWithBalance,
  type OMSWallet,
  type OMSWalletSessionAuth,
  type PendingWalletSelection,
  type WalletAccount,
  type WalletActivationResult
} from '@polygonlabs/oms-wallet';

export type OidcRedirectProvider = 'google' | 'apple';

export function hasOidcCallbackParams(search: string = window.location.search): boolean {
  const params = new URLSearchParams(search);
  return params.has('code') || params.has('state') || params.has('error');
}

export function formatOidcProvider(provider: OidcRedirectProvider): string {
  return provider === 'google' ? 'Google' : 'Apple';
}

export function formatSessionAuth(
  auth: OMSWalletSessionAuth | undefined,
  fallback = 'Unknown'
): string {
  switch (auth?.type) {
    case 'email':
      return 'Email';
    case 'oidc': {
      const provider = auth.providerLabel ?? auth.provider ?? auth.issuer;
      const flow = auth.flow === 'id-token' ? 'ID token' : 'Redirect';
      return `${provider} (${flow})`;
    }
    default:
      return fallback;
  }
}

export function formatSessionExpiry(expiresAt: string | undefined): string {
  if (!expiresAt) return 'Unknown';

  const date = new Date(expiresAt);
  return Number.isNaN(date.getTime()) ? expiresAt : date.toLocaleString();
}

export function formatWalletType(walletType: string): string {
  return walletType
    .split(/[-_]/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

export function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}...${hash.slice(-8)}`;
}

export function canAffordFeeOption(option: FeeOptionWithBalance): boolean {
  if (option.availableRaw === undefined) return false;

  try {
    return BigInt(option.availableRaw) >= BigInt(option.feeOption.value);
  } catch {
    return false;
  }
}

export function isPendingWalletSelection(
  result: PendingWalletSelection | WalletActivationResult
): result is PendingWalletSelection {
  return 'selectWallet' in result;
}

export function activeEthereumAddress(wallet: OMSWallet['wallet']): string | undefined {
  const active = wallet.activeWallet;
  return active?.type === WalletType.Ethereum ? active.address : undefined;
}

// The browser examples share localhost storage, so a restored session can have another
// example's non-Ethereum wallet active. EVM-only examples switch back to an Ethereum wallet,
// creating one if the account has none.
export async function switchToEthereumWallet(
  wallet: OMSWallet['wallet']
): Promise<WalletAccount | undefined> {
  const active = wallet.activeWallet;
  if (!active || active.type === WalletType.Ethereum) return active;
  const existing = (await wallet.listWallets()).find(
    (account) => account.type === WalletType.Ethereum
  );
  const result = existing
    ? await wallet.useWallet({ walletId: existing.id })
    : await wallet.createWallet({ type: WalletType.Ethereum });
  return result.wallet;
}

export function readStoredBoolean(key: string): boolean {
  return window.sessionStorage.getItem(key) === 'true';
}

export function readStoredPositiveInteger(key: string, fallback: number): number {
  const stored = window.sessionStorage.getItem(key);
  if (!stored) return fallback;

  const parsed = Number(stored);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
