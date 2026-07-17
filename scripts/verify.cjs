const { mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

// Workspace-level verification gate run in CI (tests.yml) and locally.
//
// Package versioning is owned by changesets (the `fixed` group in
// .changeset/config.json keeps the SDK and connector on the same version,
// and pnpm rewrites the connector's workspace: peer/dev ranges at publish).
// This script therefore no longer asserts version equality or the
// workspace-protocol shape — it verifies that the workspace typechecks,
// tests pass, the publishable artifacts pack cleanly with no leaked
// workspace: dependency, and every example builds.

const rootDir = join(__dirname, '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const sdkPackage = '@polygonlabs/oms-wallet';
const connectorPackage = '@polygonlabs/oms-wallet-wagmi-connector';

process.chdir(rootDir);

run('Typecheck SDK', ['--filter', sdkPackage, 'typecheck']);
run('Typecheck wagmi connector', ['--filter', connectorPackage, 'typecheck']);
run('Test SDK', ['--filter', sdkPackage, 'test']);
verifyPackages();
run('Check generated API reference', ['--filter', sdkPackage, 'check:api:built']);
run('Test wagmi connector', ['--filter', connectorPackage, 'test']);
run('Build Node example', ['--filter', 'node-example', 'build']);
run('Build Node contract deployment example', [
  '--filter',
  'node-contract-deploy-example',
  'build'
]);
run('Build React example', ['--filter', 'react-example', 'build']);
run('Build custom Google redirect example', [
  '--filter',
  'custom-google-redirect-example',
  'build'
]);
run('Build Auth0 ID-token example', [
  '--filter',
  'custom-auth0-id-token-example',
  'build'
]);
run('Build Trails Actions example', ['--filter', 'trails-actions-example', 'build']);
run('Build wagmi example', ['--filter', 'wagmi-example', 'build']);

console.log('\nVerified TypeScript SDK packages and examples.');

function run(label, args, env = process.env, quiet = false) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(pnpm, args, {
    cwd: rootDir,
    env,
    encoding: quiet ? 'utf8' : undefined,
    stdio: quiet ? 'pipe' : 'inherit'
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (quiet) {
      process.stderr.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
    }
    throw new Error(`${label} failed with exit code ${result.status ?? 1}.`);
  }
}

function verifyPackages() {
  const packageDir = mkdtempSync(join(tmpdir(), 'oms-wallet-release-'));
  try {
    run(
      'Build and pack SDK release package',
      ['--filter', sdkPackage, 'pack', '--pack-destination', packageDir],
      process.env,
      true
    );
    run(
      'Build and pack wagmi connector release package',
      ['--filter', connectorPackage, 'pack', '--pack-destination', packageDir],
      process.env,
      true
    );

    const archives = readdirSync(packageDir)
      .filter((name) => name.endsWith('.tgz'))
      .map((name) => join(packageDir, name));
    assert(archives.length === 2, `Expected two release archives; found ${archives.length}.`);

    const packages = new Map();
    for (const archive of archives) {
      const manifest = JSON.parse(readArchiveFile(archive, 'package/package.json'));
      const entries = listArchiveEntries(archive);
      assert(
        !JSON.stringify(manifest).includes('workspace:'),
        `${manifest.name} still contains a workspace: dependency.`
      );
      packages.set(manifest.name, { manifest, entries });
    }

    const sdk = requiredPackage(packages, sdkPackage);
    requireEntries(sdk.entries, sdk.manifest.name, [
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/dist/esm/index.js',
      'package/dist/esm/index.d.ts',
      'package/API.md',
      'package/README.md',
      'package/LICENSE'
    ]);

    const connector = requiredPackage(packages, connectorPackage);
    requireEntries(connector.entries, connector.manifest.name, [
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/README.md',
      'package/LICENSE'
    ]);
  } finally {
    rmSync(packageDir, { recursive: true, force: true });
  }
}

function readArchiveFile(archive, path) {
  const result = spawnSync('tar', ['-xOf', archive, path], { encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Unable to read ${path} from ${archive}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function listArchiveEntries(archive) {
  const result = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Unable to inspect ${archive}: ${result.stderr.trim()}`);
  }
  return new Set(result.stdout.split('\n').filter(Boolean));
}

function requiredPackage(packages, name) {
  const packageEntry = packages.get(name);
  assert(packageEntry, `Release archive for ${name} is missing.`);
  return packageEntry;
}

function requireEntries(entries, packageName, requiredEntries) {
  for (const entry of requiredEntries) {
    assert(entries.has(entry), `${packageName} archive is missing ${entry}.`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
