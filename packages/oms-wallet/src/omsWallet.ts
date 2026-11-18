import type { IndexerClient } from './clients/indexerClient.js';
import type { CredentialSigner } from './credentialSigner.js';
import type { StorageManager } from './storageManager.js';
import type { SignMessageParams, WalletClient } from './wallet.js';

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

/** What `OMSWallet.extend` gives an extension besides the wallet itself. */
export interface OMSWalletExtensionContext {
  /**
   * Signs a message that starts with `OMS Wallet reserved message:` with the active Ethereum
   * wallet. `WalletClient.signMessage` refuses such messages, so code that can only call
   * `signMessage`, such as a dApp connected through wagmi, cannot obtain this signature. Any code
   * that can call `OMSWallet.extend` can.
   */
  signReservedMessage(params: SignMessageParams): Promise<string>;
}

/** Adds members to an `OMSWallet`. Returned by extension packages; passed to `OMSWallet.extend`. */
export type OMSWalletExtension<E extends object> = (
  oms: OMSWallet,
  context: OMSWalletExtensionContext
) => E;

/** Members an extension cannot add or replace. */
export type OMSWalletReservedMember = 'wallet' | 'indexer' | 'extend';

const reservedMembers: ReadonlySet<string> = new Set<OMSWalletReservedMember>([
  'wallet',
  'indexer',
  'extend'
]);

/** Instances returned by `extend`, to tell members an extension added from the SDK's own. */
const extendedInstances = new WeakSet<object>();

/** Turns a repeated member name into a type error that names it. */
type OMSWalletTakenMembers<K extends PropertyKey> = {
  [P in K]?: `"${P & string}" is already on this OMSWallet`;
};

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

  /**
   * Returns a new `OMSWallet` with the members `extension` adds, for example
   * `new OMSWallet({ publishableKey }).extend(privacy())`. This instance is not changed, the
   * result is still an `OMSWallet` with the same `wallet` and `indexer`, and calls can be chained.
   * An extension cannot add `wallet`, `indexer` or `extend`, or a member the wallet already has,
   * such as one an earlier extension added; adding the same extension twice is an error.
   */
  extend<const E extends object & OMSWalletTakenMembers<OMSWalletReservedMember | keyof this>>(
    extension: OMSWalletExtension<E>
  ): this & E {
    // Read through `wallet`, not a private field: an extended instance inherits it from this one.
    // Shared clients can come from another copy of this SDK on the page, so this is not `instanceof`.
    const walletClient = this.wallet as Partial<Pick<WalletClientImpl, 'signReservedMessage'>>;
    if (typeof walletClient.signReservedMessage !== 'function') {
      throw new OMSWalletValidationError({ message: 'This OMSWallet cannot be extended' });
    }
    const signReserved = walletClient.signReservedMessage.bind(walletClient);
    const context: OMSWalletExtensionContext = {
      signReservedMessage: (params) => signReserved(params)
    };
    const added: unknown = extension(this, context);
    if (typeof added !== 'object' || added === null) {
      throw new OMSWalletValidationError({
        message: 'An OMSWallet extension must return an object'
      });
    }
    for (const key of Reflect.ownKeys(added)) {
      if (typeof key === 'string' && reservedMembers.has(key)) {
        throw new OMSWalletValidationError({
          message: `An OMSWallet extension cannot add "${key}"`
        });
      }
      if (key in this) {
        throw new OMSWalletValidationError({
          message: addedByExtension(this, key)
            ? `"${String(key)}" is already added to this OMSWallet by an extension. Add each extension once.`
            : `An OMSWallet extension cannot replace "${String(key)}"`
        });
      }
    }
    // The extended object inherits from this one, so `instanceof OMSWallet`, `wallet` and `indexer`
    // stay; the extension's members are its own, read-only properties.
    const extended = Object.create(this) as this;
    extendedInstances.add(extended);
    for (const key of Reflect.ownKeys(added)) {
      Object.defineProperty(extended, key, {
        value: (added as Record<PropertyKey, unknown>)[key],
        enumerable: true,
        writable: false,
        configurable: false
      });
    }
    return extended as this & E;
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

function addedByExtension(instance: object, key: PropertyKey): boolean {
  for (
    let owner: object | null = instance;
    owner;
    owner = Object.getPrototypeOf(owner) as object | null
  ) {
    if (Object.prototype.hasOwnProperty.call(owner, key)) return extendedInstances.has(owner);
  }
  return false;
}
