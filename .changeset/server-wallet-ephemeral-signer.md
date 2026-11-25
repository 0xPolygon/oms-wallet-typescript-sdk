---
'@polygonlabs/oms-server-wallet-sdk': minor
---

Add `createEphemeralServerWallet`, a memory-only signer that needs no storage, encryption key or distributed lock.

- Each handle signs in with its own credential, so one handle per concurrent worker signs in parallel.
- It signs messages and typed data on EVM, Solana and Tron and reads balances. It cannot prepare or send transactions, keeps no operation records, and never creates wallets: provision wallets with `createServerWallet` first, then call `restore()`.
- `close()` revokes the handle's credential; every later or queued call throws the new `WALLET_CLOSED` error. Credentials default to a 15-minute lifetime.
- `signTypedData` exists only with a `signing` policy, as on durable wallets, and refuses Sequence wallet `Calls` and typed data whose `verifyingContract` is the wallet.
- The handle is not assignable to `ServerWallet` and has no `disable()`, `execute` or `send*`.
- `getIdToken` must mint a fresh ID token on every call: WaaS rejects a token that was already used to sign in.

Revoking a credential (`rotateCredential`, `disable`, `close`) now also revokes one whose sign-in failed part way, which was previously left valid until it expired.
