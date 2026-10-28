import type { IndexerClient } from './clients/indexerClient.js';
import type { CredentialSigner } from './credentialSigner.js';
import type { StorageManager } from './storageManager.js';
import type { WalletClient } from './wallet.js';

import { IndexerClientImpl } from './clients/indexerClient.js';
import { WalletClientImpl } from './clients/walletClient.js';
import { OMSWalletValidationError } from './errors.js';
import { environmentFromPublishableKey } from './omsEnvironment.js';
import { parsePublishableKey } from './publishableKey.js';
import { LocalStorageManager, createDefaultStorage } from './storageManager.js';
import { sessionStorageKeys } from './utils/constants.js';

export interface OMSWalletParams {
  publishableKey: string;
  storage?: StorageManager;
  redirectAuthStorage?: StorageManager;
  credentialSigner?: CredentialSigner;
}

export class OMSWallet {
  public readonly wallet: WalletClient;
  public readonly indexer: IndexerClient;

  /**
   * Instances that already share their stored session, the same project and environment with the
   * same storage, signer and redirect storage, share one wallet client, so they cannot drift apart.
   * That covers the browser defaults (localStorage and the IndexedDB signing key) and the same
   * custom objects. Instances whose session lives only in memory, such as the defaults in Node, stay
   * separate sessions.
   */
  constructor(params: OMSWalletParams) {
    const parsedKey = parsePublishableKey(params.publishableKey);
    const environment = environmentFromPublishableKey(params.publishableKey);
    const registry = sharedClientRegistry();
    const scope = sessionStorageKeys(parsedKey.projectId, environment.walletApiUrl).scope;
    const storageIdentity =
      params.storage ?? (LocalStorageManager.isAvailable() ? registry.defaults : undefined);
    // The default signer keeps its key in IndexedDB; without it, each one holds its own key.
    const signerIdentity =
      params.credentialSigner ?? (typeof indexedDB !== 'undefined' ? registry.defaults : undefined);
    const redirectAuthStorageIdentity = params.redirectAuthStorage ?? registry.defaults;

    const shared = storageIdentity && registry.byScope.get(scope)?.get(storageIdentity);
    if (shared) {
      if (
        shared.signer === undefined ||
        shared.signer !== signerIdentity ||
        shared.redirectAuthStorage !== redirectAuthStorageIdentity
      ) {
        throw new OMSWalletValidationError({
          message:
            'This storage already holds the wallet session of another OMSWallet for this project, ' +
            'with a different credentialSigner or redirectAuthStorage. Pass the same objects to use ' +
            'that wallet, or a separate storage for a separate session.'
        });
      }
      // The session belongs to the project and environment, not to a key, so a rotated key keeps it.
      shared.wallet.usePublishableKey(params.publishableKey);
      shared.indexer.usePublishableKey(params.publishableKey);
      this.wallet = shared.wallet;
      this.indexer = shared.indexer;
      return;
    }

    const wallet = new WalletClientImpl({
      publishableKey: params.publishableKey,
      projectId: parsedKey.projectId,
      environment,
      storage: params.storage ?? createDefaultStorage(),
      redirectAuthStorage: params.redirectAuthStorage,
      credentialSigner: params.credentialSigner,
      walletImportTrustedPcr0s: parsedKey.walletImportTrustedPcr0s
    });
    const indexer = new IndexerClientImpl({
      publishableKey: params.publishableKey,
      environment
    });
    if (storageIdentity) {
      let byStorage = registry.byScope.get(scope);
      if (!byStorage) {
        byStorage = new WeakMap();
        registry.byScope.set(scope, byStorage);
      }
      byStorage.set(storageIdentity, {
        wallet,
        indexer,
        signer: signerIdentity,
        redirectAuthStorage: redirectAuthStorageIdentity
      });
    }
    this.wallet = wallet;
    this.indexer = indexer;
  }
}

/** The clients of one shared wallet, and the signer and redirect storage they were built with. */
interface SharedClients {
  wallet: WalletClientImpl;
  indexer: IndexerClientImpl;
  /** Undefined for a default signer that holds its key only in memory: no other instance has it. */
  signer: object | undefined;
  redirectAuthStorage: object;
}

/**
 * Shared clients by session scope and then by storage. Weakly keyed by storage, so the custom storage
 * of a per-user server instance, and its client, are not kept alive by the registry.
 */
interface SharedClientRegistry {
  /** Stands for each default (storage, signer, redirect storage) in the keys and comparisons. */
  defaults: object;
  byScope: Map<string, WeakMap<object, SharedClients>>;
}

/** On `globalThis`, so the copies of this SDK version on one page share it. */
const sharedClientRegistryKey = Symbol.for('@polygonlabs/oms-wallet/shared-clients/v1');

function sharedClientRegistry(): SharedClientRegistry {
  const holder = globalThis as { [sharedClientRegistryKey]?: SharedClientRegistry };
  holder[sharedClientRegistryKey] ??= { defaults: {}, byScope: new Map() };
  return holder[sharedClientRegistryKey];
}
