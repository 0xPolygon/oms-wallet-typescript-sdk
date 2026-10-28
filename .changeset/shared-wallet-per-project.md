---
'@polygonlabs/oms-wallet': patch
'@polygonlabs/oms-wallet-wagmi-connector': patch
---

`OMSWallet` instances of one project can no longer drift apart, and projects on one origin keep their own sessions.

- Creating `OMSWallet` again for the same project and environment returns the same wallet when the instances already share their stored session: the browser defaults, or the same `storage`, `credentialSigner` and `redirectAuthStorage` objects. A rotated publishable key of the same project keeps the session and sends the new key. Node defaults and per-user storage stay separate sessions. Reusing one `storage` object with a different `credentialSigner` or `redirectAuthStorage` throws `OMSWalletValidationError`.
- Stored sessions, signing keys and redirect state are kept per project and wallet API origin, so several projects or environments on one origin no longer sign each other out.
- Requests signed with one credential are sent one at a time, in order, by every client in the process (wallet and remote-access clients alike) and across tabs with Web Locks, so concurrent calls from this app are no longer rejected for a stale nonce.
- The 30-second request deadline now also covers reading the response body, so a response whose body stalls fails instead of hanging.
- The wagmi connector observes session expiry from `connect` on, so configs that never connect leave no listener.
