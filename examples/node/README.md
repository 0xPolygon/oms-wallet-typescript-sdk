# Node Example

This example consumes the SDK as a workspace package:

```ts
import { MemoryStorageManager, Networks, OMSWallet } from '@polygonlabs/oms-wallet'
```

Run it from the repository root:

```bash
pnpm install
pnpm build
OMS_PUBLISHABLE_KEY=your-publishable-key pnpm dev:node-example
```

The example prompts for an email address, sends an OTP code, prompts for the code, then signs a `test` message on Polygon Amoy.

You can typecheck the example directly:

```bash
pnpm build:node-example
```
