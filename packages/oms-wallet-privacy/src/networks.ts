import type { Address, Hex } from 'viem';

import type { Network } from '@polygonlabs/oms-wallet';

import { Networks } from '@polygonlabs/oms-wallet';

/**
 * Contracts a privacy deposit may approve or call, per network. Kept here rather than read from
 * the privacy backend, so a changed backend cannot widen what the wallet is allowed to send; the
 * backend's own addresses are checked against these at setup.
 */
export interface PrivacyContracts {
  /** Holds private balances; receives shield deposits and is the shield approval spender. */
  readonly pool: Address;
  /** Approval spender for private-send deposits. */
  readonly sendSpender: Address;
  /** Selector of the pool's deposit function. */
  readonly depositSelector: Hex;
}

const POOL: Address = '0x7cb60446d7635C68EDf1c568cac74A1f98c1Cfa4';
const DEPOSIT_SELECTOR: Hex = '0x50fe69df';

const contractsByChainId: ReadonlyMap<number, PrivacyContracts> = new Map([
  [
    Networks.mainnet.id,
    {
      pool: POOL,
      sendSpender: '0x6D9e70F10b93a0E81ae643d0365B517D921ed60d',
      depositSelector: DEPOSIT_SELECTOR
    }
  ],
  [
    Networks.bsc.id,
    {
      pool: POOL,
      sendSpender: '0x5c678009c53b154dE1baE9a0b6daE5eB9cE902B0',
      depositSelector: DEPOSIT_SELECTOR
    }
  ],
  [
    Networks.polygon.id,
    {
      pool: POOL,
      sendSpender: '0x35AfB32e5a7d907f2ca0C8C37808A9274B96A198',
      depositSelector: DEPOSIT_SELECTOR
    }
  ],
  [
    Networks.base.id,
    {
      pool: POOL,
      sendSpender: '0x6aD588Db8687516E626b037F7a4bc754D8f7d5B1',
      depositSelector: DEPOSIT_SELECTOR
    }
  ],
  [
    Networks.arbitrum.id,
    {
      pool: POOL,
      sendSpender: '0x0e763c56f1f58Ad85590394522B42019fb353EcC',
      depositSelector: DEPOSIT_SELECTOR
    }
  ]
] satisfies Array<[number, PrivacyContracts]>);

export const privacyNetworks: ReadonlyArray<Network> = Object.freeze([
  Networks.mainnet,
  Networks.bsc,
  Networks.polygon,
  Networks.base,
  Networks.arbitrum
]);

export function privacyContracts(network: Network): PrivacyContracts | undefined {
  return contractsByChainId.get(network.id);
}
