import { OMSWalletValidationError } from './errors.js';

interface PublishableKeyRoute {
  prefix: string;
  apiUrl: string;
  walletImportTrustedPcr0s: ReadonlyArray<string>;
}

// Measurements are pinned to the deployed WaaS builds. Production measurements are published in
// WaaS GitHub releases; Staging can advance between releases. During rotation, publish an SDK that
// trusts both measurements before deploying the replacement, then remove the retired measurement.
const debugWalletImportPcr0s = ['0'.repeat(96)];
const stagingWalletImportPcr0s = [
  'e271fe4b26c9d58d6089b908ab713f888e6107e2cb4782ddaceea950bbec9971ccd9159e7a099bd506e04ce55c3da696'
];
const productionWalletImportPcr0s = [
  '1935cbc713f0b43060315689e87285f6ba76bcf06f26d0719735e8d674b71e0eff71dcf77fe90ab32870ef3c954973b7'
];

const publishableKeyRoutes: PublishableKeyRoute[] = [
  {
    prefix: 'pk_local_sdbx_',
    apiUrl: 'https://sandbox-api.local.polygon-dev.technology',
    walletImportTrustedPcr0s: debugWalletImportPcr0s
  },
  {
    prefix: 'pk_local_live_',
    apiUrl: 'https://api.local.polygon-dev.technology',
    walletImportTrustedPcr0s: debugWalletImportPcr0s
  },
  {
    prefix: 'pk_dev_sdbx_',
    apiUrl: 'https://sandbox-api.dev.polygon-dev.technology',
    walletImportTrustedPcr0s: debugWalletImportPcr0s
  },
  {
    prefix: 'pk_dev_live_',
    apiUrl: 'https://api.dev.polygon-dev.technology',
    walletImportTrustedPcr0s: debugWalletImportPcr0s
  },
  {
    prefix: 'pk_stg_sdbx_',
    apiUrl: 'https://sandbox-api.stg.polygon-dev.technology',
    walletImportTrustedPcr0s: stagingWalletImportPcr0s
  },
  {
    prefix: 'pk_stg_live_',
    apiUrl: 'https://api.stg.polygon-dev.technology',
    walletImportTrustedPcr0s: stagingWalletImportPcr0s
  },
  {
    prefix: 'pk_sdbx_',
    apiUrl: 'https://sandbox-api.polygon.technology',
    walletImportTrustedPcr0s: productionWalletImportPcr0s
  },
  {
    prefix: 'pk_live_',
    apiUrl: 'https://api.polygon.technology',
    walletImportTrustedPcr0s: productionWalletImportPcr0s
  }
];

export interface ParsedPublishableKey {
  projectId: string;
  walletApiUrl: string;
  indexerGatewayUrl: string;
  solanaIndexerGatewayUrl: string;
  walletImportTrustedPcr0s: ReadonlyArray<string>;
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
    solanaIndexerGatewayUrl: `${route.apiUrl}/v1/SolanaIndexerGateway/`,
    walletImportTrustedPcr0s: route.walletImportTrustedPcr0s
  };
}

function invalidPublishableKey(): OMSWalletValidationError {
  return new OMSWalletValidationError({
    message: 'Invalid publishableKey.'
  });
}
