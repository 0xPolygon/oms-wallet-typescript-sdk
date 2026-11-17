---
'@polygonlabs/oms-wallet': minor
'@polygonlabs/oms-wallet-privacy': minor
---

Add private balances through the new `@polygonlabs/oms-wallet-privacy` package, and the extension support it needs in the SDK.

### `@polygonlabs/oms-wallet-privacy`

- **`new OMSWallet(...).extend(privacy())`** adds `oms.privacy` for Ethereum wallets on Ethereum, BNB Chain, Polygon, Base and Arbitrum.
- **`shield`**, **`unshield`** and **`privateSend`** take a quote from `quoteShield`, `quoteUnshield` and `quotePrivateSend` with the privacy fee and `total`; quotes expire after 5 minutes and are single-use.
- **`getBalances`** returns spendable and recoverable private balances; **`recover`** pays undelivered private sends back to the wallet; **`getDeliveryStatus`** reports a private send's delivery.
- The first privacy call for a wallet that is not yet deployed on Polygon deploys it there (an empty transaction to itself), because the signature the private-balance keys are derived from changes at deployment.
- Deposits may only approve and call allowlisted contracts, and leave the allowance at exactly the quoted `total`. Each wallet transaction is reported through `onProgress` before it is submitted, and errors (`OMSWalletPrivacyError`) list every wallet transaction created.

### `@polygonlabs/oms-wallet`

- **`OMSWallet.extend(extension)`** returns an `OMSWallet` with the members an extension adds, without changing the original. New types: `OMSWalletExtension`, `OMSWalletExtensionContext`, `OMSWalletReservedMember`.
- `sendTransaction`, `signMessage` and `signTypedData` now act for the wallet that was active when they were called: if another wallet becomes active before they make their request, they fail with `OMSWalletSessionError` instead of acting for the new wallet.
- **`onPrepared(txnId)`** on `sendTransaction` runs after the transaction is prepared and before it is executed; throwing stops it.
- `signMessage` now refuses messages that start with `OMS Wallet reserved message:` (as text or hex) with `OMS_VALIDATION_ERROR`. Extensions sign them through `context.signReservedMessage`.
