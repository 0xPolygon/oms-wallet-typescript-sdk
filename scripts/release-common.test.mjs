import assert from 'node:assert/strict';
import test from 'node:test';

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ARTIFACT_MANIFEST,
  findWorkspaceReferences,
  selectSnapshotPackages,
  sha512File,
  validateReleasePackages,
  verifyArtifact
} from './release-common.mjs';
import { assertTrustedPublishingEnvironment, expectedArtifactMode } from './stage-npm-packages.mjs';

const releasePackages = [
  { name: '@polygonlabs/oms-wallet', version: '1.2.3', path: '/repo/packages/oms-wallet' },
  {
    name: '@polygonlabs/oms-wallet-wagmi-connector',
    version: '1.2.3',
    path: '/repo/packages/oms-wallet-wagmi-connector'
  }
];
const fixed = [releasePackages.map(({ name }) => name)];
const serverPackage = {
  name: '@polygonlabs/oms-server-wallet-sdk',
  version: '0.4.0',
  path: '/repo/packages/oms-server-wallet'
};

test('orders fixed-group packages first, then independent packages by name', () => {
  const workspaces = [
    serverPackage,
    releasePackages[1],
    { name: 'private-example', version: '0.0.0', private: true },
    releasePackages[0]
  ];
  assert.deepEqual(validateReleasePackages(workspaces, { fixed }), [
    ...releasePackages,
    serverPackage
  ]);
});

test('releases independent packages when there is no fixed group', () => {
  assert.deepEqual(validateReleasePackages([serverPackage], { fixed: [] }), [serverPackage]);
});

test('rejects fixed-package version drift', () => {
  const workspaces = [releasePackages[0], { ...releasePackages[1], version: '1.2.4' }];
  assert.throws(
    () => validateReleasePackages(workspaces, { fixed }),
    /fixed group must have one version/
  );
});

test('rejects a fixed-group member that is not a publishable workspace package', () => {
  assert.throws(
    () =>
      validateReleasePackages(
        [releasePackages[0], { ...releasePackages[1], private: true }, serverPackage],
        { fixed }
      ),
    /is not a publishable workspace package/
  );
});

test('stages exactly the packages the snapshot preparation versioned, in release order', () => {
  const ordered = [
    ...releasePackages.map((item) => ({ ...item, version: '0.0.0-canary-20260909000000' })),
    { ...serverPackage, version: '0.4.1-canary-20260909000000' }
  ];
  const listed = [...ordered].reverse().map(({ name, version }) => ({ name, version }));
  assert.deepEqual(selectSnapshotPackages(ordered, listed), ordered);
});

test('never stages an unchanged package whose version merely contains the tag', () => {
  const workspaces = [
    ...releasePackages.map((item) => ({ ...item, version: '0.0.0-canary-20260909000000' })),
    { ...serverPackage, version: '0.4.0-dev-canary-rc' }
  ];
  const listed = workspaces.slice(0, 2).map(({ name, version }) => ({ name, version }));
  assert.deepEqual(selectSnapshotPackages(workspaces, listed), workspaces.slice(0, 2));
});

test('rejects a snapshot list that does not match the manifests', () => {
  assert.throws(
    () =>
      selectSnapshotPackages(releasePackages, [
        { name: releasePackages[0].name, version: '9.9.9' }
      ]),
    /not the prepared 9\.9\.9/
  );
  assert.throws(
    () => selectSnapshotPackages(releasePackages, [{ name: 'missing', version: '1.0.0' }]),
    /is not a publishable workspace package/
  );
  assert.throws(() => selectSnapshotPackages(releasePackages, []), /list is empty/);
});

test('finds nested workspace protocol references in packed manifests', () => {
  assert.deepEqual(
    findWorkspaceReferences({
      peerDependencies: { sdk: 'workspace:^' },
      publishConfig: { dependencies: { sdk: '^1.2.3' } }
    }),
    ['package.json.peerDependencies.sdk']
  );
});

