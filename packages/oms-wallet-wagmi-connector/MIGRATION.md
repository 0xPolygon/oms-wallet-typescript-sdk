# Migration Guide

This document records breaking changes and the steps to migrate between published
versions of `@polygonlabs/oms-wallet-wagmi-connector`.

## 0.3.0

When connector `transactionOptions` provide `selectFeeOption`, sponsored transactions now invoke
the selector with an empty array. Return `undefined` to continue the sponsored transaction, or throw
to stop it. `FeeOptionSelector.firstAvailable` already handles this case.
