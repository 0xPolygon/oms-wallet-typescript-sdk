import type { IndexerClient } from './clients/indexerClient.js';
import type { CredentialSigner } from './credentialSigner.js';
import type { StorageManager } from './storageManager.js';
import type { WalletClient } from './wallet.js';

import { IndexerClientImpl } from './clients/indexerClient.js';
import { WalletClientImpl } from './clients/walletClient.js';
import { environmentFromPublishableKey } from './omsEnvironment.js';
import { parsePublishableKey } from './publishableKey.js';
import { createDefaultStorage } from './storageManager.js';

export interface OMSWalletParams {
  publishableKey: string;
  storage?: StorageManager;
  redirectAuthStorage?: StorageManager;
  credentialSigner?: CredentialSigner;
}

export class OMSWallet {
  public readonly wallet: WalletClient;
  public readonly indexer: IndexerClient;

  constructor(params: OMSWalletParams) {
    const parsedKey = parsePublishableKey(params.publishableKey);
    const environment = environmentFromPublishableKey(params.publishableKey);
    const storage = params.storage ?? createDefaultStorage();

    this.wallet = new WalletClientImpl({
      publishableKey: params.publishableKey,
      projectId: parsedKey.projectId,
      environment,
      storage,
      redirectAuthStorage: params.redirectAuthStorage,
      credentialSigner: params.credentialSigner,
      walletImportTrustedPcr0s: parsedKey.walletImportTrustedPcr0s
    });

    this.indexer = new IndexerClientImpl({
      publishableKey: params.publishableKey,
      environment
    });
  }
}
