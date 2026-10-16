import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSnapshotVersions,
  changesetHasRelease,
  validateSnapshotTag
} from './prepare-npm-snapshot.mjs';

test('accepts safe non-latest snapshot tags', () => {
  for (const tag of ['snapshot', 'canary', 'pre-0.3.0']) {
    assert.doesNotThrow(() => validateSnapshotTag(tag));
  }
});

test('rejects latest, version-like, and malformed snapshot tags', () => {
  for (const tag of ['latest', '0.3.0', 'v0.3.0', '0.3.0-beta.1', 'beta tag', 'Beta']) {
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

test('requires every fixed package to receive the requested snapshot version', () => {
  const before = [
    { name: '@polygonlabs/oms-wallet', version: '0.2.0' },
    { name: '@polygonlabs/oms-wallet-wagmi-connector', version: '0.2.0' }
  ];
  const after = before.map(({ name }) => ({
    name,
    version: '0.0.0-canary-20260909000000'
  }));

  assert.doesNotThrow(() => assertSnapshotVersions(before, after, 'canary'));
  assert.throws(
    () => assertSnapshotVersions(before, before, 'canary'),
    /Snapshot versioning did not change/
  );
  assert.throws(
    () => assertSnapshotVersions(before, after, 'snapshot'),
    /did not receive the requested 'snapshot' snapshot version/
  );
  assert.throws(
    () =>
      assertSnapshotVersions(
        before,
        [after[0], { ...after[1], version: '0.0.0-canary-20260909000001' }],
        'canary'
      ),
    /Snapshot packages must have one fixed-group version/
  );
  assert.throws(
    () => assertSnapshotVersions(before, after.slice(0, 1), 'canary'),
    /The publishable package set changed unexpectedly/
  );
  assert.throws(
    () =>
      assertSnapshotVersions(
        before,
        [after[0], { name: '@polygonlabs/unexpected', version: after[1].version }],
        'canary'
      ),
    /Snapshot package @polygonlabs\/unexpected was not present before versioning/
  );
});
