---
'@polygonlabs/oms-server-wallet-sdk': patch
---

Harden recovery deployment reconciliation, credential recovery during discovery, pre-submit expiry checks, and transport error wrapping.

- `wallet.swaps.resolveReconciliation` now resolves stuck owner-deployment transactions (`recovery.deployment.txnId`) in `RECONCILIATION_REQUIRED` and releases the chain reservation once confirmed not broadcast.
- `restore()` (ephemeral) and multi-family `createOrRestore()` automatically re-authenticate if a cached credential was revoked server-side before local expiry, and fresh `restore()` binds all existing families directly from `CompleteAuth` without an extra `ListWallets` round-trip.
- `execute` re-checks quote expiry after debit-gate and re-auth I/O so quotes expiring mid-flight settle locally as `QUOTE_EXPIRED` (`provenUnsent: true`) instead of being sent to WaaS.
- Network/timeout failures from WaaS and indexer requests, invalid UTF-8 upstream responses, and malformed base64 `encryptionKey` values now throw typed `WalletError`s (including the new `UPSTREAM_UNAVAILABLE` code) rather than raw `TypeError` or `DOMException`. The original failure is kept as the error's `cause` (the `WalletError` constructor takes an optional `{ cause }`), so logs can tell a timeout from a DNS or TLS failure.
- Included `docs/` in the published package archive so `README.md` documentation links resolve in installed packages.
