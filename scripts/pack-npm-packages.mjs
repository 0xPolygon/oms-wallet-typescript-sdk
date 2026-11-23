// Packs the packages a release run will stage, in a job without npm or GitHub write credentials, and
// writes a manifest with each tarball's SHA-512. The staging job stages exactly these files.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ARTIFACT_MANIFEST,
  assertPackedManifest,
  readPackedManifest,
  repositoryRoot,
  requiredEnvironment,
  runChecked,
  selectSnapshotPackages,
  sha512File,
  tarballName,
  validateReleasePackages
} from './release-common.mjs';

async function main() {
  const mode = requiredEnvironment('NPM_PACK_MODE');
  if (!['stable', 'snapshot'].includes(mode)) throw new Error(`Unknown NPM_PACK_MODE ${mode}.`);
  const outputDirectory = path.resolve(requiredEnvironment('NPM_PACK_DIR'));
  await mkdir(outputDirectory, { recursive: true });

  const workspaces = JSON.parse(
    runChecked('pnpm', ['--recursive', 'list', '--depth', '-1', '--json']).stdout
  );
  const changesetsConfig = JSON.parse(
    await readFile(path.join(repositoryRoot, '.changeset/config.json'), 'utf8')
  );
  const releasePackages = validateReleasePackages(workspaces, changesetsConfig);
  const candidates =
    mode === 'stable'
      ? releasePackages
      : selectSnapshotPackages(
          releasePackages,
          JSON.parse(await readFile(requiredEnvironment('SNAPSHOT_PACKAGES_FILE'), 'utf8'))
        );

  const packages = [];
  for (const releasePackage of candidates) {
    const file = tarballName(releasePackage);
    const tarballPath = path.join(outputDirectory, file);
    runChecked('pnpm', ['--dir', releasePackage.path, 'pack', '--out', tarballPath], {
      stdio: 'inherit'
    });
    assertPackedManifest(readPackedManifest(tarballPath), releasePackage);
    const entry = {
      name: releasePackage.name,
      version: releasePackage.version,
      file,
      integrity: await sha512File(tarballPath)
    };
    packages.push(entry);
    console.log(`Packed ${entry.name}@${entry.version} (${entry.integrity}).`);
  }

  const commit = runChecked('git', ['rev-parse', 'HEAD']).stdout.trim();
  await writeFile(
    path.join(outputDirectory, ARTIFACT_MANIFEST),
    `${JSON.stringify({ mode, commit, packages }, null, 2)}\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
