# Migration Guide

This document records breaking changes and the steps to migrate between published
versions of `@polygonlabs/oms-wallet-wagmi-connector`.

## 0.3.0

The connector is Ethereum-only and now rejects an active Solana wallet explicitly instead of
treating its address as an Ethereum account. `connect` and `eth_requestAccounts` (and other provider
requests that need the active account) reject with `OMSWalletProviderRpcError` code `4100` when the
SDK's active wallet is a Solana wallet. If your app supports both wallet types, activate an Ethereum
wallet through the SDK before connecting wagmi.

When connector `transactionOptions` provide `selectFeeOption`, sponsored transactions now invoke
the selector with an empty array. Return `undefined` to continue the sponsored transaction, or throw
to stop it. `FeeOptionSelector.firstAvailable` already handles this case.
