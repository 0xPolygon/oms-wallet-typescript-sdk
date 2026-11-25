---
'@polygonlabs/oms-server-wallet-sdk': minor
---

Add in-memory wallets: `createEphemeralServerWallet` and `createEphemeralServerWalletService` give the full wallet API without storage, an encryption key or a distributed lock.

- **Same API as `createServerWallet`:** transfers, contract calls, `send*` with `approval: 'allow-immediate'`, `cancel`, waits, signing (typed data behind `signing`), balances and Trails swaps (`swaps: trails(...)`). Each handle signs in with its own credential and keeps it, its wallets and its operation records in memory, so handles in different processes run in parallel; calls on one handle run one at a time.
- **Records last as long as the handle.** `idempotencyKey` protects retries on that handle only. Save the `txnId` in `onPrepared` and recover with `getTransactionStatus` or `waitForTransaction`, which work from any handle.
- **Wallet creation is explicit:** `restore()` and transactions never create wallets; `create()` does, and concurrent `create()` calls in one process run one at a time. WaaS does not deduplicate wallet creation, so create a user's wallets in one place, such as signup.
- **`close()`** revokes the handle's credential; every later or queued call throws `WALLET_CLOSED`. Credentials default to a one-hour lifetime. There is no `disable()`.
- **`createEphemeralServerWalletService`** keeps one handle per user in a bounded cache (`cache: { maxHandles, idleTimeoutMs }`), so a request reuses its credential; `evict(subject)` and `close()` revoke.
- `getIdToken` must mint a fresh ID token on every call: WaaS rejects a token that was already used to sign in.

Revoking a credential (`rotateCredential`, `disable`, `close`) now also revokes one whose sign-in failed part way, which was previously left valid until it expired.
