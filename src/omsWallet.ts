import { WalletClient } from "./clients/walletClient.js";
import {
    DefaultOmsEnvironment,
    omsEnvironmentFromPublishableKey,
    OmsAuthConfig,
    OmsEnvironment,
} from "./omsEnvironment.js";
import {createDefaultStorage, StorageManager} from "./storageManager.js";
import {IndexerClient} from "./clients/indexerClient.js";
import type {CredentialSigner} from "./credentialSigner.js";
import {supportedNetworks} from "./networks.js";
import {parsePublishableKey} from "./publishableKey.js";

interface OMSWalletBaseParams {
    publishableKey: string;
    auth?: OmsAuthConfig;
    environment?: never;
    storage?: StorageManager;
    redirectAuthStorage?: StorageManager;
    credentialSigner?: CredentialSigner;
}

export type OMSWalletParams<Auth extends OmsAuthConfig | undefined = undefined> =
    OMSWalletBaseParams & (Auth extends OmsAuthConfig ? {auth: Auth} : {auth?: undefined});

type ProvidersFromAuth<Auth extends OmsAuthConfig> =
    Auth extends {oidcProviders?: infer OidcProviders}
        ? NonNullable<OidcProviders> extends Record<string, unknown>
            ? NonNullable<OidcProviders>
            : never
        : never;

class OMSWalletImpl<Env extends OmsEnvironment = DefaultOmsEnvironment> {
    public readonly wallet: WalletClient<Env>;
    public readonly indexer: IndexerClient;
    public readonly supportedNetworks = supportedNetworks;

    constructor(params: OMSWalletBaseParams) {
        const parsedKey = parsePublishableKey(params.publishableKey);
        const environment = omsEnvironmentFromPublishableKey(params.publishableKey, params.auth) as Env;
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

export type OMSWallet<Env extends OmsEnvironment = DefaultOmsEnvironment> = OMSWalletImpl<Env>;

interface OMSWalletConstructor {
    new(params: OMSWalletParams): OMSWallet<DefaultOmsEnvironment>;
    new<const Auth extends OmsAuthConfig>(params: OMSWalletParams<Auth>): OMSWallet<OmsEnvironment<ProvidersFromAuth<Auth>>>;
    new(params: OMSWalletBaseParams): OMSWallet;
}

export const OMSWallet: OMSWalletConstructor = OMSWalletImpl as unknown as OMSWalletConstructor;
