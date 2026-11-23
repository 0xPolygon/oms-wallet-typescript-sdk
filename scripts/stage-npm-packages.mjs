// Stages the tarballs a release run's verify job packed and checked, after checking each file
// against the manifest. Nothing is installed, built or packed here.
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { requiredEnvironment, run, runChecked, verifyArtifact } from './release-common.mjs';

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

/** The kind of artifact a run stages: a stable release creates git tags, a snapshot does not. */
export function expectedArtifactMode(createGitTags) {
  return createGitTags ? 'stable' : 'snapshot';
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

async function writeSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const dryRun = process.env.NPM_STAGE_DRY_RUN === 'true';
  if (!dryRun) assertTrustedPublishingEnvironment(process.env);
  const distTag = process.env.NPM_STAGE_TAG || 'latest';
  const createGitTags = process.env.NPM_STAGE_CREATE_GIT_TAGS !== 'false';
  const directory = requiredEnvironment('NPM_STAGE_ARTIFACT_DIR');

  const manifest = await verifyArtifact(directory);
  assert.equal(
    manifest.mode,
    expectedArtifactMode(createGitTags),
    'The release artifact was packed for another kind of run.'
  );
  const commit = runChecked('git', ['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(manifest.commit, commit, 'The release artifact was packed from another commit.');

  // One package at a time, in release order: each is looked up and staged before the next is
  // looked at, so a later package's failure never prevents an earlier package's stage. The job
  // summary records each package as it is staged, so a later failure cannot hide it.
  await writeSummary([`### npm staged publishing${dryRun ? ' (dry run)' : ''}`, '']);
  let staged = 0;
  try {
    for (const entry of manifest.packages) {
      const tag = `${entry.name}@${entry.version}`;
      if (createGitTags && hasGitTag(tag)) {
        console.log(`${tag} is already tagged; skipping.`);
        continue;
      }
      if (isPublished(entry)) {
        console.log(`${tag} is already published; skipping.`);
        continue;
      }
      if (dryRun) {
        console.log(`Dry run: would stage ${tag} (${entry.integrity}) under ${distTag}.`);
        await writeSummary([`- \`${tag}\` would be staged under \`${distTag}\`.`]);
        staged += 1;
        continue;
      }
      runChecked(
        'npm',
        [
          'stage',
          'publish',
          path.join(directory, entry.file),
          '--tag',
          distTag,
          '--access',
          'public',
          '--provenance'
        ],
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
  if (!dryRun) {
    await writeSummary([
      '',
      'A maintainer must approve every staged package on npm with 2FA before it is installable.'
    ]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
