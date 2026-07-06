import {AuthMode} from "./generated/waas.gen.js";
import type {OidcAuthMode, OidcProviderConfig} from "./omsEnvironment.js";

export interface GoogleOidcProviderParams {
    clientId?: string;
    relayRedirectUri?: string;
    provider?: string;
    providerLabel?: string;
    scopes?: string[];
    authorizeParams?: Record<string, string>;
    authMode?: OidcAuthMode;
}

export interface AppleOidcProviderParams {
    clientId?: string;
    relayRedirectUri?: string;
    provider?: string;
    providerLabel?: string;
    scopes?: string[];
    authorizeParams?: Record<string, string>;
    authMode?: OidcAuthMode;
}

export const defaultGoogleClientId = "913882656162-7l4ofa0ou2hqo90umlkenhdop1f5inba.apps.googleusercontent.com";
export const defaultAppleClientId = "service.oms.polygon.technology";

export function googleOidcProvider(params: GoogleOidcProviderParams = {}): OidcProviderConfig {
    return {
        clientId: params.clientId || defaultGoogleClientId,
        issuer: 'https://accounts.google.com',
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        provider: params.provider ?? 'google',
        providerLabel: params.providerLabel ?? 'Google',
        scopes: params.scopes ?? ['openid', 'email', 'profile'],
        relayRedirectUri: params.relayRedirectUri,
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
        provider: params.provider ?? 'apple',
        providerLabel: params.providerLabel ?? 'Apple',
        scopes: params.scopes ?? ['openid', 'email'],
        relayRedirectUri: params.relayRedirectUri,
        authMode: params.authMode ?? AuthMode.AuthCodePKCE,
        authorizeParams: {
            response_mode: 'form_post',
            ...params.authorizeParams,
        },
    };
}
