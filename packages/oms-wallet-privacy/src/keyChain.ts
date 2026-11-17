import type { Address } from 'viem';

import { createPublicClient, fallback, http } from 'viem';
import { polygon } from 'viem/chains';

/** Reads the chain the key message is signed on (Polygon). */
export interface KeyChain {
  /** Whether the wallet's contract is deployed there. */
  isDeployed(address: Address): Promise<boolean>;
}

/** Public Polygon RPCs; any one answering is enough for a code read. */
export function createKeyChain(): KeyChain {
  const client = createPublicClient({
    chain: polygon,
    transport: fallback([http('https://polygon-bor-rpc.publicnode.com'), http()])
  });
  return {
    async isDeployed(address) {
      const code = await client.getCode({ address });
      return code !== undefined && code !== '0x';
    }
  };
}
