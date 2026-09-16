---
'@polygonlabs/oms-wallet-wagmi-connector': minor
---

The wagmi connector now rejects an active Solana wallet explicitly instead of treating its address
as an Ethereum account.

When connector `transactionOptions` provide `selectFeeOption`, sponsored transactions invoke the
selector with an empty array. Return `undefined` to continue the sponsored transaction, or throw to
stop it. `FeeOptionSelector.firstAvailable` already handles this case.
