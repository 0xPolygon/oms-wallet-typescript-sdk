# @polygonlabs/oms-wallet

## 0.3.0

### Minor Changes

- [#85](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/85) [`6fb0b31`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/6fb0b316d82db655a1ef6063027d53c6a383e9f3) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Add public smart-session credential inspection, owner-side session management, a signed remote
  application client for backend session transactions, and Solana wallet creation, off-chain message
  signing and verification, and native SOL and SPL-token transfers. Solana transfers now default to
  relayer mode: network fees are sponsored, while fee options are returned for rent when a recipient
  token account must be created.
  
  `walletAddress` and `WalletAccount` now represent both Ethereum and Solana addresses. Use the wallet
  type discriminator before applying Ethereum-specific address handling.
  
  Ethereum-specific signing, transactions, and smart-session authorization now reject an active
  Solana wallet explicitly.
  
  Sponsored transactions now invoke an optional fee selector with an empty list before execution, so
  applications can acknowledge the free fee or stop the transaction. `FeeOptionSelector.firstAvailable`
  continues sponsored execution without sending a fee option and uses Solana indexer balances to pick
  an affordable option for non-sponsored Solana transfers.

- [#85](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/85) [`6fb0b31`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/6fb0b316d82db655a1ef6063027d53c6a383e9f3) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - `OMSWallet.indexer.getSolanaBalances` now retrieves native SOL and fungible SPL-token balances across Solana Mainnet and Devnet.
  
  Balance results include token metadata, verification and USD pricing when available, while per-network failures are returned separately without discarding successful results.

- [#85](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/85) [`6fb0b31`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/6fb0b316d82db655a1ef6063027d53c6a383e9f3) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Add attested EVM and Solana wallet import and smart-session read APIs for owners and remote applications.
  
  - **Wallet import:** import raw keys through HPKE or provide externally encrypted key material through the advanced import methods. Polygon-managed environments now supply their attestation trust policy automatically.
  - **Wallet provenance:** every `WalletAccount` now requires `keyOrigin`, distinguishing enclave-generated and imported keys.
  - **Session reads:** wallet owners can read an authorized session and its grant usage, while `RemoteAccessClient` can list and read every session scoped to its credential.
  - **Access management:** `AccessGrant` now discriminates direct and remote access with `type`, and `revokeAccess` accepts `credentialId` plus an optional `sessionId` instead of `targetCredentialId`.
  - **Errors:** duplicate-address and failed-attestation imports now have stable SDK error codes.

### Patch Changes

- [#85](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/85) [`6fb0b31`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/6fb0b316d82db655a1ef6063027d53c6a383e9f3) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Enable Development sandbox wallet import while verifying the Nitro certificate chain, freshness,
  nonce, signature, and request/response binding. Development's debug-mode PCR0 is all zeroes and
  should be used only with disposable keys.
