import { OMSWalletValidationError } from './errors.js';
import { routePublishableKey } from './internal/protocol/publishableKey.js';

export interface ParsedPublishableKey {
  projectId: string;
  walletApiUrl: string;
  indexerGatewayUrl: string;
  solanaIndexerGatewayUrl: string;
  tronIndexerGatewayUrl: string;
  walletImportTrustedPcr0s: ReadonlyArray<string>;
}

export function parsePublishableKey(publishableKey: string): ParsedPublishableKey {
  const route = routePublishableKey(publishableKey);
  if (!route) {
    throw invalidPublishableKey();
  }

  return {
    projectId: route.projectId,
    walletApiUrl: route.apiUrl,
    indexerGatewayUrl: `${route.apiUrl}/v1/IndexerGateway/`,
    solanaIndexerGatewayUrl: `${route.apiUrl}/v1/SolanaIndexerGateway/`,
    tronIndexerGatewayUrl: `${route.apiUrl}/v1/TronIndexerGateway/`,
    walletImportTrustedPcr0s: route.trustedPcr0s
  };
}

function invalidPublishableKey(): OMSWalletValidationError {
  return new OMSWalletValidationError({
    message: 'Invalid publishableKey.'
  });
}
