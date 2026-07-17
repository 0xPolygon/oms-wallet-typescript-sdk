import { useCallback, useEffect, useState } from 'react';
import type { WalletSelectionBehavior } from '@polygonlabs/oms-wallet';
import { readStoredBoolean, readStoredPositiveInteger } from './example-utils';

export function useSessionPreferences({
  manualWalletSelectionKey,
  sessionLifetimeSecondsKey,
  defaultSessionLifetimeSeconds
}: {
  manualWalletSelectionKey: string;
  sessionLifetimeSecondsKey: string;
  defaultSessionLifetimeSeconds: number;
}) {
  const [useManualWalletSelection, setUseManualWalletSelection] = useState(() =>
    readStoredBoolean(manualWalletSelectionKey)
  );
  const [sessionLifetimeSeconds, setSessionLifetimeSeconds] = useState(() =>
    readStoredPositiveInteger(sessionLifetimeSecondsKey, defaultSessionLifetimeSeconds)
  );

  useEffect(() => {
    window.sessionStorage.setItem(
      manualWalletSelectionKey,
      useManualWalletSelection ? 'true' : 'false'
    );
  }, [manualWalletSelectionKey, useManualWalletSelection]);

  useEffect(() => {
    window.sessionStorage.setItem(sessionLifetimeSecondsKey, sessionLifetimeSeconds.toString());
  }, [sessionLifetimeSecondsKey, sessionLifetimeSeconds]);

  const updateSessionLifetime = useCallback((value: string) => {
    const next = Math.floor(Number(value));
    if (!Number.isFinite(next)) return;
    setSessionLifetimeSeconds(Math.max(1, next));
  }, []);

  const saveSessionPreferences = useCallback(() => {
    window.sessionStorage.setItem(
      manualWalletSelectionKey,
      useManualWalletSelection ? 'true' : 'false'
    );
    window.sessionStorage.setItem(sessionLifetimeSecondsKey, sessionLifetimeSeconds.toString());
  }, [
    manualWalletSelectionKey,
    sessionLifetimeSeconds,
    sessionLifetimeSecondsKey,
    useManualWalletSelection
  ]);

  const walletSelection: WalletSelectionBehavior = useManualWalletSelection
    ? 'manual'
    : 'automatic';

  return {
    useManualWalletSelection,
    setUseManualWalletSelection,
    sessionLifetimeSeconds,
    updateSessionLifetime,
    saveSessionPreferences,
    walletSelection
  };
}
