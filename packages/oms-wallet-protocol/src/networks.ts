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
