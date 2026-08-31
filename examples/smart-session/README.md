# Smart Session Example

This example demonstrates multiple independently administered backend-owned Remote Access
Credentials (RACs), each serving smart sessions approved by multiple OMS wallets. The demo is
configured for native POL transfers on Polygon Amoy and for POL, USDC, and USDT transfers on
Polygon mainnet.

The Worker accepts only this checked-in network and asset allowlist:

| Network | Assets |
| --- | --- |
| Polygon Amoy | Native POL |
| Polygon mainnet | Native POL, [USDC](https://polygonscan.com/token/0x3c499c542cef5e3811e1192ce70d8cc03d5c3359), [USDT](https://polygonscan.com/token/0xc2132d05d31c914a87c6611c10748aeb04b58e8f) |

Polygon mainnet assets have real value. Keep Polygon Amoy selected unless you intend to create and
execute a real mainnet permission.

Native permissions allow one specific receiver. ERC-20 permissions can allow one receiver,
multiple receivers through separate grants, or any receiver by omitting the grant's `to` field. For
specific ERC-20 receivers, the configured cumulative allowance applies separately to each receiver;
for any receiver, one cumulative allowance is shared across all transfers.

The workspace contains:

- a Cloudflare Worker API that owns the RACs, signs WaaS requests, and serves both frontends;
- a D1 database containing each RAC's approval workflow, minimal session associations, transaction
  records, and monotonic request nonces;
- a wallet-owner React app at `/` that approves and revokes smart sessions; and
- an admin React app at `/dashboard/` that creates approval links, lists the authenticated RAC's
  active, revoked, and expired session records, dismisses terminal records from the session list,
  and submits permitted transactions.

The owner app uses the Indexer to show the authenticated wallet's positive native and ERC-20
balances on Polygon Amoy, Polygon mainnet, and Base, including indexed token icons and USD values
when available. It uses WaaS `ListAccess` to show every active remote session for that wallet. The
dashboard only shows sessions completed through this backend. The Worker uses the RAC's
`ListSessions`, `GetSession`, and `GetSessionUsage` APIs for authoritative live session details and
remaining allowances; D1 retains the approval and transaction history. WaaS and the on-chain
session contracts remain the final authority for transaction execution. The wallet address posted
by the owner app is retained only for dashboard display and Indexer balance lookup; transactions use
the authoritative wallet ID returned by `GetSession`.

The wallet settings menu also includes a one-time Trails automation. Enabling **Auto-convert USDT**
immediately checks the wallet and then watches for a positive Polygon USDT balance. Once detected,
it quotes and attempts to convert the wallet's full available Polygon USDT balance to Base USDC,
shows the route and transaction progress, and turns itself off after that first attempt whether it
succeeds or fails. Re-enable it for another conversion. The owner app must remain open and signed in
while it is armed or running. This uses mainnet assets with real value, and small balances can be
rejected when the route fees exceed the amount being converted.

## Local setup

From the repository root:

```bash
pnpm install
cd examples/smart-session
```

No local secrets are required. On first use in each browser profile, the dashboard generates an
admin token and persists it in browser local storage while the Worker stores only its hash in D1.
That token identifies an independent backend RAC and scopes all of its approval requests, smart
sessions, and transactions. The authenticated dashboard then asks the Worker to generate that RAC's
key, which this demo stores in local D1.

The checked-in Development sandbox publishable key is configured in `wrangler.jsonc`. Replace it
there when testing another WaaS project or environment.

Start all three processes. The `predev` hook initializes or updates local D1 before building the
apps:

```bash
pnpm dev
```

If you initialized D1 with an older version of the example schema, delete the example's local
`.wrangler/state/v3/d1` directory before running `pnpm dev` again. This example has not been
deployed, so schema changes update the initial migration instead of adding compatibility migrations.

Open:

- client approval app: <http://localhost:5173/> (normally opened through an approval link);
- admin dashboard: <http://localhost:5174/dashboard/>; and
- Worker API and production-style static routes: <http://localhost:8787/>.

The Vite apps proxy `/api/*` to the Worker on port `8787`.
The client route also works without an approval link: it restores the current wallet session, shows
its non-zero Polygon Amoy, Polygon mainnet, and Base asset balances, lists approved smart sessions,
and allows the owner to copy the full wallet address or sign out. Wallet owners can sign in with
Google, Apple, or an email verification code, matching the main React example.

## Test the flow

1. Open the dashboard and select **Initialize admin + RAC**. The browser persists its generated
   admin access while the Worker persists the generated RAC key in D1 and registers its RAC
   credential ID with WaaS.
2. Select a network and asset, create an approval request, and copy its generated link. USDC and
   USDT are available only on Polygon mainnet. Pending requests retain a **Copy link** action after
   the dashboard refreshes.
3. Open the link in the client app, sign in to an Ethereum wallet, review the exact permission, and
   approve or reject it.
4. Return to the dashboard. While a non-expired request is pending, it refreshes the overview every
   10 seconds when visible. A rejected request is recorded without creating a session. Once approved,
   the new wallet/session association, authoritative grants and usage, and current selected-asset
   balance appear under backend smart sessions.
5. Fund that smart wallet with the selected asset if needed, then submit a transfer from the session
   card.
6. The dashboard polls pending transactions and links executed transactions to PolygonScan.
7. The wallet owner can revoke an active session directly through WaaS. The dashboard observes the
   revocation through the backend RAC's session APIs and preserves the local association as history
   without offering transaction controls. Revoked and expired session cards can be dismissed from
   the session list without removing their approval or transaction history.

The RAC registration lasts 30 days. Session requests cannot extend beyond that credential expiry.
The Worker registers the persisted RAC key again after its current credential expires. Existing
sessions remain bound to the previous credential and are no longer shown as usable.
Use **Rotate backend RAC** in the dashboard to revoke that dashboard's current credential and
immediately generate and register a new one. Rotation makes sessions authorized for the previous
credential unusable and clears only that RAC's stored approval requests, smart sessions,
transaction records, and nonce. Other dashboard administrators and their RACs are unaffected.

## Deploy to Cloudflare

Create a D1 database and copy the returned ID into the `database_id` field in `wrangler.jsonc`:

```bash
pnpm exec wrangler d1 create oms-smart-session-example
```

Then migrate and deploy:

```bash
pnpm db:migrate:remote
pnpm deploy
```

One Worker deployment serves the API, dashboard, and client assets. Each browser profile that opens
the dashboard can initialize its own admin access and independent RAC. Protect a deployment with
Cloudflare Access if RAC creation should not be public. The plaintext RAC storage is appropriate
only for this demo; a production backend must use encrypted key storage or a managed secret store.
See Cloudflare's official
[static assets](https://developers.cloudflare.com/workers/static-assets/),
[D1](https://developers.cloudflare.com/d1/), and deployment documentation for account and
environment configuration.
