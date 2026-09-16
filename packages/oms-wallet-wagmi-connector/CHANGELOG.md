# @polygonlabs/oms-wallet-wagmi-connector

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
