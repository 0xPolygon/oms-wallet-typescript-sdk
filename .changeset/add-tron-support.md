---
'@polygonlabs/oms-wallet': minor
---

Add Tron wallet support, replace `walletAddress` with a typed `activeWallet`, and align the public API with the Swift and Kotlin SDKs. This release has breaking changes; see `MIGRATION.md`.

### Tron

- Create, sign in with, and import Tron wallets with **`WalletType.Tron`**. Imports take a secp256k1 private key, the same format as Ethereum.
- Send TRX and contract calls with **`sendTronTransaction`**, and TRC-20 calls with **`callTronContract`**, on **`TronNetworks.mainnet`** and **`TronNetworks.nile`**. Tron wallets are EOAs and always run in native mode.
- Omitting `data` sends a plain TRX transfer. Passing `data: '0x'` calls the recipient contract's payable fallback.
- Prepared Tron transactions are often sponsored by the account's free daily bandwidth, even without a relayer.
- Sign and verify with **`signTronMessage`**, **`signTronTypedData`** (TIP-712), **`isValidTronMessageSignature`**, and **`isValidTronTypedDataSignature`**.
- **`indexer.getTronBalances`** returns TRX and TRC-20 balances on Tron Mainnet and Nile, with the same structure as `getSolanaBalances`; TRC-20 entries carry `tokenStandard` and `contractAddress` where Solana entries carry `tokenProgram` and `mintAddress`. `FeeOptionSelector.firstAvailable` uses it for Tron fees.
- TRC-10 tokens are not supported.

`callContract` and `callTronContract` now reject a full function signature as `method` (for example `'transfer(address,uint256)'`) with `OMS_VALIDATION_ERROR` before sending a request. Pass the bare function name (`'transfer'`); the wallet service builds the signature from the `args` types and already rejected full signatures with a generic invalid-request error.

### Additions

- **`wallet.listAccessPage`** reads one access page; pass the previous page's `page.cursor` to continue. `AccessGrantPage` now includes `page` (`limit`, `cursor`).
- **`WalletOperation`**, **`IndexerOperation`**, **`RemoteAccessOperation`**, and the **`OMSWalletOperation`** type are exported for comparing `error.operation`.
- **`DEFAULT_SESSION_LIFETIME_SECONDS`** (one week) and **`MAX_SESSION_LIFETIME_SECONDS`** (30 days) are exported.
- **`FeeToken`** is exported.

### Breaking changes

- **`wallet.activeWallet`** replaces `wallet.walletAddress`. It is the active `WalletAccount` or `undefined`, and narrowing on `type` gives Ethereum wallets a viem `Address`.
- **`wallet.session`** is now `OMSWalletSession | undefined`, with `expiresAt` and `auth` always defined. `OMSWalletSessionState` is renamed to **`OMSWalletSession`** and no longer has `walletAddress`.
- `walletAddress` is removed from auth and wallet activation results. Use `result.wallet.address`.
- Session-expired events now include the expired `wallet`.
- Wallet responses whose Ethereum address is not a valid hex address now fail with `OMS_INVALID_RESPONSE` instead of being passed through as an `Address`.
- Sessions saved by 0.3.x are discarded on load, so users sign in once after upgrading.
- Signature verification methods no longer take `walletId`. Pass `walletAddress`, or omit it to verify against the active wallet's address. An omitted address with no active session now throws `OMSWalletSessionError`, and with an active wallet of another family throws `OMSWalletValidationError`, before any request. A given but empty or whitespace-only `walletAddress` now throws `OMSWalletValidationError` instead of falling back to the active wallet.
- **`createWallet`** and **`importEncryptedWallet`** take `walletType` instead of `type`.
- `FeeToken.logoURL` and `FeeToken.tokenID` are renamed to **`logoUrl`** and **`tokenId`**.
- `upstreamError.code` is always a string; numeric WebRPC codes are stringified (for example `'7313'`).
- `AuthMode` no longer includes `OTP` or `IDToken`, which no SDK parameter accepted.
- `OMSWalletClient` is renamed to **`WalletClient`** and `OMSWalletIndexerClient` to **`IndexerClient`**.
