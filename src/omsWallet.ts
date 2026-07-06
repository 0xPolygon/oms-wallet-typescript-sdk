import { WalletClient } from "./clients/walletClient.js";
import {
    DefaultOMSWalletEnvironment,
    environmentFromPublishableKey,
    OMSWalletAuthConfig,
    OMSWalletEnvironment,
} from "./omsEnvironment.js";
import {createDefaultStorage, StorageManager} from "./storageManager.js";
import {IndexerClient} from "./clients/indexerClient.js";
import type {CredentialSigner} from "./credentialSigner.js";
import {supportedNetworks} from "./networks.js";
import {parsePublishableKey} from "./publishableKey.js";

interface OMSWalletBaseParams {
    publishableKey: string;
    auth?: OMSWalletAuthConfig;
    environment?: never;
    storage?: StorageManager;
    redirectAuthStorage?: StorageManager;
    credentialSigner?: CredentialSigner;
}

export type OMSWalletParams<Auth extends OMSWalletAuthConfig | undefined = undefined> =
    OMSWalletBaseParams & (Auth extends OMSWalletAuthConfig ? {auth: Auth} : {auth?: undefined});

type ProvidersFromAuth<Auth extends OMSWalletAuthConfig> =
    Auth extends {oidcProviders?: infer OidcProviders}
        ? NonNullable<OidcProviders> extends Record<string, unknown>
            ? NonNullable<OidcProviders>
            : never
        : never;

class OMSWalletImpl<Env extends OMSWalletEnvironment = DefaultOMSWalletEnvironment> {
    public readonly wallet: WalletClient<Env>;
    public readonly indexer: IndexerClient;
    public readonly supportedNetworks = supportedNetworks;

    constructor(params: OMSWalletBaseParams) {
        const parsedKey = parsePublishableKey(params.publishableKey);
        const environment = environmentFromPublishableKey(params.publishableKey, params.auth) as Env;
        const storage = params.storage ?? createDefaultStorage()

        this.wallet = new WalletClient({
            publishableKey: params.publishableKey,
            projectId: parsedKey.projectId,
            environment,
            storage,
            redirectAuthStorage: params.redirectAuthStorage,
            credentialSigner: params.credentialSigner,
        });

        this.indexer = new IndexerClient({
            publishableKey: params.publishableKey,
            environment
        });
    }
}

export type OMSWallet<Env extends OMSWalletEnvironment = DefaultOMSWalletEnvironment> = OMSWalletImpl<Env>;

interface OMSWalletConstructor {
    new(params: OMSWalletParams): OMSWallet<DefaultOMSWalletEnvironment>;
    new<const Auth extends OMSWalletAuthConfig>(params: OMSWalletParams<Auth>): OMSWallet<OMSWalletEnvironment<ProvidersFromAuth<Auth>>>;
    new(params: OMSWalletBaseParams): OMSWallet;
}

export const OMSWallet: OMSWalletConstructor = OMSWalletImpl as unknown as OMSWalletConstructor;
