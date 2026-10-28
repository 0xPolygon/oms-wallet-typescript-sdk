export const Constants = {
  sessionStorageKey: 'omsWallet_session',
  redirectAuthStorageKey: 'omsWallet_oidc_redirect_auth',
  /** Last session-signed request time shared by clients (tabs) signing with the same key. */
  sessionActivityStorageKey: 'omsWallet_session_activity'
} as const;
