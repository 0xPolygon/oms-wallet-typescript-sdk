---
'@polygonlabs/oms-server-wallet-sdk': minor
---

Add `getTransactionStatus(txnId)` to `wallet.evm`, `wallet.solana` and `wallet.tron`.

- Reads the current WaaS status of a transaction by the `txnId` from an operation's quote, returning a `TransactionStatusView` (`status`, optional `txnHash`).
- Read-only: it never changes a stored operation (use `refreshOperation` to settle one) and never creates a wallet; it binds existing wallets if the handle holds none, and reports `WALLET_NOT_INITIALIZED` only if the identity has no wallets at all.
- A `quoted` answer, or a `TransactionExpired` error, is not proof that nothing was broadcast while WaaS reads are still catching up after the quote expired.
