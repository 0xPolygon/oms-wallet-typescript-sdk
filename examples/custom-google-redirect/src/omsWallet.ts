import { OMSWallet, defineOMSWalletAuthConfig } from '@polygonlabs/oms-wallet'
import { CUSTOM_GOOGLE_CLIENT_ID, CUSTOM_GOOGLE_ISSUER, CUSTOM_GOOGLE_REDIRECT_URI, PUBLISHABLE_KEY } from './config'

const auth = defineOMSWalletAuthConfig({
  oidcProviders: {
    google: {
      clientId: CUSTOM_GOOGLE_CLIENT_ID,
      issuer: CUSTOM_GOOGLE_ISSUER,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      scopes: ['openid', 'email', 'profile'],
      providerRedirectUri: CUSTOM_GOOGLE_REDIRECT_URI,
    },
  },
})

export const omsWallet = new OMSWallet({
  publishableKey: PUBLISHABLE_KEY,
  auth,
})
