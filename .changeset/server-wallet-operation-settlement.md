---
'@polygonlabs/oms-server-wallet-sdk': minor
---

EVM operations no longer stay `unknown` forever, and coordinating with swaps no longer reads every operation ever stored.

- **Refused executions:** an EVM Execute that WaaS refuses before claiming the transaction is recorded as `failed` (`EXECUTE_REFUSED`) instead of `unknown`. Previously such an operation blocked `WalletSwaps` transfers and swaps on its chain with `DEBIT_PENDING`.
- **Expired quotes:** EVM operations gain the `expired` status. An operation WaaS still reports expired and unclaimed two minutes past its quote's expiry becomes `expired` instead of failing every `getOperation`, and executing a quote known to be expired marks it `expired` as well as raising `QUOTE_EXPIRED`.
- **Signatures:** `signMessage` and `signTypedData` record a failed or unverified signature as `failed` with its error code; a retry under the same ID returns that record and never signs again.
- **Interrupted preparations:** an operation whose preparation was interrupted before its quote was stored is quoted again under the same ID instead of staying `preparing`.
- **New methods:** `listOpenOperations(legacyIds?)` returns unsettled EVM operations from an index of open operations, built from existing records on first use, and `readOperations(ids)` returns specific stored operations. `WalletSwaps` uses them.
- **Executor check:** `WalletSwaps` throws `CONFIGURATION` when given the wallet's own executor, which would otherwise wait on itself forever.
