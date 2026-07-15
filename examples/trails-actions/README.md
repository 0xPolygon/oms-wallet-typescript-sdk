# Trails Actions React Example

This Vite React app uses the OMS Wallet SDK with Trails actions on Polygon:

- Swap POL to USDC
- Deposit USDC using Earn
- Swap POL to USDC and deposit USDC in one prepared Trails transaction
- View Earn positions and withdraw from withdrawable Earn positions

Run it from the repository root:

```bash
pnpm install
pnpm build
pnpm dev:trails-actions-example
```

The dev server runs at `http://localhost:5173`.

The deployed example is available at `https://0xsequence.github.io/typescript-sdk/trails-actions-example`.

The OMS project used by the environment values must support Polygon.
Google and Apple redirect login use the SDK's default provider helpers.

Build it from the repository root:

```bash
pnpm build
pnpm build:trails-actions-example
```
