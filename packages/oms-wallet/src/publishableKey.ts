import { OMSWalletValidationError } from './errors.js';

interface PublishableKeyRoute {
  prefix: string;
  apiUrl: string;
}

const publishableKeyRoutes: PublishableKeyRoute[] = [
  { prefix: 'pk_local_sdbx_', apiUrl: 'https://sandbox-api.local.polygon-dev.technology' },
  { prefix: 'pk_local_live_', apiUrl: 'https://api.local.polygon-dev.technology' },
  { prefix: 'pk_dev_sdbx_', apiUrl: 'https://sandbox-api.dev.polygon-dev.technology' },
  { prefix: 'pk_dev_live_', apiUrl: 'https://api.dev.polygon-dev.technology' },
  { prefix: 'pk_stg_sdbx_', apiUrl: 'https://sandbox-api.stg.polygon-dev.technology' },
  { prefix: 'pk_stg_live_', apiUrl: 'https://api.stg.polygon-dev.technology' },
  { prefix: 'pk_sdbx_', apiUrl: 'https://sandbox-api.polygon.technology' },
  { prefix: 'pk_live_', apiUrl: 'https://api.polygon.technology' }
];

export interface ParsedPublishableKey {
  projectId: string;
  walletApiUrl: string;
  indexerGatewayUrl: string;
  solanaIndexerGatewayUrl: string;
}

export function parsePublishableKey(publishableKey: string): ParsedPublishableKey {
  const route = publishableKeyRoutes.find(({ prefix }) => publishableKey.startsWith(prefix));
  if (!route) {
    throw invalidPublishableKey();
  }

  const keyParts = publishableKey.slice(route.prefix.length).split('_');
  if (keyParts.length !== 2 || keyParts.some((part) => part.length === 0)) {
    throw invalidPublishableKey();
  }

  return {
    projectId: `prj_${keyParts[0]}`,
    walletApiUrl: route.apiUrl,
    indexerGatewayUrl: `${route.apiUrl}/v1/IndexerGateway/`,
    solanaIndexerGatewayUrl: `${route.apiUrl}/v1/SolanaIndexerGateway/`
  };
}

function invalidPublishableKey(): OMSWalletValidationError {
  return new OMSWalletValidationError({
    message: 'Invalid publishableKey.'
  });
}
