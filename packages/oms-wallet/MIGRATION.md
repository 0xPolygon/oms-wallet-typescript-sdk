# Migration Guide

This document records breaking changes and the steps to migrate between major
versions of `@polygonlabs/oms-wallet`.

## 1.0

`walletAddress` and wallet-account addresses are no longer always Ethereum `Address` values. Check
`wallet.type` before passing an address to Ethereum-specific code:

```typescript
import { WalletType } from '@polygonlabs/oms-wallet'

const wallet = await omsWallet.wallet.createWallet()

if (wallet.wallet.type === WalletType.Ethereum) {
  useEthereumAddress(wallet.wallet.address)
}
```

Solana wallets can be created with `WalletType.Solana`; their addresses are base58 strings.

Ethereum signing, transaction, smart-session authorization, and wagmi APIs only support Ethereum
wallets. Select an Ethereum wallet before using them.
