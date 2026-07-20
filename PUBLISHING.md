# Publishing

> **Publishing is CI-only. Never publish from a local machine.** Do not run `changeset version`,
> `changeset publish`, `npm publish`, or `pnpm publish` yourself — a local publish bypasses CI, the
> signed release commit, and npm OIDC trusted-publishing provenance. This repo deliberately exposes
> **no** `release` / `ci:publish` package scripts; the only supported path is the automated flow
> below. Your job as a contributor is to land a changeset (see "Day-to-day") and let CI do the rest.

Releases are driven by [changesets](https://github.com/changesets/changesets). The SDK
(`@polygonlabs/oms-wallet`) and the wagmi connector (`@polygonlabs/oms-wallet-wagmi-connector`)
release **in lockstep**: they are declared as a `fixed` group in `.changeset/config.json`, so any
release bumps both to the same new version regardless of which one changed.

The connector source manifest keeps `@polygonlabs/oms-wallet` as `workspace:^` in
`peerDependencies` and `workspace:*` in `devDependencies`. Do not replace those with literal
versions in source — changesets rewrites them to the published semver range at release time
(`bumpVersionsWithWorkspaceProtocolOnly: false`).

## Day-to-day: add a changeset

Every PR that changes files inside a workspace package must include a changeset. From the repo
root:

```bash
pnpm exec changeset
```

Pick the bump type and write a user-facing changelog entry. Because both packages are a `fixed`
group, selecting either one bumps both. For changes with no consumer impact (internal refactors,
chores), record an empty changeset instead:

```bash
pnpm exec changeset add --empty
```

Commit the changeset in the same commit as the code. The `Changeset check` CI job fails a PR that
touches a package without one.

## Release flow (automated)

1. Merging PRs with changesets into `master` triggers the `Release` workflow
   (`.github/workflows/npm-release-trigger.yml` → `0xPolygon/pipelines`
   `apps-npm-release.yml`), which opens or updates a **`changesets: Release / Deploy`** PR that
   applies the pending changesets: it bumps both package versions, rewrites the connector's
   `workspace:` ranges to the new semver, and updates each `CHANGELOG.md`.
2. Review and merge that Release PR.
3. On merge, the same workflow publishes both packages to npm via **OIDC trusted publishing** (no
   `NPM_TOKEN`), pushes the git tags, and creates a GitHub Release per tag with the body extracted
   from each package's `CHANGELOG.md`.

Version-bump commits are signed by GitHub's GPG key (`commitMode: github-api`) to satisfy branch
protection. There is no manual `npm publish` / `pnpm publish` step — publishing is the workflow's
job.

## Local verification

Run the same gates CI runs before handing off release-affecting changes:

```bash
pnpm install --frozen-lockfile
pnpm lint      # eslint + markdownlint + prettier + typecheck
pnpm test      # SDK + connector test suites
pnpm build     # build packages (dual CJS+ESM) + all examples
pnpm check:exports   # publint — validates the publishable packages' exports/types
```

These are the same standard scripts the CI workflow runs (`.github/workflows/ci-trigger.yml`): the
shared `ci` composite runs lint/typecheck/test, a build job runs `build` + `check:exports`, and a
drift-check job runs each package's `codegen-drift-check`. The `workspace:` → semver rewrite at
publish is guaranteed by pnpm + changesets (`bumpVersionsWithWorkspaceProtocolOnly: false`), so it
no longer needs a bespoke check.

## Prerelease / snapshot builds

To publish a throwaway prerelease under a non-`latest` npm dist-tag (e.g. for a downstream service
to consume ahead of a real release), manually dispatch the repo's **Release** workflow — this is
still CI, not a local publish:

1. GitHub → **Actions** → **Release** → **Run workflow**.
2. Set the **`snapshot_tag`** input to a non-semver dist-tag (e.g. `canary`, `pre-0.3.0`).

The `Release` trigger (`.github/workflows/npm-release-trigger.yml`) forwards `snapshot_tag` to the
shared `apps-npm-release.yml`, which runs `changeset version --snapshot <tag>` on the runner (never
committed) and `changeset publish --tag <tag> --no-git-tag` via OIDC. The snapshot path skips the
git tag and GitHub Release, so **`snapshot_tag` must not be a semver-shaped value** (`0.3.0`,
`v0.3.0`, `0.3.0-beta.1`, …) — the workflow validates the input and aborts on a semver-shaped value.
Consumers install the result with `pnpm add @polygonlabs/oms-wallet@<tag>`.
