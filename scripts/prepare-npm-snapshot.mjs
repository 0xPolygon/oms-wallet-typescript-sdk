import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changesetDirectory = path.join(repositoryRoot, '.changeset');

export function validateSnapshotTag(tag) {
  assert(tag, 'SNAPSHOT_TAG is required.');
  assert.notEqual(tag, 'latest', "The snapshot tag must not be 'latest'.");
  assert(
    /^[a-z][a-z0-9._-]*$/.test(tag),
    'The snapshot tag must start with a lowercase letter and contain only lowercase letters, numbers, dots, underscores, or hyphens.'
  );
  assert(
    !/^v?\d+(?:\.\d+){0,2}(?:[-+].*)?$/.test(tag),
    'The snapshot tag must not look like a release version.'
  );
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

export function assertSnapshotVersions(before, after, tag, fixed = []) {
  assert.equal(after.length, before.length, 'The publishable package set changed unexpectedly.');
  assert(after.length > 0, 'No publishable packages were found.');

  const changed = [];
  for (const currentPackage of after) {
    const previousPackage = before.find(({ name }) => name === currentPackage.name);
    assert(
      previousPackage,
      `Snapshot package ${currentPackage.name} was not present before versioning.`
    );
    if (currentPackage.version === previousPackage.version) continue;
    assert(
      currentPackage.version.includes(`-${tag}-`),
      `${currentPackage.name} did not receive the requested '${tag}' snapshot version.`
    );
    changed.push(currentPackage.name);
  }
  assert(changed.length > 0, 'Snapshot versioning did not change any package.');

  for (const group of fixed) {
    const members = after.filter(({ name }) => group.includes(name));
    const changedMembers = members.filter(({ name }) => changed.includes(name));
    if (changedMembers.length === 0) continue;
    assert.equal(
      changedMembers.length,
      members.length,
      `Snapshot versioning did not change every package in the fixed group of ${changedMembers[0].name}.`
    );
    const versions = new Set(members.map(({ version }) => version));
    assert.equal(versions.size, 1, 'Snapshot packages must have one fixed-group version.');
  }
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

async function readReleasePackages() {
  const result = spawnSync('pnpm', ['--recursive', 'list', '--depth', '-1', '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `pnpm list failed with exit code ${result.status}.`);
  // pnpm resolves each package's folder, so a folder may differ from its package name.
  return Promise.all(
    JSON.parse(result.stdout)
      .filter((workspace) => workspace.private !== true)
      .map(async ({ name, path: packageDirectory }) => {
        const manifest = JSON.parse(
          await readFile(path.join(packageDirectory, 'package.json'), 'utf8')
        );
        assert.equal(manifest.name, name, `Could not resolve the package manifest for ${name}.`);
        return { name, version: manifest.version };
      })
  );
}

async function readFixedGroups() {
  const config = JSON.parse(await readFile(path.join(changesetDirectory, 'config.json'), 'utf8'));
  return config.fixed ?? [];
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

  const before = await readReleasePackages();
  const fixed = await readFixedGroups();
  let temporaryChangeset;
  if (!(await hasVersionedChangeset())) {
    temporaryChangeset = path.join(changesetDirectory, `ci-snapshot-${process.pid}.md`);
    await writeFile(
      temporaryChangeset,
      `---\n"${fixed[0]?.[0] ?? before[0].name}": patch\n---\n\nCreate a temporary CI snapshot release.\n`,
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

  const after = await readReleasePackages();
  assertSnapshotVersions(before, after, tag, fixed);
  for (const { name, version } of after) {
    if (version.includes(`-${tag}-`)) console.log(`Prepared snapshot ${name}@${version}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
