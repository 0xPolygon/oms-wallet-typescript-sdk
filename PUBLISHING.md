# Publishing

The SDK and wagmi connector release in lockstep. The connector source manifest keeps
`@polygonlabs/oms-wallet` as `workspace:^` in `peerDependencies` and `workspace:*` in
`devDependencies`. This gives local development a workspace link, and `pnpm pack` / `pnpm publish`
rewrites the published peer dependency to a semver range for the release version.

Do not replace the connector's SDK peer with a literal version in source, and do not publish with
`npm publish`. Use pnpm from the workspace root so the `workspace:` protocol is rewritten before
the package reaches npm.

## Before Merging The Release PR

Before publishing a new stable version, update these values to the same exact version:

- `package.json` `version`
- `packages/oms-wallet-wagmi-connector/package.json` `version`

Leave these values as workspace protocols:

- `packages/oms-wallet-wagmi-connector/package.json` `peerDependencies["@polygonlabs/oms-wallet"]`: `workspace:^`
- `packages/oms-wallet-wagmi-connector/package.json` `devDependencies["@polygonlabs/oms-wallet"]`: `workspace:*`

## After The Release PR Is Merged

1. Switch to the latest `master`:

```bash
git checkout master
git pull
pnpm install --frozen-lockfile
```

2. Capture the release version and verify the release:

```bash
VERSION=$(node -p "require('./package.json').version")
pnpm verify:release --stable
```

This is the same command CI runs, with the additional stable-version check. It typechecks and tests
the SDK and connector, builds every example, packs both publishable packages, checks their contents,
and verifies that pnpm rewrites the connector's `workspace:` dependencies to the release version.

3. Dry-run the release:

```bash
pnpm release:dry-run
```

If the dry run reports no new packages, the version is already published. Stop and verify the
intended release version before continuing.

4. Log in to npm if needed:

```bash
pnpm npm login
pnpm npm whoami
```

5. Publish both workspace packages from the root:

```bash
pnpm release:publish
```

If the filtered publish is interrupted after the SDK is published, rerun the connector publish with
pnpm:

```bash
pnpm --filter @polygonlabs/oms-wallet-wagmi-connector publish --access public
```

6. Verify published versions and latest dist tags:

```bash
pnpm view @polygonlabs/oms-wallet@$VERSION version
pnpm view @polygonlabs/oms-wallet-wagmi-connector@$VERSION version
pnpm view @polygonlabs/oms-wallet@latest version
pnpm view @polygonlabs/oms-wallet-wagmi-connector@latest version
```

7. Create a git tag and GitHub release for `v$VERSION`.

## Alpha, Beta, And Snapshot Releases

Use the stable flow above for normal releases. Use this section only when you intentionally want a
non-`latest` npm dist tag.

1. Set both publishable package versions to the same prerelease version:

```bash
# Examples:
# 0.2.1-alpha.0
# 0.2.1-beta.0
# 0.2.1-snapshot.20260703.0
```

Update:

- `package.json` `version`
- `packages/oms-wallet-wagmi-connector/package.json` `version`

Then capture and verify the prerelease:

```bash
VERSION=$(node -p "require('./package.json').version")
pnpm verify:release
```

2. Dry-run with the matching npm tag:

```bash
pnpm release:dry-run --tag alpha
```

Use `--tag beta` for beta builds and `--tag snapshot` for snapshot builds.

3. Publish with the same tag used in the dry run:

```bash
pnpm release:publish --tag alpha
```

4. Verify the exact version and dist tag:

```bash
pnpm view @polygonlabs/oms-wallet@$VERSION version
pnpm view @polygonlabs/oms-wallet-wagmi-connector@$VERSION version
pnpm view @polygonlabs/oms-wallet@alpha version
pnpm view @polygonlabs/oms-wallet-wagmi-connector@alpha version
```

Replace `alpha` with `beta` or `snapshot` for those release types.

Do not leave prerelease versions or prerelease npm tags in source when preparing a stable release.
