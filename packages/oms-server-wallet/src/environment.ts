import { WalletError } from './errors.js';
import { routePublishableKey } from './internal/protocol/publishableKey.js';
export const CHAINS = [
  { id: 137, name: 'Polygon', symbol: 'POL', explorer: 'https://polygonscan.com' },
  { id: 42161, name: 'Arbitrum', symbol: 'ETH', explorer: 'https://arbiscan.io' },
  { id: 8453, name: 'Base', symbol: 'ETH', explorer: 'https://basescan.org' },
  { id: 56, name: 'BNB Chain', symbol: 'BNB', explorer: 'https://bscscan.com' },
  { id: 1, name: 'Ethereum', symbol: 'ETH', explorer: 'https://etherscan.io' }
] as const;
export function requireChain(id: number) {
  const chain = CHAINS.find((entry) => entry.id === id);
  if (!chain)
    throw new WalletError('UNSUPPORTED_CHAIN', 'Select one of the configured EVM networks.');
  return chain;
}
export function environmentFromKey(key: string) {
  const route = routePublishableKey(key);
  if (!route) throw new WalletError('CONFIGURATION', 'Configure a valid OMS publishable key.', 503);
  return {
    projectId: route.projectId,
    origin: route.apiUrl,
    indexerUrl: `${route.apiUrl}/v1/IndexerGateway/GetTokenBalancesDetails`,
    solanaIndexerUrl: `${route.apiUrl}/v1/SolanaIndexerGateway/GetTokenBalancesDetails`,
    tronIndexerUrl: `${route.apiUrl}/v1/TronIndexerGateway/GetTokenBalancesDetails`,
    stage: route.stage,
    mode: route.mode
  };
}
