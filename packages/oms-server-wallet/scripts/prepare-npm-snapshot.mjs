import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changesetDirectory = path.join(repositoryRoot, '.changeset');

export function validateSnapshotTag(tag) {
  assert(tag, 'SNAPSHOT_TAG is required.');
  assert.notEqual(tag, 'latest', "The snapshot tag must not be 'latest'.");
  // The tag becomes a SemVer pre-release identifier, which does not allow underscores.
  assert(
    /^[a-z][a-z0-9.-]*$/.test(tag),
    'The snapshot tag must start with a lowercase letter and contain only lowercase letters, numbers, dots, or hyphens.'
  );
  assert(
    !/^v?\d+(?:\.\d+){0,2}(?:[-+].*)?$/.test(tag),
    'The snapshot tag must not look like a release version.'
  );
  // npm rejects dist-tags that parse as a SemVer range, such as `x` or `v1.x`.
  assert.equal(semver.validRange(tag), null, 'The snapshot tag must not be a valid SemVer range.');
}

export function changesetHasRelease(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return false;
  const frontmatterEnd = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (frontmatterEnd === -1) return false;
  return lines
    .slice(1, frontmatterEnd)
    .some((line) => /^\s*(?:"[^"]+"|'[^']+'|[^:#][^:]*):\s*(?:major|minor|patch)\s*$/.test(line));
}

export function assertSnapshotVersion(before, after, tag) {
  assert.equal(after.name, before.name, 'The release package changed unexpectedly.');
  assert.notEqual(
    after.version,
    before.version,
    `Snapshot versioning did not change ${after.name}.`
  );
  assert(
    after.version.includes(`-${tag}-`),
    `${after.name} did not receive the requested '${tag}' snapshot version.`
  );
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
  }
}

async function readReleasePackage() {
  const packageManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')
  );
  assert.notEqual(packageManifest.private, true, 'The release package must not be private.');
  return { name: packageManifest.name, version: packageManifest.version };
}

async function hasVersionedChangeset() {
  const entries = await readdir(changesetDirectory);
  const changesets = entries.filter((entry) => entry.endsWith('.md') && entry !== 'README.md');
  const contents = await Promise.all(
    changesets.map((entry) => readFile(path.join(changesetDirectory, entry), 'utf8'))
  );
  return contents.some(changesetHasRelease);
}

async function main() {
  const tag = process.env.SNAPSHOT_TAG;
  validateSnapshotTag(tag);

  const before = await readReleasePackage();
  let temporaryChangeset;
  if (!(await hasVersionedChangeset())) {
    temporaryChangeset = path.join(changesetDirectory, `ci-snapshot-${process.pid}.md`);
    await writeFile(
      temporaryChangeset,
      `---\n"${before.name}": patch\n---\n\nCreate a temporary CI snapshot release.\n`,
      { encoding: 'utf8', flag: 'wx' }
    );
    console.log('No versioned changesets found; created a temporary snapshot changeset.');
  }

  try {
    runChecked('pnpm', ['exec', 'changeset', 'version', '--snapshot', tag]);
  } finally {
    if (temporaryChangeset) {
      await unlink(temporaryChangeset).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  const after = await readReleasePackage();
  assertSnapshotVersion(before, after, tag);
  console.log(`Prepared snapshot ${after.version}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
