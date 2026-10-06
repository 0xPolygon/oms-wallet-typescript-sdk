---
'@polygonlabs/oms-wallet': minor
---

Add Tron wallet support, and replace `walletAddress` with a typed `activeWallet`. This release has breaking changes; see `MIGRATION.md`.

### Tron

- Create, sign in with, and import Tron wallets with **`WalletType.Tron`**. Imports take a secp256k1 private key, the same format as Ethereum.
- Send TRX and contract calls with **`sendTronTransaction`**, and TRC-20 calls with **`callTronContract`**, on **`TronNetworks.mainnet`** and **`TronNetworks.nile`**. Tron wallets are EOAs and always run in native mode.
- Omitting `data` sends a plain TRX transfer. Passing `data: '0x'` calls the recipient contract's payable fallback.
- Prepared Tron transactions are often sponsored by the account's free daily bandwidth, even without a relayer.
- Sign and verify with **`signTronMessage`**, **`signTronTypedData`** (TIP-712), **`isValidTronMessageSignature`**, and **`isValidTronTypedDataSignature`**.
- **`indexer.getTronBalances`** (experimental) returns TRX and TRC-20 balances in the same shape as `getSolanaBalances`. It currently reads public Tron JSON-RPC, so TRC-20 balances are returned only for the `contractAddresses` you pass. `FeeOptionSelector.firstAvailable` uses it for Tron fees.
- TRC-10 tokens are not supported.

`callContract` and `callTronContract` now reject a full function signature as `method` (for example `'transfer(address,uint256)'`) with `OMS_VALIDATION_ERROR` before sending a request. Pass the bare function name (`'transfer'`); the wallet service builds the signature from the `args` types and already rejected full signatures with a generic invalid-request error.

### Breaking changes

- **`wallet.activeWallet`** replaces `wallet.walletAddress`. It is the active `WalletAccount` or `undefined`, and narrowing on `type` gives Ethereum wallets a viem `Address`.
- **`wallet.session`** is now `OMSWalletSession | undefined`, with `expiresAt` and `auth` always defined. `OMSWalletSessionState` is renamed to **`OMSWalletSession`** and no longer has `walletAddress`.
- `walletAddress` is removed from auth and wallet activation results. Use `result.wallet.address`.
- Session-expired events now include the expired `wallet`.
- Wallet responses whose Ethereum address is not a valid hex address now fail with `OMS_INVALID_RESPONSE` instead of being passed through as an `Address`.
- Sessions saved by 0.3.x are discarded on load, so users sign in once after upgrading.
