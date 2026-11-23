import assert from 'node:assert/strict';
import test from 'node:test';

import {
  snapshotPackages,
  assertSnapshotVersions,
  changesetHasRelease,
  validateSnapshotTag
} from './prepare-npm-snapshot.mjs';

test('accepts safe non-latest snapshot tags', () => {
  for (const tag of ['snapshot', 'canary', 'pre-0.3.0', 'canary.1', 'next-2']) {
    assert.doesNotThrow(() => validateSnapshotTag(tag));
  }
});

test('rejects latest, version-like, and malformed snapshot tags', () => {
  for (const tag of [
    'latest',
    '0.3.0',
    'v0.3.0',
    '0.3.0-beta.1',
    'beta tag',
    'Beta',
    'canary_arm',
    'canary..1',
    'canary.',
    'canary.01',
    '^1.2.0'
  ]) {
    assert.throws(() => validateSnapshotTag(tag));
  }
});

test('detects whether a changeset contains a package release', () => {
  assert.equal(changesetHasRelease('---\n---\n\nDocumentation only.\n'), false);
  assert.equal(
    changesetHasRelease('---\n"@polygonlabs/oms-wallet": patch\n---\n\nFix behavior.\n'),
    true
  );
});

const fixed = [['@polygonlabs/oms-wallet', '@polygonlabs/oms-wallet-wagmi-connector']];
const before = [
  { name: '@polygonlabs/oms-wallet', version: '0.2.0' },
  { name: '@polygonlabs/oms-wallet-wagmi-connector', version: '0.2.0' },
  { name: '@polygonlabs/oms-server-wallet-sdk', version: '0.4.0' }
];
const snapshot = (version) => (item) => ({ ...item, version });

test('requires every fixed package to receive the requested snapshot version', () => {
  const after = [...before.slice(0, 2).map(snapshot('0.0.0-canary-20260909000000')), before[2]];

  assert.doesNotThrow(() => assertSnapshotVersions(before, after, 'canary', fixed));
  assert.throws(
    () => assertSnapshotVersions(before, before, 'canary', fixed),
    /did not change any package/
  );
  assert.throws(
    () => assertSnapshotVersions(before, after, 'snapshot', fixed),
    /did not receive the requested 'snapshot' snapshot version/
  );
  assert.throws(
    () =>
      assertSnapshotVersions(
        before,
        [after[0], { ...after[1], version: '0.0.0-canary-20260909000001' }, after[2]],
        'canary',
        fixed
      ),
    /Snapshot packages must have one fixed-group version/
  );
  assert.throws(
    () => assertSnapshotVersions(before, [after[0], before[1], after[2]], 'canary', fixed),
    /did not change every package in the fixed group/
  );
  assert.throws(
    () => assertSnapshotVersions(before, after.slice(0, 2), 'canary', fixed),
    /The publishable package set changed unexpectedly/
  );
});

test('snapshots an independent package on its own', () => {
  const after = [...before.slice(0, 2), snapshot('0.4.1-canary-20260909000000')(before[2])];
  assert.doesNotThrow(() => assertSnapshotVersions(before, after, 'canary', fixed));
});

test('lists exactly the packages snapshot versioning changed', () => {
  const after = [...before.slice(0, 2).map(snapshot('0.0.0-canary-20260909000000')), before[2]];
  assert.deepEqual(snapshotPackages(before, after), [
    { name: '@polygonlabs/oms-wallet', version: '0.0.0-canary-20260909000000' },
    { name: '@polygonlabs/oms-wallet-wagmi-connector', version: '0.0.0-canary-20260909000000' }
  ]);
});
