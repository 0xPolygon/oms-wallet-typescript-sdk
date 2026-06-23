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

interface OMSClientBaseParams {
    publishableKey: string;
    auth?: OmsAuthConfig;
    environment?: never;
    storage?: StorageManager;
    redirectAuthStorage?: StorageManager;
    credentialSigner?: CredentialSigner;
}

export type OMSClientParams<Auth extends OmsAuthConfig | undefined = undefined> =
    OMSClientBaseParams & (Auth extends OmsAuthConfig ? {auth: Auth} : {auth?: undefined});

type ProvidersFromAuth<Auth extends OmsAuthConfig> =
    Auth extends {oidcProviders?: infer OidcProviders}
        ? NonNullable<OidcProviders> extends Record<string, unknown>
            ? NonNullable<OidcProviders>
            : never
        : never;

class OMSClientImpl<Env extends OmsEnvironment = DefaultOmsEnvironment> {
    public readonly wallet: WalletClient<Env>;
    public readonly indexer: IndexerClient;
    public readonly supportedNetworks = supportedNetworks;

    constructor(params: OMSClientBaseParams) {
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

export type OMSClient<Env extends OmsEnvironment = DefaultOmsEnvironment> = OMSClientImpl<Env>;

interface OMSClientConstructor {
    new(params: OMSClientParams): OMSClient<DefaultOmsEnvironment>;
    new<const Auth extends OmsAuthConfig>(params: OMSClientParams<Auth>): OMSClient<OmsEnvironment<ProvidersFromAuth<Auth>>>;
    new(params: OMSClientBaseParams): OMSClient;
}

export const OMSClient: OMSClientConstructor = OMSClientImpl as unknown as OMSClientConstructor;
