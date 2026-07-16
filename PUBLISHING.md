# Publishing

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

Run the same gate CI runs before handing off release-affecting changes:

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` typechecks and tests the SDK and connector, builds every example, packs both
publishable packages, and asserts their contents contain no unrewritten `workspace:` dependency.

## Prerelease / snapshot builds

To publish a throwaway prerelease under a non-`latest` npm dist-tag (e.g. for a downstream service
to consume ahead of a real release), run the release workflow with a `snapshot_tag` input via
`workflow_dispatch` on the shared `apps-npm-release.yml`. The snapshot path bumps versions on the
runner (never committed), publishes under the given dist-tag, and skips git tags and GitHub
Releases. The `snapshot_tag` must not be a semver-shaped value.
