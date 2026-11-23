import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared by the release jobs: pack-npm-packages.mjs packs and checks the packages in a job without
// npm or GitHub write credentials, and stage-npm-packages.mjs stages exactly those files.

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ARTIFACT_MANIFEST = 'release-manifest.json';

export function validateReleasePackages(workspaces, changesetsConfig) {
  const releasePackages = workspaces.filter((workspace) => workspace.private !== true);
  assert(releasePackages.length > 0, 'No publishable workspace packages were found.');

  const packagesByName = new Map(releasePackages.map((workspace) => [workspace.name, workspace]));
  const grouped = new Set();
  const ordered = [];
  for (const group of changesetsConfig.fixed ?? []) {
    const members = group.map((name) => {
      const member = packagesByName.get(name);
      assert(
        member,
        `Changesets fixed group member ${name} is not a publishable workspace package.`
      );
      assert(!grouped.has(name), `${name} belongs to more than one Changesets fixed group.`);
      grouped.add(name);
      return member;
    });
    const versions = new Set(members.map((member) => member.version));
    assert.equal(versions.size, 1, 'Packages in a Changesets fixed group must have one version.');
    ordered.push(...members);
  }

  // Independently versioned packages follow the fixed groups, so the fixed groups are staged first.
  const independent = releasePackages
    .filter((workspace) => !grouped.has(workspace.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  return [...ordered, ...independent];
}

/**
 * The packages a snapshot run stages: exactly the names and versions the snapshot preparation
 * wrote, in release order, each checked against its manifest. Never a pending regular release.
 */
export function selectSnapshotPackages(releasePackages, snapshotPackages) {
  assert(
    Array.isArray(snapshotPackages) && snapshotPackages.length > 0,
    'The snapshot package list is empty.'
  );
  const wanted = new Map(snapshotPackages.map(({ name, version }) => [name, version]));
  assert.equal(
    wanted.size,
    snapshotPackages.length,
    'The snapshot package list repeats a package.'
  );
  for (const [name, version] of wanted) {
    const releasePackage = releasePackages.find((candidate) => candidate.name === name);
    assert(releasePackage, `Snapshot package ${name} is not a publishable workspace package.`);
    assert.equal(
      releasePackage.version,
      version,
      `Snapshot package ${name} is at ${releasePackage.version}, not the prepared ${version}.`
    );
  }
  return releasePackages.filter(({ name }) => wanted.has(name));
}

export function findWorkspaceReferences(value, currentPath = 'package.json') {
  if (typeof value === 'string') {
    return value.startsWith('workspace:') ? [currentPath] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findWorkspaceReferences(item, `${currentPath}[${index}]`)
    );
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      findWorkspaceReferences(item, `${currentPath}.${key}`)
    );
  }
  return [];
}

export function requiredEnvironment(name) {
  const value = process.env[name];
  assert(value, `${name} is required.`);
  return value;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options
  });
  if (result.error) throw result.error;
  return result;
}

export function runChecked(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}.\n${result.stderr ?? ''}`
    );
  }
  return result;
}

export function tarballName({ name, version }) {
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
}

export async function sha512File(file) {
  return `sha512-${createHash('sha512')
    .update(await readFile(file))
    .digest('base64')}`;
}

/** The package.json inside a packed tarball. */
export function readPackedManifest(tarballPath) {
  return JSON.parse(runChecked('tar', ['-xOzf', tarballPath, 'package/package.json']).stdout);
}

/** Checks a packed tarball's manifest: its name and version, and no workspace: range left. */
export function assertPackedManifest(packedManifest, { name, version }) {
  assert.equal(packedManifest.name, name, `Packed package ${name} has another name.`);
  assert.equal(packedManifest.version, version, `Packed package ${name} is not at ${version}.`);
  assert.deepEqual(
    findWorkspaceReferences(packedManifest),
    [],
    `pnpm did not rewrite every workspace: reference in ${name}.`
  );
}

/**
 * Verifies a release artifact before anything is staged from it: the manifest lists exactly the
 * tarballs in the directory, each file has its recorded SHA-512, and the package.json inside each
 * has the listed name and version. Returns the packages in release order.
 */
export async function verifyArtifact(directory, readManifest = readPackedManifest) {
  const manifest = JSON.parse(await readFile(path.join(directory, ARTIFACT_MANIFEST), 'utf8'));
  assert(['stable', 'snapshot'].includes(manifest.mode), 'The release manifest has no valid mode.');
  assert(
    Array.isArray(manifest.packages) && manifest.packages.length > 0,
    'The release manifest lists no packages.'
  );
  const files = (await readdir(directory)).filter((file) => file.endsWith('.tgz')).sort();
  const listed = manifest.packages.map(({ file }) => file).sort();
  assert.deepEqual(
    files,
    listed,
    'The release artifact holds other tarballs than its manifest lists.'
  );
  for (const entry of manifest.packages) {
    assert.equal(path.basename(entry.file), entry.file, `${entry.file} is not a plain file name.`);
    const tarballPath = path.join(directory, entry.file);
    assert.equal(
      await sha512File(tarballPath),
      entry.integrity,
      `${entry.file} does not have the SHA-512 recorded when it was packed and checked.`
    );
    assertPackedManifest(readManifest(tarballPath), entry);
  }
  return manifest;
}
