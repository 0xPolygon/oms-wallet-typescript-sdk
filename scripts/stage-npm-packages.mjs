import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

export function assertTrustedPublishingEnvironment(environment) {
  assert.equal(
    environment.GITHUB_ACTIONS,
    'true',
    'Staged publishing is CI-only and must run in GitHub Actions.'
  );
  assert(
    environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN && environment.ACTIONS_ID_TOKEN_REQUEST_URL,
    'GitHub Actions OIDC is unavailable; the job needs id-token: write permission.'
  );
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert(value, `${name} is required.`);
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    ...options
  });
  if (result.error) throw result.error;
  return result;
}

function runChecked(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}.\n${result.stderr ?? ''}`
    );
  }
  return result;
}

function hasGitTag(tag) {
  const result = run('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`]);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`Unable to check git tag ${tag}.`);
  }
  return result.status === 0;
}

function isPublished({ name, version }) {
  const packageSpec = `${name}@${version}`;
  const result = run('npm', ['view', packageSpec, 'version', '--json']);
  if (result.status === 0) {
    return JSON.parse(result.stdout) === version;
  }
  if (/E404|404 Not Found/.test(`${result.stdout}\n${result.stderr}`)) {
    return false;
  }
  throw new Error(`Unable to determine whether ${packageSpec} is published.\n${result.stderr}`);
}

function tarballName({ name, version }) {
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
}

async function packPackage(releasePackage, outputDirectory) {
  const tarballPath = path.join(outputDirectory, tarballName(releasePackage));
  runChecked('pnpm', ['--dir', releasePackage.path, 'pack', '--out', tarballPath], {
    stdio: 'inherit'
  });

  const manifestResult = runChecked('tar', ['-xOf', tarballPath, 'package/package.json']);
  const packedManifest = JSON.parse(manifestResult.stdout);
  assert.equal(
    packedManifest.name,
    releasePackage.name,
    'Packed package name changed unexpectedly.'
  );
  assert.equal(
    packedManifest.version,
    releasePackage.version,
    'Packed package version changed unexpectedly.'
  );
  assert.deepEqual(
    findWorkspaceReferences(packedManifest),
    [],
    `pnpm did not rewrite every workspace: reference in ${releasePackage.name}.`
  );
  return tarballPath;
}

async function writeSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  assertTrustedPublishingEnvironment(process.env);
  const distTag = process.env.NPM_STAGE_TAG || 'latest';
  const createGitTags = process.env.NPM_STAGE_CREATE_GIT_TAGS !== 'false';

  const workspacesResult = runChecked('pnpm', ['--recursive', 'list', '--depth', '-1', '--json']);
  const changesetsConfig = JSON.parse(
    await readFile(path.join(repositoryRoot, '.changeset/config.json'), 'utf8')
  );
  const releasePackages = validateReleasePackages(
    JSON.parse(workspacesResult.stdout),
    changesetsConfig
  );

  const candidates = createGitTags
    ? releasePackages
    : selectSnapshotPackages(
        releasePackages,
        JSON.parse(await readFile(requiredEnvironment('NPM_STAGE_PACKAGES_FILE'), 'utf8'))
      );

  // One package at a time, in release order: each is looked up, packed and staged before the next
  // is looked at, so a later package's failure never prevents an earlier package's stage.
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'oms-wallet-npm-stage-'));
  // The job summary records each package as it is staged, so a later failure cannot hide it.
  await writeSummary(['### npm staged publishing', '']);
  let staged = 0;
  try {
    for (const releasePackage of candidates) {
      const tag = `${releasePackage.name}@${releasePackage.version}`;
      if (createGitTags && hasGitTag(tag)) {
        console.log(`${tag} is already tagged; skipping.`);
        continue;
      }
      if (isPublished(releasePackage)) {
        console.log(`${tag} is already published; skipping.`);
        continue;
      }
      const tarballPath = await packPackage(releasePackage, outputDirectory);
      runChecked(
        'npm',
        ['stage', 'publish', tarballPath, '--tag', distTag, '--access', 'public', '--provenance'],
        { stdio: 'inherit' }
      );
      staged += 1;
      console.log(`Staged ${tag} under ${distTag}.`);
      await writeSummary([`- \`${tag}\` is staged under \`${distTag}\`.`]);
      // changesets/action v1 creates this package's tag and GitHub Release from this line. If a
      // later package fails, the job still fails, but a rerun skips this package by its tag.
      if (createGitTags) console.log(`New tag: ${tag}`);
    }
  } catch (error) {
    await writeSummary([
      '',
      `Staging stopped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
    ]);
    throw error;
  }

  if (staged === 0) {
    console.log('No unstaged package versions were found.');
    await writeSummary(['No package versions needed staging.']);
    return;
  }
  await writeSummary([
    '',
    'A maintainer must approve every staged package on npm with 2FA before it is installable.'
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
