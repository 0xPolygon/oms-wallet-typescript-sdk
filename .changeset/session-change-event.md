---
'@polygonlabs/oms-wallet': minor
'@polygonlabs/oms-wallet-wagmi-connector': minor
---

Replace `onSessionExpired` with `onSessionChange`, which reports every change of `activeWallet` or `session` (sign-in, wallet switch, expiry update, sign-out, or expiry) with a reason, including changes made in other tabs, which now stay in sync. `activeWallet` and `session` return the same frozen object until they change, so they work with React's `useSyncExternalStore`. The wagmi connector follows the session while connected: it disconnects when the session ends and changes the account when another Ethereum wallet becomes active. This is a breaking change; see `MIGRATION.md`.
