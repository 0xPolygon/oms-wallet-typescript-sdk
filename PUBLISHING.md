# Publishing

The SDK and wagmi connector release in lockstep. The connector source manifest keeps
`@polygonlabs/oms-wallet` as `workspace:*` in both `peerDependencies` and `devDependencies`.
This gives local development a workspace link, and `pnpm pack` / `pnpm publish` rewrites the
published peer dependency to the exact release version.

Do not replace the connector's SDK peer with a literal version in source, and do not publish with
`npm publish`. Use pnpm from the workspace root so the `workspace:*` protocol is rewritten before
the package reaches npm.

## Before Merging The Release PR

Before publishing a new stable version, update these values to the same exact version:

- `package.json` `version`
- `packages/oms-wallet-wagmi-connector/package.json` `version`

Leave these values as `workspace:*`:

- `packages/oms-wallet-wagmi-connector/package.json` `peerDependencies["@polygonlabs/oms-wallet"]`
- `packages/oms-wallet-wagmi-connector/package.json` `devDependencies["@polygonlabs/oms-wallet"]`

## After The Release PR Is Merged

1. Switch to the latest `master`:

```bash
git checkout master
git pull
pnpm install --frozen-lockfile
```

2. Capture the release version and verify package metadata:

```bash
VERSION=$(node -p "require('./package.json').version")
pnpm check:stable-package-versions
```

3. Run release checks:

```bash
pnpm test
pnpm --filter @polygonlabs/oms-wallet-wagmi-connector test
pnpm --filter @polygonlabs/oms-wallet-wagmi-connector build
pnpm build
pnpm build:node-example
pnpm build:node-contract-deploy-example
pnpm build:example
pnpm build:trails-actions-example
pnpm build:wagmi-example
```

4. Dry-run the filtered workspace publish:

```bash
pnpm --filter @polygonlabs/oms-wallet \
  --filter @polygonlabs/oms-wallet-wagmi-connector \
  publish --dry-run --no-git-checks --access public
```

If the dry run reports no new packages, the version is already published. Stop and verify the
intended release version before continuing.

5. Log in to npm if needed:

```bash
pnpm npm login
pnpm npm whoami
```

6. Publish both workspace packages from the root:

```bash
pnpm --filter @polygonlabs/oms-wallet \
  --filter @polygonlabs/oms-wallet-wagmi-connector \
  publish --access public
```

If the filtered publish is interrupted after the SDK is published, rerun the connector publish with
pnpm:

```bash
pnpm --filter @polygonlabs/oms-wallet-wagmi-connector publish --access public
```

7. Verify published versions and latest dist tags:

```bash
pnpm view @polygonlabs/oms-wallet@$VERSION version
pnpm view @polygonlabs/oms-wallet-wagmi-connector@$VERSION version
pnpm view @polygonlabs/oms-wallet@latest version
pnpm view @polygonlabs/oms-wallet-wagmi-connector@latest version
```

8. Create a git tag and GitHub release for `v$VERSION`.

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

Then capture and verify the prerelease version:

```bash
VERSION=$(node -p "require('./package.json').version")
pnpm check:package-versions
```

2. Dry-run with the matching npm tag:

```bash
pnpm --filter @polygonlabs/oms-wallet \
  --filter @polygonlabs/oms-wallet-wagmi-connector \
  publish --dry-run --no-git-checks --tag alpha --access public
```

Use `--tag beta` for beta builds and `--tag snapshot` for snapshot builds.

3. Publish with the same tag used in the dry run:

```bash
pnpm --filter @polygonlabs/oms-wallet \
  --filter @polygonlabs/oms-wallet-wagmi-connector \
  publish --tag alpha --access public
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
