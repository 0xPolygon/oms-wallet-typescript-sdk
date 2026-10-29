# @polygonlabs/oms-wallet-wagmi-connector

## 0.4.0

### Minor Changes

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Indexer responses, pending OIDC redirects, and the wagmi connector's wallet type now accept only the current shapes.
  
  - **`@polygonlabs/oms-wallet`:** indexer responses are read only with the indexer gateway's field names. A native balance without `balance`, or token metadata without `tokenId`, now fails with `OMS_INVALID_RESPONSE`.
  - **`@polygonlabs/oms-wallet`:** `completeOidcRedirectAuth` rejects a pending redirect record with a missing or unknown `walletType` as `Pending OIDC redirect auth is invalid` instead of continuing with an Ethereum wallet.
  - **`@polygonlabs/oms-wallet-wagmi-connector`:** `OMSWalletLike.wallet.onSessionExpired` is now required, so session expiry always disconnects wagmi. The SDK's `OMSWallet` already provides it.

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Replace `onSessionExpired` with `onSessionChange`, which reports every change of `activeWallet` or `session` (sign-in, wallet switch, expiry update, sign-out, or expiry) with a reason, including changes made in other tabs, which now stay in sync. `activeWallet` and `session` return the same frozen object until they change, so they work with React's `useSyncExternalStore`. The wagmi connector follows the session while connected: it disconnects when the session ends and changes the account when another Ethereum wallet becomes active. This is a breaking change; see `MIGRATION.md`.

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - The connector now reads the SDK's `wallet.activeWallet` and checks the wallet type instead of the address shape. Use it with `@polygonlabs/oms-wallet` 0.4.0. Connecting with an active Tron wallet rejects with `OMSWalletProviderRpcError` code `4100`, the same as an active Solana wallet. `isAuthorized()` now returns `false` unless the active wallet is an Ethereum wallet, so wagmi does not try to reconnect to a Solana or Tron wallet.

### Patch Changes

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - `OMSWallet` instances of one project can no longer drift apart, and projects on one origin keep their own sessions.
  
  - Creating `OMSWallet` again for the same project and environment returns the same wallet when the instances already share their stored session: the browser defaults, or the same `storage`, `credentialSigner` and `redirectAuthStorage` objects. A rotated publishable key of the same project keeps the session and sends the new key. Node defaults and per-user storage stay separate sessions. Reusing one `storage` object with a different `credentialSigner` or `redirectAuthStorage` throws `OMSWalletValidationError`.
  - Stored sessions, signing keys and redirect state are kept per project and wallet API origin, so several projects or environments on one origin no longer sign each other out.
  - Requests signed with one credential are sent one at a time, in order, by every client in the process (wallet and remote-access clients alike) and across tabs with Web Locks, so concurrent calls from this app are no longer rejected for a stale nonce.
  - The 30-second request deadline now also covers reading the response body, so a response whose body stalls fails instead of hanging.
  - The wagmi connector observes session expiry from `connect` on, so configs that never connect leave no listener.

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Require viem `2.55.0` or newer, so installs no longer resolve the `ws` version affected by GHSA-96hv-2xvq-fx4p.
  
  - **`@polygonlabs/oms-wallet`:** the `viem` dependency is now `^2.55.0`.
  - **`@polygonlabs/oms-wallet-wagmi-connector`:** the `viem` peer range is now `>=2.55.0 <3`, and the `@wagmi/core` peer range is now `>=3.6.5 <4`. viem 2.56 and later removed an export that earlier `@wagmi/core` releases import, so those releases fail to build with current viem.
- Updated dependencies [[`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5), [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5), [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5), [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5), [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5), [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5), [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5), [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5), [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5), [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5), [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5), [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5), [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5), [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5), [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5), [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5)]:
  - @polygonlabs/oms-wallet@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [[`0b97509`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/0b975098deb0c49c4e28e600cdc2fc1a9ee767f5)]:
  - @polygonlabs/oms-wallet@0.3.1

## 0.3.0

### Minor Changes

- [#85](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/85) [`6fb0b31`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/6fb0b316d82db655a1ef6063027d53c6a383e9f3) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - The wagmi connector now rejects an active Solana wallet explicitly instead of treating its address
  as an Ethereum account.
  
  When connector `transactionOptions` provide `selectFeeOption`, sponsored transactions invoke the
  selector with an empty array. Return `undefined` to continue the sponsored transaction, or throw to
  stop it. `FeeOptionSelector.firstAvailable` already handles this case.

### Patch Changes

- Updated dependencies [[`6fb0b31`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/6fb0b316d82db655a1ef6063027d53c6a383e9f3), [`6fb0b31`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/6fb0b316d82db655a1ef6063027d53c6a383e9f3), [`6fb0b31`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/6fb0b316d82db655a1ef6063027d53c6a383e9f3), [`6fb0b31`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/6fb0b316d82db655a1ef6063027d53c6a383e9f3)]:
  - @polygonlabs/oms-wallet@0.3.0
