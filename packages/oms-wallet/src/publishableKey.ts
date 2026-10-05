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
  '3d21c70519a0ea3d5e6af43c5323234d90755d1ca08431064bd9687ddde4a4788a0a4736701513eee6008f1ec17e0d23'
];
const productionWalletImportPcr0s = [
  '1935cbc713f0b43060315689e87285f6ba76bcf06f26d0719735e8d674b71e0eff71dcf77fe90ab32870ef3c954973b7',
  '66d0d20073ec8549b6eb1cd3cd53311495225ec79d68f168ab734b24a69a8ed0f890f85ff31d5f0a79486a4e3a303b3c'
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
