# Privacy React Example

This Vite React app uses `@polygonlabs/oms-wallet-privacy` with an OMS Ethereum wallet:

- Shield: move tokens from the wallet into its private balance
- Private send: send to a recipient with no on-chain link to the sender, delivered later
- Unshield: move tokens from the private balance to an address
- View spendable and recoverable private balances, and recover undelivered private sends

Private balances exist only on mainnets (Ethereum, BNB Chain, Polygon, Base, Arbitrum), so every
action moves real funds and pays real fees. Fund the signed-in wallet with a small amount of the
chosen token first; by default network fees are paid in the token being moved.

Run it from the repository root:

```bash
pnpm install
pnpm dev:privacy-example
```

The dev server runs at `http://localhost:5173`. The app needs no polyfills or bundler settings for
the privacy package; it loads its privacy library (about 2 MB gzipped) on the first private-balance
call.

Build it from the repository root:

```bash
pnpm build:privacy-example
```
