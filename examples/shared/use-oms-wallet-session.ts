import { useCallback, useSyncExternalStore } from 'react';

import type { OMSWalletSession, WalletAccount, WalletClient } from '@polygonlabs/oms-wallet';

/**
 * The active wallet and session, kept current by `onSessionChange`. React subscribes before it
 * reads, and the getters return the same object until something changes, so no change is missed
 * and nothing re-renders without one: a sign-in, a wallet switch, an expiry update, a sign-out or
 * an expiry, here or in another tab.
 */
export function useOMSWalletSession(wallet: WalletClient): {
  activeWallet: WalletAccount | undefined;
  session: OMSWalletSession | undefined;
} {
  const subscribe = useCallback(
    (onChange: () => void) => wallet.onSessionChange(onChange),
    [wallet]
  );
  const activeWallet = useSyncExternalStore(subscribe, () => wallet.activeWallet);
  const session = useSyncExternalStore(subscribe, () => wallet.session);
  return { activeWallet, session };
}