test('requires GitHub Actions OIDC before staging', () => {
  assert.throws(() => assertTrustedPublishingEnvironment({}), /CI-only/);
  assert.throws(
    () => assertTrustedPublishingEnvironment({ GITHUB_ACTIONS: 'true' }),
    /OIDC is unavailable/
  );
  for (const credential of [
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token' },
    { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.test/oidc' }
  ]) {
    assert.throws(
      () => assertTrustedPublishingEnvironment({ GITHUB_ACTIONS: 'true', ...credential }),
      /OIDC is unavailable/
    );
  }
  assert.doesNotThrow(() =>
    assertTrustedPublishingEnvironment({
      GITHUB_ACTIONS: 'true',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.test/oidc'
    })
  );
});

// A directory shaped like the release artifact: real gzipped tarballs and their manifest.
async function artifact(packages, edit = (manifest) => manifest) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'release-artifact-test-'));
  const entries = [];
  for (const { name, version, packed = {} } of packages) {
    const staging = mkdtempSync(path.join(os.tmpdir(), 'release-package-test-'));
    mkdirSync(path.join(staging, 'package'));
    writeFileSync(
      path.join(staging, 'package/package.json'),
      JSON.stringify({ name, version, ...packed })
    );
    const file = `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
    execFileSync('tar', ['-czf', path.join(directory, file), '-C', staging, 'package']);
    rmSync(staging, { recursive: true });
    entries.push({ name, version, file, integrity: await sha512File(path.join(directory, file)) });
  }
  writeFileSync(
    path.join(directory, ARTIFACT_MANIFEST),
    JSON.stringify(edit({ mode: 'stable', commit: 'abc', packages: entries }))
  );
  return directory;
}

const core = { name: '@polygonlabs/oms-wallet', version: '1.2.3' };
const server = { name: '@polygonlabs/oms-server-wallet-sdk', version: '0.4.0' };

test('accepts an artifact whose tarballs match their manifest', async () => {
  const directory = await artifact([core, server]);
  const manifest = await verifyArtifact(directory);
  assert.deepEqual(
    manifest.packages.map(({ name }) => name),
    [core.name, server.name]
  );
});

test('rejects a tarball changed after it was packed and checked', async () => {
  const directory = await artifact([core, server]);
  const file = path.join(directory, 'polygonlabs-oms-server-wallet-sdk-0.4.0.tgz');
  writeFileSync(file, Buffer.concat([Buffer.from('x'), Buffer.from(file)]));
  await assert.rejects(verifyArtifact(directory), /does not have the SHA-512 recorded/);
});

test('rejects a tarball the manifest does not list, or a listed one that is missing', async () => {
  const extra = await artifact([core]);
  writeFileSync(path.join(extra, 'unlisted-1.0.0.tgz'), 'x');
  await assert.rejects(verifyArtifact(extra), /other tarballs than its manifest lists/);

  const missing = await artifact([core, server]);
  rmSync(path.join(missing, 'polygonlabs-oms-wallet-1.2.3.tgz'));
  await assert.rejects(verifyArtifact(missing), /other tarballs than its manifest lists/);
});

test('rejects a manifest entry that names another version than the tarball holds', async () => {
  const directory = await artifact([core], (manifest) => ({
    ...manifest,
    packages: manifest.packages.map((entry) => ({ ...entry, version: '9.9.9' }))
  }));
  await assert.rejects(verifyArtifact(directory), /is not at 9\.9\.9/);
});

test('rejects a tarball that still has a workspace: range', async () => {
  const directory = await artifact([
    { ...core, packed: { peerDependencies: { viem: 'workspace:^' } } }
  ]);
  await assert.rejects(verifyArtifact(directory), /did not rewrite every workspace: reference/);
});

test('rejects an artifact with no mode or no packages', async () => {
  await assert.rejects(
    verifyArtifact(await artifact([core], (manifest) => ({ ...manifest, mode: 'other' }))),
    /no valid mode/
  );
  await assert.rejects(
    verifyArtifact(await artifact([core], (manifest) => ({ ...manifest, packages: [] }))),
    /lists no packages/
  );
});

test('stable runs stage stable artifacts and snapshot runs stage snapshot artifacts', () => {
  assert.equal(expectedArtifactMode(true), 'stable');
  assert.equal(expectedArtifactMode(false), 'snapshot');
});
