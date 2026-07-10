import {AuthMode, type OidcAuthMode} from './types/waas.js'

declare const omsRelayOidcProviderBrand: unique symbol

/** An opaque SDK-owned OMS relay provider value. */
export interface OmsRelayOidcProvider<Provider extends 'google' | 'apple' = 'google' | 'apple'> {
    readonly provider: Provider
    readonly [omsRelayOidcProviderBrand]: true
}

/** A caller-owned OIDC provider configuration. */
export interface CustomOidcProviderConfig {
    readonly clientId: string
    readonly issuer: string
    readonly authorizationUrl: string
    readonly providerRedirectUri: string
    readonly provider?: string
    readonly providerLabel?: string
    readonly scopes?: readonly string[]
    readonly authorizeParams?: Readonly<Record<string, string>>
    readonly authMode?: OidcAuthMode
}

export type OidcProviderConfig = CustomOidcProviderConfig | OmsRelayOidcProvider

export interface ResolvedOidcProviderConfig {
    readonly clientId: string
    readonly issuer: string
    readonly authorizationUrl: string
    readonly provider?: string
    readonly providerLabel?: string
    readonly scopes?: readonly string[]
    readonly authorizeParams?: Readonly<Record<string, string>>
    readonly authMode?: OidcAuthMode
}

const defaultGoogleClientId = '913882656162-7l4ofa0ou2hqo90umlkenhdop1f5inba.apps.googleusercontent.com'
const defaultAppleClientId = 'service.oms.polygon.technology'

const googleConfiguration = Object.freeze({
    clientId: defaultGoogleClientId,
    issuer: 'https://accounts.google.com',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    provider: 'google',
    providerLabel: 'Google',
    scopes: Object.freeze(['openid', 'email', 'profile']),
    authMode: AuthMode.AuthCodePKCE,
    authorizeParams: Object.freeze({
        access_type: 'offline',
        prompt: 'consent',
    }),
} as const satisfies ResolvedOidcProviderConfig)

const appleConfiguration = Object.freeze({
    clientId: defaultAppleClientId,
    issuer: 'https://appleid.apple.com',
    authorizationUrl: 'https://appleid.apple.com/auth/authorize',
    provider: 'apple',
    providerLabel: 'Apple',
    scopes: Object.freeze(['openid', 'email']),
    authMode: AuthMode.AuthCodePKCE,
    authorizeParams: Object.freeze({
        response_mode: 'form_post',
    }),
} as const satisfies ResolvedOidcProviderConfig)

const google = Object.freeze({
    provider: 'google',
}) as OmsRelayOidcProvider<'google'>

const apple = Object.freeze({
    provider: 'apple',
}) as OmsRelayOidcProvider<'apple'>

/** Fixed OMS relay providers. Their OAuth configuration is not caller-editable. */
export const OmsRelayOidcProviders = Object.freeze({google, apple})

export function isOmsRelayOidcProvider(provider: OidcProviderConfig): provider is OmsRelayOidcProvider {
    return provider === google || provider === apple
}

export function resolveOidcProviderConfig(provider: OidcProviderConfig): ResolvedOidcProviderConfig {
    if (provider === google) return googleConfiguration
    if (provider === apple) return appleConfiguration
    if (!('providerRedirectUri' in provider)) {
        if ('clientId' in provider && 'issuer' in provider && 'authorizationUrl' in provider) {
            throw new Error('OIDC provider requires providerRedirectUri')
        }
        throw new Error('OMS relay OIDC providers must come from OmsRelayOidcProviders')
    }
    return provider
}
