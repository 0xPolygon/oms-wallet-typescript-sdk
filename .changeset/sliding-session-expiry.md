---
'@polygonlabs/oms-wallet': minor
---

Sessions now stay signed in while they are used: the session expiry extends with activity, and sessions can last up to 180 days.

### Session expiry

- **`wallet.session.expiresAt`** is the current expiry. The wallet API extends it with use, up to the lifetime requested at sign-in, and the SDK refreshes it after restoring a session, when the local expiry is reached, and after wallet activity.
- A session whose local expiry has passed is checked with the wallet API before it ends, so protected operations can continue on an extended session.
- If the wallet API cannot be reached when the local expiry is reached, the session is kept and checked again later. Protected operations then fail with the request error (for example `OMS_REQUEST_FAILED`) instead of `OMS_SESSION_EXPIRED`.
- When the wallet API reports that the session credential no longer exists or has expired, the session ends as on local expiry: `onSessionExpired` fires once and the operation fails with `OMSWalletSessionError` (`OMS_SESSION_EXPIRED`), shaped like a local expiry (the wallet API error is its `cause`). This includes a rejected transaction execute, which never ran; a status lookup that fails after submission keeps `OMS_TRANSACTION_STATUS_LOOKUP_FAILED` and its `txnId`.

### Session lifetime

- **`MAX_SESSION_LIFETIME_SECONDS`** is now 180 days (`15552000`); `sessionLifetimeSeconds` above 30 days was previously rejected.
- **`DEFAULT_SESSION_LIFETIME_SECONDS`** is now 180 days (`15552000`), the maximum: auth requests that omit `sessionLifetimeSeconds` ask for 180 days instead of one week. A session still ends after 10 days without use, so pass a shorter `sessionLifetimeSeconds` for a hard limit. On wallet API versions without sliding expiry, the requested lifetime is clamped to the server maximum (30 days) and there is no idle timeout, so the default gives a fixed 30-day session there.
