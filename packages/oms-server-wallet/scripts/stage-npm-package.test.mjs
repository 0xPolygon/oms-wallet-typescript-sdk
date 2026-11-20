import assert from 'node:assert/strict';
import test from 'node:test';

const stagePackageModule = import('./stage-npm-package.mjs');

test('accepts the public root release package', async () => {
  const { validateReleasePackage } = await stagePackageModule;
  const packageManifest = {
    name: '@polygonlabs/oms-server-wallet-sdk',
    version: '1.2.3'
  };
  assert.equal(validateReleasePackage(packageManifest), packageManifest);
});

test('rejects a private release package', async () => {
  const { validateReleasePackage } = await stagePackageModule;
  assert.throws(
    () =>
      validateReleasePackage({
        name: '@polygonlabs/oms-server-wallet-sdk',
        version: '1.2.3',
        private: true
      }),
    /must not be private/
  );
});

test('finds nested workspace protocol references in packed manifests', async () => {
  const { findWorkspaceReferences } = await stagePackageModule;
  assert.deepEqual(
    findWorkspaceReferences({
      peerDependencies: { sdk: 'workspace:^' },
      publishConfig: { dependencies: { sdk: '^1.2.3' } }
    }),
    ['package.json.peerDependencies.sdk']
  );
});

test('requires GitHub Actions OIDC before staging', async () => {
  const { assertTrustedPublishingEnvironment } = await stagePackageModule;
  assert.throws(() => assertTrustedPublishingEnvironment({}), /CI-only/);
  assert.throws(
    () => assertTrustedPublishingEnvironment({ GITHUB_ACTIONS: 'true' }),
    /OIDC is unavailable/
  );
  assert.doesNotThrow(() =>
    assertTrustedPublishingEnvironment({
      GITHUB_ACTIONS: 'true',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.test/oidc'
    })
  );
});

test('requests provenance only when the source repository allows it', async () => {
  const { stagePublishArguments } = await stagePackageModule;
  assert.deepEqual(stagePublishArguments('/tmp/sdk.tgz', 'latest', false), [
    'stage',
    'publish',
    '/tmp/sdk.tgz',
    '--tag',
    'latest',
    '--access',
    'public'
  ]);
  assert.equal(stagePublishArguments('/tmp/sdk.tgz', 'next', true).at(-1), '--provenance');
});

test('uses the v<version> tag that changesets/action creates for a single package', async () => {
  const { releaseTagName } = await stagePackageModule;
  assert.equal(
    releaseTagName({ name: '@polygonlabs/oms-server-wallet-sdk', version: '0.3.0' }),
    'v0.3.0'
  );
});
