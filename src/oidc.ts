import {AuthMode} from "./generated/waas.gen.js";
import type {OidcAuthMode, OidcProviderConfig} from "./omsEnvironment.js";

export interface GoogleOidcProviderParams {
    clientId?: string;
    relayRedirectUri?: string;
    scopes?: string[];
    authorizeParams?: Record<string, string>;
    authMode?: OidcAuthMode;
}

export interface AppleOidcProviderParams {
    clientId?: string;
    relayRedirectUri?: string;
    scopes?: string[];
    authorizeParams?: Record<string, string>;
    authMode?: OidcAuthMode;
}

export const defaultGoogleClientId = "913882656162-7l4ofa0ou2hqo90umlkenhdop1f5inba.apps.googleusercontent.com";
export const defaultAppleClientId = "service.oms.polygon.technology";
export const defaultRelayRedirectUri = "https://waas-cf-relay-staging.0xsequence.workers.dev/callback";

export function googleOidcProvider(params: GoogleOidcProviderParams = {}): OidcProviderConfig {
    return {
        clientId: params.clientId || defaultGoogleClientId,
        issuer: 'https://accounts.google.com',
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        scopes: params.scopes ?? ['openid', 'email', 'profile'],
        relayRedirectUri: params.relayRedirectUri || defaultRelayRedirectUri,
        authMode: params.authMode ?? AuthMode.AuthCodePKCE,
        authorizeParams: {
            access_type: 'offline',
            prompt: 'consent',
            ...params.authorizeParams,
        },
    };
}

export function appleOidcProvider(params: AppleOidcProviderParams = {}): OidcProviderConfig {
    return {
        clientId: params.clientId || defaultAppleClientId,
        issuer: 'https://appleid.apple.com',
        authorizationUrl: 'https://appleid.apple.com/auth/authorize',
        scopes: params.scopes ?? [],
        relayRedirectUri: params.relayRedirectUri || defaultRelayRedirectUri,
        authMode: params.authMode ?? AuthMode.AuthCodePKCE,
        authorizeParams: {
            response_mode: 'query',
            ...params.authorizeParams,
        },
    };
}
