# React Example

This example consumes the SDK as a workspace package:

```ts
import { OMSWallet } from '@polygonlabs/oms-wallet'
```

Run it from the repository root:

```bash
pnpm install
pnpm build
pnpm dev:example
```

The dev server runs at `http://localhost:5173`.

The deployed example is available at `https://0xsequence.github.io/typescript-sdk/react-example`.

The Amoy-only "ERC20 example" panel includes a WalletKit Dollar example using
the demo WKUSD contract deployed on Polygon Amoy.

Google redirect sign-in uses the SDK default Google client id. Apple redirect sign-in uses the SDK default Apple Services ID.

Build it from the repository root:

```bash
pnpm build
pnpm build:example
```
