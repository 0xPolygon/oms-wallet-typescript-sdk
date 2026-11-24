---
'@polygonlabs/oms-server-wallet-sdk': minor
---

Add `getTransactionStatus(txnId)` to `wallet.evm`, `wallet.solana` and `wallet.tron`.

- Reads the current WaaS status of a transaction by the `txnId` from an operation's quote, returning a `TransactionStatusView` (`status`, optional `txnHash`).
- Read-only: it never changes a stored operation (use `refreshOperation` to settle one) and never creates a wallet; a family without a wallet reports `WALLET_NOT_INITIALIZED`.
- A `quoted` answer, or a `TransactionExpired` error, is not proof that nothing was broadcast while WaaS reads are still catching up after the quote expired.
