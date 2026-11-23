import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertTrustedPublishingEnvironment,
  findWorkspaceReferences,
  isSnapshotVersion,
  validateReleasePackages
} from './stage-npm-packages.mjs';

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

test('stages only snapshot versions during a snapshot run', () => {
  assert.equal(isSnapshotVersion('0.0.0-canary-20260909000000', 'canary'), true);
  assert.equal(isSnapshotVersion('0.3.0', 'canary'), false);
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
