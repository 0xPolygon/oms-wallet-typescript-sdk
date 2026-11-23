import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function validateReleasePackage(packageManifest) {
  assert.notEqual(packageManifest.private, true, 'The release package must not be private.');
  assert(
    typeof packageManifest.name === 'string' && packageManifest.name.length > 0,
    'The release package must have a name.'
  );
  assert(
    typeof packageManifest.version === 'string' && packageManifest.version.length > 0,
    'The release package must have a version.'
  );
  return packageManifest;
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

// The repository is a single package, so changesets/action tags releases `v<version>`.
export function releaseTagName({ version }) {
  return `v${version}`;
}

// npm only attests provenance for public source repositories; the workflow enables it from
// the repository's visibility.
export function stagePublishArguments(tarballPath, distTag, provenance) {
  return [
    'stage',
    'publish',
    tarballPath,
    '--tag',
    distTag,
    '--access',
    'public',
    ...(provenance ? ['--provenance'] : [])
  ];
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
  // The release script builds first; packing runs no lifecycle scripts.
  runChecked('pnpm', ['pack', '--out', tarballPath, '--config.ignore-scripts=true'], {
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
  const createGitTag = process.env.NPM_STAGE_CREATE_GIT_TAGS !== 'false';
  const releasePackage = validateReleasePackage(
    JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'))
  );
  const gitTag = releaseTagName(releasePackage);

  if ((createGitTag && hasGitTag(gitTag)) || isPublished(releasePackage)) {
    console.log('No unstaged package version was found.');
    await writeSummary(['### npm staged publishing', '', 'No package version needed staging.']);
    return;
  }

  // The verification job has already run the release gates on this commit.
  runChecked('pnpm', ['run', 'build'], { stdio: 'inherit' });
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'oms-server-wallet-sdk-npm-stage-'));
  const tarballPath = await packPackage(releasePackage, outputDirectory);
  const provenance = process.env.NPM_STAGE_PROVENANCE === 'true';
  runChecked('npm', stagePublishArguments(tarballPath, distTag, provenance), {
    stdio: 'inherit'
  });

  // changesets/action creates the package tag and GitHub Release from this line.
  if (createGitTag) {
    console.log(`New tag: ${gitTag}`);
  }

  await writeSummary([
    '### npm staged publishing',
    '',
    `- \`${releasePackage.name}@${releasePackage.version}\` is staged under \`${distTag}\`${provenance ? ' with provenance' : ' without provenance (private source repository)'}.`,
    '',
    'A maintainer must approve the staged package on npm with 2FA before it is installable.'
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
