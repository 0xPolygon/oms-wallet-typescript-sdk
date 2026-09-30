# OMS Wallet TypeScript SDK

Build **non-custodial EVM and Solana wallet experiences in TypeScript** with OMS Wallet — email and
OIDC sign-in, session restore, message signing, transaction submission, token-balance queries, and
attested opt-in key import. Normal wallet creation never exposes a private key through the SDK;
import flows accept caller-provided key material only when an application explicitly uses them.
This repository is the source of truth for the OMS Wallet SDK and its official
[wagmi](https://wagmi.sh) connector: it exists so web and Node applications can integrate an OMS
embedded wallet from a single, versioned, typed package set instead of re-implementing WaaS auth,
request signing, and session handling by hand.

It is a **pnpm workspace**. The root is a private orchestrator (not published); the shippable code
lives in `packages/`, and `examples/` holds runnable browser and Node demos that consume the
packages exactly as an external app would.

## Packages

| Package | Published as | What it does |
|---|---|---|
| [`packages/oms-wallet`](packages/oms-wallet) | [`@polygonlabs/oms-wallet`](https://www.npmjs.com/package/@polygonlabs/oms-wallet) | The core SDK — email/OIDC authentication, EVM and Solana wallets, attested key import, signed remote access, transaction submission and status polling, access management, and EVM/Solana indexer balance queries. Ships dual CJS + ESM for browser and Node consumers. |
| [`packages/oms-wallet-wagmi-connector`](packages/oms-wallet-wagmi-connector) | [`@polygonlabs/oms-wallet-wagmi-connector`](https://www.npmjs.com/package/@polygonlabs/oms-wallet-wagmi-connector) | Adapts an active Ethereum wallet from `@polygonlabs/oms-wallet` as a [wagmi](https://wagmi.sh) connector, so existing wagmi apps can use OMS Wallet as a connection option. |

Both packages release **in lockstep** (a changesets `fixed` group), so they always share a version.

## Getting started (contributors)

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm test && pnpm build   # the same checks CI runs
```

Common workspace commands (run from the repo root):

```bash
pnpm lint                     # eslint + markdownlint + prettier + typecheck
pnpm typecheck                # tsc -b across the packages
pnpm test                     # release-script tests + SDK + connector test suites
pnpm build                    # build packages (dual CJS+ESM) + all examples (pnpm -r)
pnpm check:exports            # publint on the publishable packages
```

## Examples

Run every command below from the repo root after `pnpm install`. Examples resolve the SDK from
source, so no prior `pnpm build` is needed.

| Example | What it shows | Run | Typecheck / build |
|---|---|---|---|
| [`examples/react`](examples/react) ([live demo](https://0xpolygon.github.io/oms-wallet-typescript-sdk/react-example/)) | Email, Google, and Apple sign-in, signing, transactions, balances, wallet management, Privy wallet import, and Solana | `pnpm dev:example` | `pnpm build:example` |
| [`examples/wagmi`](examples/wagmi) ([live demo](https://0xpolygon.github.io/oms-wallet-typescript-sdk/wagmi-example/)) | The wagmi connector with the MetaMask connector and the Trails widget | `pnpm dev:wagmi-example` | `pnpm build:wagmi-example` |
| [`examples/trails-actions`](examples/trails-actions) ([live demo](https://0xpolygon.github.io/oms-wallet-typescript-sdk/trails-actions-example/)) | Trails swap, Earn deposit, and Earn withdrawal flows | `pnpm dev:trails-actions-example` | `pnpm build:trails-actions-example` |
| [`examples/custom-google-redirect`](examples/custom-google-redirect) | Google as a custom OIDC provider with `providerRedirectUri: "http://localhost:5173"` (local only) | `pnpm dev:custom-google-redirect-example` | `pnpm build:custom-google-redirect-example` |
| [`examples/custom-auth0-id-token`](examples/custom-auth0-id-token) | An Auth0-issued ID token passed to `signInWithOidcIdToken` (local only; add `http://localhost:5173` to the Auth0 application's Allowed Callback URLs, Allowed Logout URLs, and Allowed Web Origins) | `pnpm dev:custom-auth0-id-token-example` | `pnpm build:custom-auth0-id-token-example` |
| [`examples/node`](examples/node) | Email OTP sign-in and message signing from a terminal | `OMS_PUBLISHABLE_KEY=your-publishable-key pnpm dev:node-example` | `pnpm build:node-example` |
| [`examples/node-contract-deploy-example`](examples/node-contract-deploy-example) | Compiling and deploying an ERC-20 on Polygon Amoy (see below) | `pnpm dev:node-contract-deploy-example` | `pnpm build:node-contract-deploy-example` |
| [`examples/smart-session`](examples/smart-session) | Backend-owned RACs serving smart sessions (see below) | `pnpm dev:smart-session-example` | `pnpm build:smart-session-example` |

The contract deploy example needs a local env file first:

```bash
cp examples/node-contract-deploy-example/.env.example examples/node-contract-deploy-example/.env.local
# Fill OMS_PUBLISHABLE_KEY in examples/node-contract-deploy-example/.env.local
pnpm dev:node-contract-deploy-example
```

The React example uses the deployed
[`examples/helpers/privy-import-worker`](examples/helpers/privy-import-worker)
Cloudflare Worker to create and HPKE-export disposable Privy wallets from both localhost and GitHub
Pages. Privy credentials remain in Worker secrets and generated wallet authorization keys are never
persisted. To run or validate the Worker itself:

```bash
pnpm dev:privy-import-worker      # run locally on port 8788
pnpm build:privy-import-worker    # typecheck and dry-run the deployment
```

The Cloudflare-deployable [`examples/smart-session`](examples/smart-session) workspace demonstrates
independently administered backend-owned RACs serving smart sessions approved by multiple owner
wallets. It supports POL and USDC transfers on Polygon Amoy; POL, USDC, and USDT on Polygon
mainnet; and ETH and USDC on Base and Base Sepolia, with recipient-scoped permissions, indexed
balances, and a Trails conversion. See its README for setup and deployment.

## Wagmi connector

`@polygonlabs/oms-wallet-wagmi-connector` is an ESM-only package that adapts an active OMS Wallet SDK
instance to wagmi's connector API. See its
[README](packages/oms-wallet-wagmi-connector/README.md) for usage. To work on it:

```bash
pnpm --filter @polygonlabs/oms-wallet-wagmi-connector build
pnpm --filter @polygonlabs/oms-wallet-wagmi-connector test
```

Workspace packages resolve each other from **source** (via the `@polygonlabs/source` export
condition), so no package needs to be built before its consumers — `pnpm test` and `pnpm build` run
from a clean checkout with no prior build. See [`AGENTS.md`](AGENTS.md) for the full architecture,
TypeScript setup, and conventions.

## Releases & publishing: CI stages, a maintainer approves

> **Never publish from a local machine.** Do not run `changeset version` or `changeset publish` (or
> `npm`/`pnpm publish`) yourself. A local publish bypasses CI, the signed release commit, and npm
> OIDC provenance. There are deliberately no `release` / `publish` package scripts.

The flow, end to end:

1. Every PR that changes a package includes a **changeset** (`pnpm exec changeset`, or
   `pnpm exec changeset add --empty` for no-release changes) committed alongside the code.
2. Merging changesets to `master` opens a **`changesets: Release / Deploy`** PR that bumps both
   packages and updates their changelogs.
3. Merging that PR triggers CI to pack both packages and **stage** them on npm via OIDC trusted
   publishing (`npm stage publish`). Once both stage, CI tags the release and creates a GitHub
   Release. Nothing is installable yet.
4. An npm maintainer approves both staged packages with 2FA, SDK first. Only then do they become
   publicly installable. No one runs a publish command locally.

### Snapshot / prerelease publishes

To ship a **throwaway prerelease** under a non-`latest` npm dist-tag — e.g. so a downstream app can
install a build ahead of the real release — trigger the same **Release** workflow manually
(still CI, still no local publish):

1. GitHub → **Actions** → **Release** → **Run workflow**.
2. Set **`snapshot_tag`** to a **non-semver** dist-tag (e.g. `canary`, `pre-0.3.0`). A semver-shaped
   value like `0.3.0` is rejected — the snapshot path skips the git tag and GitHub Release, so a real
   version string must never be used here.
3. CI runs `changeset version --snapshot <tag>` on the runner (never committed) and stages both
   packages via OIDC. After an npm maintainer approves the stages with 2FA, consumers install it
   with `pnpm add @polygonlabs/oms-wallet@<tag>`.

This never creates a git tag or GitHub Release; the normal `master` flow above stays the only way to
cut a real version.

Full details are in [`PUBLISHING.md`](PUBLISHING.md). Changeset authoring guidance lives in the
[`changeset-commit`](.agents/skills/changeset-commit/SKILL.md) agent skill.

## Contributing

- Follow the conventions in [`AGENTS.md`](AGENTS.md) (imported by `CLAUDE.md` for Claude Code; read
  natively by Codex and other agents).
- Every package-touching PR needs a changeset (see above); the `Changeset check` CI job enforces it.
- Testing conventions and commands are in [`TESTING.md`](TESTING.md).
