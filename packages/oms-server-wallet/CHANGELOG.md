# Changelog

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
