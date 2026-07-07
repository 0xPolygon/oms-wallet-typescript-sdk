import {appleOidcProvider, googleOidcProvider} from "./oidc.js";
import {parsePublishableKey} from "./publishableKey.js";
import type {AuthMode} from "./generated/waas.gen.js";

export type OidcAuthMode = AuthMode.AuthCode | AuthMode.AuthCodePKCE;

declare const omsRelayOidcProviderConfigBrand: unique symbol;

export interface OidcProviderConfigBase {
    clientId: string;
    issuer: string;
    authorizationUrl: string;
    provider?: string;
    providerLabel?: string;
    scopes?: string[];
    authorizeParams?: Record<string, string>;
    authMode?: OidcAuthMode;
}

export interface CustomOidcProviderConfig extends OidcProviderConfigBase {
    providerRedirectUri: string;
}

export interface OmsRelayOidcProviderConfig extends OidcProviderConfigBase {
    readonly [omsRelayOidcProviderConfigBrand]: "google" | "apple";
}

export type OidcProviderConfig = CustomOidcProviderConfig | OmsRelayOidcProviderConfig;

export interface OMSWalletAuthConfig<
    OidcProviders extends Record<string, OidcProviderConfig> = Record<string, OidcProviderConfig>,
> {
    oidcProviders?: OidcProviders;
}

export interface OMSWalletEnvironment<
    OidcProviders extends Record<string, OidcProviderConfig> = Record<string, OidcProviderConfig>,
> {
    walletApiUrl: string;
    indexerGatewayUrl: string;
    auth?: OMSWalletAuthConfig<OidcProviders>;
}

const defaultOidcProviders = {
    google: googleOidcProvider(),
    apple: appleOidcProvider(),
};

export const defaultOMSWalletAuthConfig = {
    oidcProviders: defaultOidcProviders,
} satisfies OMSWalletAuthConfig<typeof defaultOidcProviders>;

export type DefaultOMSWalletEnvironment = OMSWalletEnvironment<typeof defaultOidcProviders>;

type OidcProvidersFromAuth<Auth extends OMSWalletAuthConfig> =
    Auth extends {oidcProviders?: infer OidcProviders}
        ? NonNullable<OidcProviders> extends Record<string, OidcProviderConfig>
            ? NonNullable<OidcProviders>
            : never
        : never;

type ProvidersFromAuth<Auth extends OMSWalletAuthConfig | undefined> =
    Auth extends OMSWalletAuthConfig
        ? OidcProvidersFromAuth<Auth>
        : typeof defaultOidcProviders;

export function defineOMSWalletAuthConfig<const Auth extends OMSWalletAuthConfig>(auth: Auth): Auth {
    return auth;
}

export function environmentFromPublishableKey<const Auth extends OMSWalletAuthConfig | undefined>(
    publishableKey: string,
    auth?: Auth,
): OMSWalletEnvironment<ProvidersFromAuth<Auth>> {
    const parsedKey = parsePublishableKey(publishableKey);

    return {
        walletApiUrl: parsedKey.walletApiUrl,
        indexerGatewayUrl: parsedKey.indexerGatewayUrl,
        auth: auth ?? defaultOMSWalletAuthConfig,
    } as OMSWalletEnvironment<ProvidersFromAuth<Auth>>;
}
