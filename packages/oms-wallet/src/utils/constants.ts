export const Constants = {
  sessionStorageKey: 'omsWallet_session',
  redirectAuthStorageKey: 'omsWallet_oidc_redirect_auth'
} as const;

/**
 * The storage keys of one project's session on one wallet API origin. Scoping them keeps the
 * sessions of several projects, or environments, on one origin apart.
 */
export function sessionStorageKeys(projectId: string, walletApiUrl: string) {
  const scope = `${projectId}@${new URL(walletApiUrl).origin}`;
  return {
    /** The session scope these keys belong to. */
    scope,
    session: `${Constants.sessionStorageKey}:${scope}`,
    redirectAuth: `${Constants.redirectAuthStorageKey}:${scope}`,
    /** The IndexedDB record of the default WebCrypto signing key. */
    webCryptoCredential: `webcrypto-p256:${scope}`
  };
}

export type SessionStorageKeys = ReturnType<typeof sessionStorageKeys>;
