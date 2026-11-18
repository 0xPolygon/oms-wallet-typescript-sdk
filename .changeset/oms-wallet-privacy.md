---
'@polygonlabs/oms-wallet': minor
'@polygonlabs/oms-wallet-privacy': minor
---

Add private balances through the new `@polygonlabs/oms-wallet-privacy` package, and the extension support it needs in the SDK.

### `@polygonlabs/oms-wallet-privacy`

- **`new OMSWallet(...).extend(privacy())`** adds `oms.privacy` for Ethereum wallets on Ethereum, BNB Chain, Polygon, Base and Arbitrum.
- **`shield`**, **`unshield`** and **`privateSend`** take a quote from `quoteShield`, `quoteUnshield` and `quotePrivateSend` with the privacy fee and `total`; quotes expire after 5 minutes and are single-use.
- **`getBalances`** returns spendable and recoverable private balances; **`recover`** pays undelivered private sends back to the wallet; **`getDeliveryStatus`** reports a private send's delivery.
- Private-balance keys are derived from the wallet key's own signature inside the wallet's signature over a reserved message, so they stay the same when the wallet is deployed or its configuration changes (such as remote access being granted, revoked or expiring). No wallet transaction is needed to set up keys.
- Deposits may only approve and call allowlisted contracts, and approve no more than the quoted `total`. Each wallet transaction is reported through `onProgress` before it is submitted, and errors (`OMSWalletPrivacyError`) list every wallet transaction created.

### `@polygonlabs/oms-wallet`

- **`OMSWallet.extend(...extensions)`** returns an `OMSWallet` with the read-only members one or more extensions add, without changing the original. An extension returns a plain object; adding the same extension twice is an error that names the member. New types: `OMSWalletExtension`, `OMSWalletExtensionContext`, `OMSWalletExtensionMembers`, `OMSWalletReservedMember`.
- `sendTransaction`, `signMessage` and `signTypedData` now act for the wallet that was active when they were called, with the arguments they were called with: every request they make (Prepare, Execute, signing) is for that wallet, or they fail with `OMSWalletSessionError` instead of acting for a wallet that became active since.
- **`onPrepared(txnId)`** on `sendTransaction` runs after the transaction is prepared and before it is executed; throwing stops it.
- `signMessage` now refuses messages that start with `OMS Wallet reserved message:` (as text or hex) with `OMS_VALIDATION_ERROR`. Extensions sign them through `context.signReservedMessage`.
