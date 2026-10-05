# Migration Guide

This document records breaking changes and the steps to migrate between published
versions of `@polygonlabs/oms-wallet-wagmi-connector`.

## 0.4.0

The connector reads the active account from the SDK's `wallet.activeWallet` instead of the removed
`wallet.walletAddress`, and checks the wallet's type rather than its address shape. Use it with
`@polygonlabs/oms-wallet` 0.4.0. An active Tron wallet is rejected with `OMSWalletProviderRpcError`
code `4100`, as an active Solana wallet already is.

## 0.3.0

The connector is Ethereum-only and now rejects an active Solana wallet explicitly instead of
treating its address as an Ethereum account. `connect` and `eth_requestAccounts` (and other provider
requests that need the active account) reject with `OMSWalletProviderRpcError` code `4100` when the
SDK's active wallet is a Solana wallet. If your app supports both wallet types, activate an Ethereum
wallet through the SDK before connecting wagmi.

When connector `transactionOptions` provide `selectFeeOption`, sponsored transactions now invoke
the selector with an empty array. Return `undefined` to continue the sponsored transaction, or throw
to stop it. `FeeOptionSelector.firstAvailable` already handles this case.
