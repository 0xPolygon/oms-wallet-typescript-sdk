# Migration Guide

This document records breaking changes and the steps to migrate between published
versions of `@polygonlabs/oms-wallet`.

## 0.3.0

### Wallet addresses and provenance

`walletAddress` and `WalletAccount.address` widened from viem's Ethereum `Address` type to `string`
because wallet results can now contain Ethereum or Solana accounts. Existing Ethereum code must
narrow `wallet.type` before passing an address to viem or another Ethereum-only API:

```typescript
import { WalletType } from '@polygonlabs/oms-wallet'

const wallet = await omsWallet.wallet.createWallet()

if (wallet.wallet.type === WalletType.Ethereum) {
  useEthereumAddress(wallet.wallet.address)
}
```

Every `WalletAccount` now has a required `keyOrigin` field. Code that constructs wallet fixtures or
implements SDK-facing wallet account types must set it to `WalletKeyOrigin.Enclave` or
`WalletKeyOrigin.Imported`:

```typescript
import { WalletKeyOrigin, type EthereumWalletAccount } from '@polygonlabs/oms-wallet'

const wallet: EthereumWalletAccount = {
  id: 'wallet-id',
  type: 'ethereum',
  address: '0x1111111111111111111111111111111111111111',
  keyOrigin: WalletKeyOrigin.Enclave,
}
```

### Access grants and revocation

`AccessGrant` changed from an alias of `WalletCredential` to a discriminated union of
`DirectAccessGrant` and `RemoteAccessGrant`. Code that constructs access-grant fixtures must now set
`type`. Narrow on `grant.type` before reading the remote session ID, metadata, or grants:

```typescript
for (const grant of await omsWallet.wallet.listAccess()) {
  if (grant.type === 'remote') {
    showRemoteSession(grant.sessionId, grant.metadata, grant.grants)
  }
}
```

The public `revokeAccess` parameter was renamed from `targetCredentialId` to `credentialId`. Pass an
optional `sessionId` to revoke only one remote session for that credential:

```typescript
// 0.2.0
await omsWallet.wallet.revokeAccess({ targetCredentialId: credentialId })

// 0.3.0
await omsWallet.wallet.revokeAccess({ credentialId })
await omsWallet.wallet.revokeAccess({ credentialId, sessionId })
```

### Sponsored fee selectors

When `selectFeeOption` is provided, sponsored transactions now invoke it with an empty array before
execution. Treat the empty array as the sponsored case and return `undefined` to continue, or throw
to stop execution. `FeeOptionSelector.firstAvailable` already handles both sponsored and
non-sponsored transactions.

```typescript
selectFeeOption: async (feeOptions) => {
  if (feeOptions.length === 0) return undefined
  return chooseFeeOption(feeOptions)
}
```
