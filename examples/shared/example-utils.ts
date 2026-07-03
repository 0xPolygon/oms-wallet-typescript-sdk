import type {
  FeeOptionWithBalance,
  OMSWalletSessionAuth,
  PendingWalletSelection,
  WalletActivationResult,
} from '@polygonlabs/oms-wallet'

export type OidcRedirectProvider = 'google' | 'apple'

export function hasOidcCallbackParams(search: string = window.location.search): boolean {
  const params = new URLSearchParams(search)
  return params.has('code') || params.has('state') || params.has('error')
}

export function formatOidcProvider(provider: OidcRedirectProvider): string {
  return provider === 'google' ? 'Google' : 'Apple'
}

export function formatSessionAuth(
  auth: OMSWalletSessionAuth | undefined,
  fallback = 'Unknown',
): string {
  switch (auth?.type) {
    case 'email':
      return 'Email'
    case 'oidc':
      return auth.providerLabel ?? auth.provider ?? auth.issuer
    default:
      return fallback
  }
}

export function formatSessionExpiry(expiresAt: string | undefined): string {
  if (!expiresAt) return 'Unknown'

  const date = new Date(expiresAt)
  return Number.isNaN(date.getTime()) ? expiresAt : date.toLocaleString()
}

export function formatWalletType(walletType: string): string {
  return walletType
    .split(/[-_]/)
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ')
}

export function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

export function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}...${hash.slice(-8)}`
}

export function canAffordFeeOption(option: FeeOptionWithBalance): boolean {
  if (option.availableRaw === undefined) return false

  try {
    return BigInt(option.availableRaw) >= BigInt(option.feeOption.value)
  } catch {
    return false
  }
}

export function isPendingWalletSelection(
  result: PendingWalletSelection | WalletActivationResult,
): result is PendingWalletSelection {
  return 'selectWallet' in result
}

export function readStoredBoolean(key: string): boolean {
  return window.sessionStorage.getItem(key) === 'true'
}

export function readStoredPositiveInteger(key: string, fallback: number): number {
  const stored = window.sessionStorage.getItem(key)
  if (!stored) return fallback

  const parsed = Number(stored)
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallback
}
