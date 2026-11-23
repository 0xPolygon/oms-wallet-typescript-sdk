# Publishing

> **Publishing is CI-only. Never publish or stage from a local machine.** Do not run
> `changeset version`, `npm publish`, `npm stage publish`, `pnpm publish` or the internal
> `ci:stage-release` script yourself. A local release bypasses the signed release commit and npm
> OIDC trusted publishing. Land a changeset and let CI prepare the release; an npm maintainer
> performs the final 2FA approval.

Releases of `@polygonlabs/oms-server-wallet-sdk` are driven by
[changesets](https://github.com/changesets/changesets).

## Day-to-day: add a changeset

Every pull request needs a changeset. From the repository root:

```bash
pnpm exec changeset
```

Pick the bump type and write a user-facing changelog entry. For changes with no consumer impact (CI,
docs, tooling, internal refactors), record an empty changeset instead:

```bash
pnpm exec changeset add --empty
```

The `Changeset check` CI job fails a pull request without one.

## Release flow (automated)

1. Merging pull requests with changesets into `main` runs the `Release` workflow
   (`.github/workflows/release.yml`). It opens or updates a **`changesets: Release`** pull request
   that applies the pending changesets, bumps the version and updates `CHANGELOG.md`.
2. Review and merge that release pull request.
3. On merge, the same workflow first runs the release gates in a separate `verification` job (lint,
   typecheck, tests, coverage, publint and the clean-consumer package check). That job has no npm
   OIDC or release-bot credentials, because the package check installs the packed archive with
   freshly resolved dependencies and runs it. Only after it passes does the release job run
   `pnpm run ci:stage-release`, which builds, packs the package with pnpm and stages the tarball
   with `npm stage publish` through **OIDC trusted publishing** (no `NPM_TOKEN`). Changesets then
   pushes the `v<version>` tag and creates a GitHub Release.
4. An npm maintainer inspects and approves the staged package with 2FA. Only an approved package
   becomes installable.

Release commits are created through the GitHub API (`commitMode: github-api`) so they are signed and
satisfy the signed-commit rule. A tag and GitHub Release record that CI staged the exact artifact;
they do not mean npm approval has finished.

npm attests [provenance](https://docs.npmjs.com/generating-provenance-statements) only for public
source repositories. The workflow passes `--provenance` when this repository is public and omits it
otherwise; the job summary says which applied.

### Approve a staged release

```bash
npm stage list @polygonlabs/oms-server-wallet-sdk
npm stage view <stage-id>
npm stage approve <stage-id> # prompts for 2FA
```

If staging succeeded but the package tag was not created, reject that stage with
`npm stage reject <stage-id>` before retrying, because staging reserves the version. A rerun checks
first and skips a version whose `v<version>` tag exists or that is already published.

## Snapshots

Run the `Release` workflow manually (**Actions → Release → Run workflow**) on `main` with a dist-tag
such as `next` or `canary`: lowercase letters, numbers, dots and hyphens, and neither a SemVer
version nor a range such as `x` or `v1.x`. Snapshots can only be staged from `main`, because the
publishing environment is limited to it. It versions a snapshot (`0.0.0-<tag>-<timestamp>`), stages it under that
dist-tag and creates no git tag. It still needs maintainer approval on npm. Never use `latest` for a
snapshot; the workflow rejects it.

## One-time setup

- **GitHub environment:** create an `npm-release` environment whose deployment branches are limited
  to `main`. Both publishing jobs run in it.
- **npm:** configure a trusted publisher for `@polygonlabs/oms-server-wallet-sdk` with repository
  `0xPolygon/oms-server-wallet-sdk`, workflow `release.yml` and environment `npm-release`. Naming the
  environment matters: without it, a branch could edit its own copy of the workflow and request a
  token. Approvers come from the organization's npm publishing team.
- **GitHub:** the repository needs the `CHANGESET_RELEASE_BOT_APP_ID` and
  `CHANGESET_RELEASE_BOT_APP_PRIVATE_KEY` secrets for the release bot app, and the app needs access
  to this repository.

## Local verification

These commands prepare and inspect a release candidate without publishing:

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test && pnpm check:exports
pnpm test:package
```

`test:package` builds and packs the package into `.data/package/`, checks the archive's file
allowlist, installs it into a clean consumer with install scripts disabled, verifies ESM imports,
declarations and a quote/recovery/encryption smoke test, and writes `validation.json` with the
archive's SHA-512 integrity.
