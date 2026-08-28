import { Networks } from '@polygonlabs/oms-wallet';

import type { Address } from 'viem';

export type SmartSessionNetworkId = 'polygon-amoy' | 'polygon';
export type SmartSessionAssetId = 'pol' | 'usdc' | 'usdt';

export const SMART_SESSION_ASSETS = {
  pol: {
    id: 'pol',
    symbol: 'POL',
    name: 'POL',
    decimals: 18,
    kind: 'native',
    defaultAllowance: '0.01',
    defaultTransferAmount: '0.001'
  },
  usdc: {
    id: 'usdc',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    kind: 'erc20',
    tokenAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as Address,
    defaultAllowance: '10',
    defaultTransferAmount: '1'
  },
  usdt: {
    id: 'usdt',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    kind: 'erc20',
    tokenAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' as Address,
    defaultAllowance: '10',
    defaultTransferAmount: '1'
  }
} as const;

export const SMART_SESSION_NETWORKS = {
  'polygon-amoy': {
    id: 'polygon-amoy',
    name: 'Polygon Amoy',
    shortName: 'Amoy',
    network: Networks.amoy,
    assetIds: ['pol']
  },
  polygon: {
    id: 'polygon',
    name: 'Polygon',
    shortName: 'Polygon',
    network: Networks.polygon,
    assetIds: ['pol', 'usdc', 'usdt']
  }
} as const;

export type SmartSessionAsset = (typeof SMART_SESSION_ASSETS)[SmartSessionAssetId];
export type SmartSessionNetwork = (typeof SMART_SESSION_NETWORKS)[SmartSessionNetworkId];

export function getSmartSessionNetwork(id: SmartSessionNetworkId): SmartSessionNetwork {
  return SMART_SESSION_NETWORKS[id];
}

export function getSmartSessionAsset(
  networkId: SmartSessionNetworkId,
  assetId: SmartSessionAssetId
): SmartSessionAsset {
  const network = getSmartSessionNetwork(networkId);
  if (!(network.assetIds as ReadonlyArray<SmartSessionAssetId>).includes(assetId)) {
    throw new Error(`${assetId} is not available on ${network.name}`);
  }
  return SMART_SESSION_ASSETS[assetId];
}

export function isSmartSessionNetworkId(value: string): value is SmartSessionNetworkId {
  return Object.hasOwn(SMART_SESSION_NETWORKS, value);
}

export function isSmartSessionAssetId(value: string): value is SmartSessionAssetId {
  return Object.hasOwn(SMART_SESSION_ASSETS, value);
}
