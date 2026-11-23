# Changelog

## 0.4.0

### Minor Changes

- [#121](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/121) [`b91320a`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/b91320a98cda58dc3eb09644ab74c9c0d8c099b0) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Keep one wallet per network family (`evm`, `solana`, `tron`) and add `createOrRestore({ families })`. `WalletSnapshot.wallets` lists them; `WalletSnapshot.wallet` is still the EVM wallet, and EVM methods are unchanged. Wallet state from 0.2.x and 0.3.x is migrated on first load, and state in neither format fails with `INVALID_STATE`. Wallet responses are read with the WaaS v1.2.0 shapes, including fee options.

- [#124](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/124) [`53b08ea`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/53b08ea818f50b6f9a78b52ae4808e51e18f3eeb) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - EVM operations no longer stay `unknown` forever, and coordinating with swaps no longer reads every operation ever stored.
  
  - **Refused executions:** an EVM Execute that WaaS refuses before claiming the transaction is recorded as `failed` (`EXECUTE_REFUSED`) instead of `unknown`. Previously such an operation blocked `WalletSwaps` transfers and swaps on its chain with `DEBIT_PENDING`. This includes refusals from WaaS credential checks before Execute runs (invalid signature, usage limit, nonce replay), for EVM, Solana and Tron.
  - **Expired quotes:** EVM operations gain the `expired` status. An operation WaaS still reports expired and unclaimed two minutes past its quote's expiry becomes `expired` instead of failing every `getOperation`, and executing a quote known to be expired marks it `expired` as well as raising `QUOTE_EXPIRED`.
  - **Signatures:** `signMessage` and `signTypedData` record a failed or unverified signature as `failed` with its error code; a retry under the same ID returns that record and never signs again.
  - **Interrupted preparations:** an operation whose preparation was interrupted before its quote was stored is quoted again under the same ID instead of staying `preparing`.
  - **Known claims are kept:** once WaaS has shown a transaction claimed (`pending`, or a transaction hash), a later stale status read (`quoted`, or `TransactionExpired`) no longer turns the operation back into `unknown` or `expired`. This also applies to Solana and Tron operations.
  - **New methods:** `listOpenOperations(legacyIds?)` returns unsettled EVM operations from an index of open operations, built from existing records on first use and updated with operations an older SDK version adds to the same store, and `readOperations(ids)` returns specific stored operations. `WalletSwaps` uses them.
  - **Executor check:** `WalletSwaps` throws `CONFIGURATION` when given the wallet's own executor, which would otherwise wait on itself forever.
  - **Swaps:** `WalletSwaps` settles expired operations: an expired funding expires the swap (`QUOTE_EXPIRED`), an expired recovery ends that recovery (`RECOVERY_EXPIRED`) so a new review can start, and an expired owner deployment asks for a new review. A swap whose own funding failed, reverted or expired no longer keeps its origin chain reserved. Failed and expired swaps keep their error code.

- [#121](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/121) [`b91320a`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/b91320a98cda58dc3eb09644ab74c9c0d8c099b0) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Add Solana wallets as `wallet.solana`: sponsored SOL, SPL and Token-2022 transfers (`prepareTransfer`, `executeTransfer`, `sendTransfer`), verified off-chain message signing, and `IndexerClient.getSolanaBalances`. Solana quotes last about a minute; an expired quote fails with `TRANSACTION_EXPIRED` and an operation whose Execute was already called stays `unknown` until WaaS shows its claim or, two minutes past expiry, still reports it unclaimed.

- [#121](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/121) [`b91320a`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/b91320a98cda58dc3eb09644ab74c9c0d8c099b0) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Add Tron wallets as `wallet.tron`: TRX transfers, raw and ABI contract calls, verified TIP-191 and TIP-712 signing, and `IndexerClient.getTronBalances`. Transactions are sent only when the wallet's delegated resources cover them, unless the caller sets `maxFee` in sun to let the wallet pay a quoted TRX fee up to that amount. Both limits apply to the quote and WaaS's execution-time re-check; on chain a contract call is bounded only by the fee limit WaaS seals into it.

### Patch Changes

- [#121](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/121) [`b91320a`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/b91320a98cda58dc3eb09644ab74c9c0d8c099b0) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Enclave attestation now accepts the `Sequence/2` format alongside `Sequence/1`.
  
  - A `Sequence/2` attestation also binds the request's `OMS-Wallet-Signature` header, so a response proves which credential signed the request the enclave answered. Both SDKs verify it against the header they sent.
  - Unknown attestation formats are rejected.
  - Upgrade before WaaS switches to `Sequence/2`: earlier versions reject those responses (`@polygonlabs/oms-wallet` during wallet import; `@polygonlabs/oms-server-wallet-sdk` on every request).

- [#121](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/121) [`b91320a`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/b91320a98cda58dc3eb09644ab74c9c0d8c099b0) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - The server wallet SDK now supports Node.js 22 and later (previously 24 and later).
  
  - Source, issues and releases move to [`0xPolygon/oms-wallet-typescript-sdk`](https://github.com/0xPolygon/oms-wallet-typescript-sdk) under `packages/oms-server-wallet`.
  - Updates `@0xsequence/wallet-primitives` to 3.0.15 and `viem` to 2.57.3.

## 0.3.0

### Minor Changes

- [#1](https://github.com/0xPolygon/oms-server-wallet-sdk/pull/1) [`a1875b4`](https://github.com/0xPolygon/oms-server-wallet-sdk/commit/a1875b427461821fc9eb70f9aa1c79c4025a38cd) Thanks [@taylanpince](https://github.com/taylanpince)! - Export `omsFetch(origin, fetcher?)`, which sends the application's allowed `Origin` on WaaS and indexer requests, so integrations no longer need their own wrapper.

- [#3](https://github.com/0xPolygon/oms-server-wallet-sdk/pull/3) [`9a8ecf0`](https://github.com/0xPolygon/oms-server-wallet-sdk/commit/9a8ecf0e6f5bbd8ca13f69bceafae6379aa33eee) Thanks [@taylanpince](https://github.com/taylanpince)! - Add `sendUserOperation`, `prepareUserOperation` and `executeUserOperation` for sponsored contract calls described by an ABI, function name and arguments, or by pre-encoded calldata.

### Patch Changes

- [#1](https://github.com/0xPolygon/oms-server-wallet-sdk/pull/1) [`a1875b4`](https://github.com/0xPolygon/oms-server-wallet-sdk/commit/a1875b427461821fc9eb70f9aa1c79c4025a38cd) Thanks [@taylanpince](https://github.com/taylanpince)! - `IndexerClient.getBalances` reports malformed balance responses as `WalletError('INVALID_RESPONSE')` instead of a raw `SyntaxError` or `ZodError`.

- [#1](https://github.com/0xPolygon/oms-server-wallet-sdk/pull/1) [`a1875b4`](https://github.com/0xPolygon/oms-server-wallet-sdk/commit/a1875b427461821fc9eb70f9aa1c79c4025a38cd) Thanks [@taylanpince](https://github.com/taylanpince)! - Update `zod` to 4.6.7 to fix a high-severity memory-exhaustion advisory (GHSA-mrhx-c7xc-m3w5) in 4.5.4.

## 0.2.0

- Add optional `/trails`: direct v1.5 API transport, exact-input quote validation, chain/token discovery, `EvmChainReader` and `WalletSwaps`.
- Persist activation, sponsored funding, settlement, delayed-deposit repair and separately authorized source/destination recovery. Reconcile uncertain submissions using the original transaction IDs; never send a replacement deposit.
- Coordinate ordinary transfers with pending swap/recovery debits. Introduce `listOperations()` and legacy-operation import support.
- Add verified EIP-712 signing and narrow sponsored owner deployment/recovery operations. Validate Sequence v3 payloads, factory/guest deployment envelopes and hashes before authorizing calls.
- Convert the API's recognized non-delegate utility sweep to direct refunds of reviewed intent-owned balances, retaining the original envelope for audit. Record actual/partial recovery amounts.
- Export durable storage/scheduling contracts and sanitized activity views. Keep application, Workers and UI code outside the package.
- Invoke native fetch without rebinding it to SDK clients, preserving compatibility with Cloudflare Workers across Trails, RPC, WaaS and indexer requests.

The existing root wallet API and WaaS v1.1.0 attestation/authentication contract remain in place. All base-unit amounts use decimal strings. Consumers must supply encrypted durable state and per-wallet exclusive coordination. Funded service acceptance is documented separately in the repository; automated fixtures do not establish live sponsorship compatibility.

## 0.1.0

Initial standalone release: backend OIDC authentication, encrypted credentials and nonce persistence, automatic reauthentication, attested WaaS responses, wallet creation/restore, verified message signing, sponsored native/ERC-20 transfers and indexer balances.
