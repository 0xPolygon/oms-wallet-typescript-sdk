import {AuthMode} from "./generated/waas.gen.js";
import type {OidcAuthMode, OmsRelayOidcProviderConfig} from "./omsEnvironment.js";

export type OmsRelayOidcProvider = "google" | "apple";

export interface GoogleOidcProviderParams {
    clientId?: string;
    provider?: string;
    providerLabel?: string;
    scopes?: string[];
    authorizeParams?: Record<string, string>;
    authMode?: OidcAuthMode;
}

export interface AppleOidcProviderParams {
    clientId?: string;
    provider?: string;
    providerLabel?: string;
    scopes?: string[];
    authorizeParams?: Record<string, string>;
    authMode?: OidcAuthMode;
}

export const defaultGoogleClientId = "913882656162-7l4ofa0ou2hqo90umlkenhdop1f5inba.apps.googleusercontent.com";
export const defaultAppleClientId = "service.oms.polygon.technology";

const defaultRelayProviderSymbol = Symbol("defaultRelayProvider");

type DefaultRelayOidcProviderConfig = OmsRelayOidcProviderConfig & {
    [defaultRelayProviderSymbol]?: OmsRelayOidcProvider;
}

function withDefaultRelayProvider(
    config: OmsRelayOidcProviderConfig,
    provider: OmsRelayOidcProvider,
): OmsRelayOidcProviderConfig {
    return Object.defineProperty(config, defaultRelayProviderSymbol, {value: provider});
}

export function defaultRelayProviderForOidcProvider(
    config: unknown,
): OmsRelayOidcProvider | undefined {
    return (config as DefaultRelayOidcProviderConfig)[defaultRelayProviderSymbol];
}

export function googleOidcProvider(params: GoogleOidcProviderParams = {}): OmsRelayOidcProviderConfig {
    return withDefaultRelayProvider({
        clientId: params.clientId || defaultGoogleClientId,
        issuer: 'https://accounts.google.com',
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        provider: params.provider ?? 'google',
        providerLabel: params.providerLabel ?? 'Google',
        scopes: params.scopes ?? ['openid', 'email', 'profile'],
        authMode: params.authMode ?? AuthMode.AuthCodePKCE,
        authorizeParams: {
            access_type: 'offline',
            prompt: 'consent',
            ...params.authorizeParams,
        },
    } as unknown as OmsRelayOidcProviderConfig, "google");
}

export function appleOidcProvider(params: AppleOidcProviderParams = {}): OmsRelayOidcProviderConfig {
    return withDefaultRelayProvider({
        clientId: params.clientId || defaultAppleClientId,
        issuer: 'https://appleid.apple.com',
        authorizationUrl: 'https://appleid.apple.com/auth/authorize',
        provider: params.provider ?? 'apple',
        providerLabel: params.providerLabel ?? 'Apple',
        scopes: params.scopes ?? ['openid', 'email'],
        authMode: params.authMode ?? AuthMode.AuthCodePKCE,
        authorizeParams: {
            response_mode: 'form_post',
            ...params.authorizeParams,
        },
    } as unknown as OmsRelayOidcProviderConfig, "apple");
}
