import { OMSWallet, type Network } from '@polygonlabs/oms-wallet';

import type { Address } from 'viem';

export interface VerifySessionRevocationParams {
  publishableKey: string;
  network: Network;
  walletAddress: Address;
  message: string;
  signature: string;
}

export function verifySessionRevocation(params: VerifySessionRevocationParams): Promise<boolean> {
  return new OMSWallet({ publishableKey: params.publishableKey }).wallet.isValidMessageSignature({
    network: params.network,
    walletAddress: params.walletAddress,
    message: params.message,
    signature: params.signature
  });
}
