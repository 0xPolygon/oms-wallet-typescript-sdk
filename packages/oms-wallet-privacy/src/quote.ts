import type { Address } from 'viem';

import type { Network } from '@polygonlabs/oms-wallet';

export type PrivacyQuoteKind = 'shield' | 'unshield' | 'privateSend';

/**
 * The terms of one shield, unshield or private send for the active wallet. Pass it to the matching
 * call before `expiresAt`; each quote can be used once. Quotes are frozen and only come from the
 * `quote*` calls.
 */
export interface PrivacyQuote<K extends PrivacyQuoteKind = PrivacyQuoteKind> {
  readonly kind: K;
  readonly network: Network;
  readonly token: Address;
  /** What the recipient (or the private balance, for a shield) receives, in base units. */
  readonly amount: bigint;
  /** The privacy fee, in the same token. Network fees are separate and reported per transaction. */
  readonly fee: bigint;
  /** `amount + fee`: what leaves the wallet (shield, private send) or the private balance. */
  readonly total: bigint;
  /** Recipient of an unshield or private send. */
  readonly to?: Address;
  /** ISO 8601. */
  readonly expiresAt: string;
}

/** Data the package needs to run a quote; never part of the public shape. */
export interface QuoteInternals {
  readonly wallet: Address;
  /** Opaque data from the privacy backend, such as its fee terms. */
  readonly backendData: unknown;
  used: boolean;
}

const internals = new WeakMap<object, QuoteInternals>();

export function createQuote<K extends PrivacyQuoteKind>(
  fields: Omit<PrivacyQuote<K>, 'total'>,
  data: { wallet: Address; backendData: unknown }
): PrivacyQuote<K> {
  const quote: PrivacyQuote<K> = Object.freeze({
    kind: fields.kind,
    network: fields.network,
    token: fields.token,
    amount: fields.amount,
    fee: fields.fee,
    total: fields.amount + fields.fee,
    ...(fields.to === undefined ? {} : { to: fields.to }),
    expiresAt: fields.expiresAt
  });
  internals.set(quote, { ...data, used: false });
  return quote;
}

/** The quote's internals, or undefined for an object that did not come from `createQuote`. */
export function quoteInternals(quote: unknown): QuoteInternals | undefined {
  return typeof quote === 'object' && quote !== null ? internals.get(quote) : undefined;
}
