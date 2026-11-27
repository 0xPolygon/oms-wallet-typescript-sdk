/** Solana networks WaaS serves, by the names it uses for them. */
export const SOLANA_NETWORKS = ['solana:mainnet', 'solana:devnet'] as const;
export type SolanaNetworkName = (typeof SOLANA_NETWORKS)[number];

/** Tron networks WaaS serves, by the names it uses for them. */
export const TRON_NETWORKS = ['tron:mainnet', 'tron:nile'] as const;
export type TronNetworkName = (typeof TRON_NETWORKS)[number];

/** TIP-712 domain chain IDs of the Tron networks. */
export const TRON_CHAIN_IDS: Readonly<Record<TronNetworkName, number>> = Object.freeze({
  'tron:mainnet': 728126428,
  'tron:nile': 3448148188
});

/** One EVM network WaaS serves, identified by its chain ID (sent as the `network` parameter). */
export interface EvmNetworkDefinition {
  readonly id: number;
  readonly name: string;
  readonly nativeTokenSymbol: string;
  readonly explorerUrl: string;
  readonly displayName: string;
}

/** EVM networks WaaS serves. The client SDK's public `Networks` must list exactly these. */
export const EVM_NETWORKS = Object.freeze([
  {
    id: 1,
    name: 'mainnet',
    nativeTokenSymbol: 'ETH',
    explorerUrl: 'https://etherscan.io',
    displayName: 'Ethereum'
  },
  {
    id: 11155111,
    name: 'sepolia',
    nativeTokenSymbol: 'ETH',
    explorerUrl: 'https://sepolia.etherscan.io',
    displayName: 'Sepolia'
  },
  {
    id: 137,
    name: 'polygon',
    nativeTokenSymbol: 'POL',
    explorerUrl: 'https://polygonscan.com',
    displayName: 'Polygon'
  },
  {
    id: 80002,
    name: 'amoy',
    nativeTokenSymbol: 'POL',
    explorerUrl: 'https://amoy.polygonscan.com',
    displayName: 'Polygon Amoy'
  },
  {
    id: 42161,
    name: 'arbitrum',
    nativeTokenSymbol: 'ETH',
    explorerUrl: 'https://arbiscan.io',
    displayName: 'Arbitrum'
  },
  {
    id: 421614,
    name: 'arbitrum-sepolia',
    nativeTokenSymbol: 'ETH',
    explorerUrl: 'https://sepolia.arbiscan.io',
    displayName: 'Arbitrum Sepolia'
  },
  {
    id: 10,
    name: 'optimism',
    nativeTokenSymbol: 'ETH',
    explorerUrl: 'https://optimistic.etherscan.io',
    displayName: 'Optimism'
  },
  {
    id: 11155420,
    name: 'optimism-sepolia',
    nativeTokenSymbol: 'ETH',
    explorerUrl: 'https://sepolia-optimism.etherscan.io',
    displayName: 'Optimism Sepolia'
  },
  {
    id: 8453,
    name: 'base',
    nativeTokenSymbol: 'ETH',
    explorerUrl: 'https://basescan.org',
    displayName: 'Base'
  },
  {
    id: 84532,
    name: 'base-sepolia',
    nativeTokenSymbol: 'ETH',
    explorerUrl: 'https://sepolia.basescan.org',
    displayName: 'Base Sepolia'
  },
  {
    id: 56,
    name: 'bsc',
    nativeTokenSymbol: 'BNB',
    explorerUrl: 'https://bscscan.com',
    displayName: 'BSC'
  },
  {
    id: 97,
    name: 'bsc-testnet',
    nativeTokenSymbol: 'BNB',
    explorerUrl: 'https://testnet.bscscan.com',
    displayName: 'BSC Testnet'
  },
  {
    id: 42170,
    name: 'arbitrum-nova',
    nativeTokenSymbol: 'ETH',
    explorerUrl: 'https://nova.arbiscan.io',
    displayName: 'Arbitrum Nova'
  },
  {
    id: 43114,
    name: 'avalanche',
    nativeTokenSymbol: 'AVAX',
    explorerUrl: 'https://subnets.avax.network/c-chain',
    displayName: 'Avalanche'
  },
  {
    id: 43113,
    name: 'avalanche-testnet',
    nativeTokenSymbol: 'AVAX',
    explorerUrl: 'https://subnets-test.avax.network/c-chain',
    displayName: 'Avalanche Testnet'
  },
  {
    id: 747474,
    name: 'katana',
    nativeTokenSymbol: 'ETH',
    explorerUrl: 'https://katanascan.com',
    displayName: 'Katana'
  }
] as const satisfies readonly EvmNetworkDefinition[]);
export type EvmChainId = (typeof EVM_NETWORKS)[number]['id'];
