import {googleOidcProvider} from "./oidc.js";
import {parsePublishableKey} from "./publishableKey.js";

export interface OidcProviderConfig {
    clientId: string;
    issuer: string;
    authorizationUrl: string;
    scopes?: string[];
    relayRedirectUri?: string;
    authorizeParams?: Record<string, string>;
}

export interface OmsAuthConfig<
    OidcProviders extends Record<string, OidcProviderConfig> = Record<string, OidcProviderConfig>,
> {
    oidcProviders?: OidcProviders;
}

export interface OmsEnvironment<
    OidcProviders extends Record<string, OidcProviderConfig> = Record<string, OidcProviderConfig>,
> {
    walletApiUrl: string;
    indexerGatewayUrl: string;
    auth?: OmsAuthConfig<OidcProviders>;
}

const defaultOidcProviders = {
    google: googleOidcProvider(),
};

export const defaultOmsAuthConfig = {
    oidcProviders: defaultOidcProviders,
} satisfies OmsAuthConfig<typeof defaultOidcProviders>;

export type DefaultOmsEnvironment = OmsEnvironment<typeof defaultOidcProviders>;

type OidcProvidersFromAuth<Auth extends OmsAuthConfig> =
    Auth extends {oidcProviders?: infer OidcProviders}
        ? NonNullable<OidcProviders> extends Record<string, OidcProviderConfig>
            ? NonNullable<OidcProviders>
            : never
        : never;

type ProvidersFromAuth<Auth extends OmsAuthConfig | undefined> =
    Auth extends OmsAuthConfig
        ? OidcProvidersFromAuth<Auth>
        : typeof defaultOidcProviders;

export function defineOmsAuthConfig<const Auth extends OmsAuthConfig>(auth: Auth): Auth {
    return auth;
}

export function omsEnvironmentFromPublishableKey<const Auth extends OmsAuthConfig | undefined>(
    publishableKey: string,
    auth?: Auth,
): OmsEnvironment<ProvidersFromAuth<Auth>> {
    const parsedKey = parsePublishableKey(publishableKey);

    return {
        walletApiUrl: parsedKey.walletApiUrl,
        indexerGatewayUrl: parsedKey.indexerGatewayUrl,
        auth: auth ?? defaultOmsAuthConfig,
    } as OmsEnvironment<ProvidersFromAuth<Auth>>;
}
