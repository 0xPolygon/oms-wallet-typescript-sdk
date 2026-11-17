import { Networks, type Network } from '@polygonlabs/oms-wallet';
import { type Address, formatUnits, parseUnits, zeroAddress } from 'viem';

export interface DemoToken {
  readonly symbol: string;
  /** `zeroAddress` for the native token. */
  readonly address: Address;
  readonly decimals: number;
}

/** The native token and USDC on each network with private balances. */
const TOKENS_BY_CHAIN_ID: ReadonlyMap<number, ReadonlyArray<DemoToken>> = new Map([
  [
    Networks.mainnet.id,
    [
      { symbol: 'ETH', address: zeroAddress, decimals: 18 },
      { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 }
    ]
  ],
  [
    Networks.bsc.id,
    [
      { symbol: 'BNB', address: zeroAddress, decimals: 18 },
      { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 }
    ]
  ],
  [
    Networks.polygon.id,
    [
      { symbol: 'POL', address: zeroAddress, decimals: 18 },
      { symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 }
    ]
  ],
  [
    Networks.base.id,
    [
      { symbol: 'ETH', address: zeroAddress, decimals: 18 },
      { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 }
    ]
  ],
  [
    Networks.arbitrum.id,
    [
      { symbol: 'ETH', address: zeroAddress, decimals: 18 },
      { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 }
    ]
  ]
]);

export function tokensFor(network: Network): ReadonlyArray<DemoToken> {
  return TOKENS_BY_CHAIN_ID.get(network.id) ?? [];
}

export function findToken(network: Network, address: Address): DemoToken | undefined {
  return tokensFor(network).find((token) => token.address.toLowerCase() === address.toLowerCase());
}

export function formatAmount(amount: bigint, token: DemoToken | undefined): string {
  if (!token) return amount.toString();
  return `${formatUnits(amount, token.decimals)} ${token.symbol}`;
}

/** Parses a decimal amount, or returns undefined when it is not a positive number. */
export function parseAmount(value: string, token: DemoToken): bigint | undefined {
  try {
    const amount = parseUnits(value.trim(), token.decimals);
    return amount > 0n ? amount : undefined;
  } catch {
    return undefined;
  }
}

export function explorerTxUrl(network: Network, txnHash: string): string {
  return `${network.explorerUrl}/tx/${txnHash}`;
}
