---
'@polygonlabs/oms-server-wallet-sdk': minor
---

EVM operations no longer stay `unknown` forever, and coordinating with swaps no longer reads every operation ever stored.

- **Refused executions:** an EVM Execute that WaaS refuses before claiming the transaction is recorded as `failed` (`EXECUTE_REFUSED`) instead of `unknown`. Previously such an operation blocked `WalletSwaps` transfers and swaps on its chain with `DEBIT_PENDING`. This includes refusals from WaaS credential checks before Execute runs (invalid signature, usage limit, nonce replay), for EVM, Solana and Tron.
- **Expired quotes and ambiguous submissions:** pre-submit local quote expiry marks the operation terminal `expired` (`QUOTE_EXPIRED`, `provenUnsent: true`) without submitting. An ambiguous Execute that WaaS still reports expired two minutes past its quote's expiry stays open (`unknown`, `RECONCILIATION_REQUIRED`) and retains swap debit reservations until reconciled, rather than silently releasing reservations on an eventually-consistent read.
- **Signatures:** `signMessage` and `signTypedData` record a failed or unverified signature as `failed` with its error code; a retry under the same ID returns that record and never signs again.
- **Interrupted preparations:** an operation whose preparation was interrupted before its quote was stored is quoted again under the same ID instead of staying `preparing`.
- **Known claims are kept:** once WaaS has shown a transaction claimed (`pending`, or a transaction hash), a later stale status read (`quoted`, or `TransactionExpired`) no longer turns the operation back into `unknown` or `expired`. This also applies to Solana and Tron operations.
- **New methods:** `listOpenOperations(legacyIds?)` returns unsettled EVM operations from an index of open operations, built from existing records on first use and updated with operations an older SDK version adds to the same store, and `readOperations(ids)` returns specific stored operations. `WalletSwaps` uses them.
- **Executor check:** `WalletSwaps` throws `CONFIGURATION` when given the wallet's own executor, which would otherwise wait on itself forever.
- **Swaps:** `WalletSwaps` settles expired operations: an expired funding expires the swap (`QUOTE_EXPIRED`), an expired recovery ends that recovery (`RECOVERY_EXPIRED`) so a new review can start, and an expired owner deployment asks for a new review. A swap whose own funding failed, reverted or expired no longer keeps its origin chain reserved. Failed and expired swaps keep their error code.
