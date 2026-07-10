const {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const rootDir = join(__dirname, '..')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const stable = process.argv.includes('--stable')
const releaseEnv = {
  ...process.env,
  VITE_OMS_PUBLISHABLE_KEY: process.env.VITE_OMS_PUBLISHABLE_KEY || 'pk_ci_sdbx_ciproject_cikey',
  VITE_GOOGLE_CLIENT_ID: process.env.VITE_GOOGLE_CLIENT_ID || 'ci-google-client-id',
  VITE_TRAILS_API_KEY: process.env.VITE_TRAILS_API_KEY || 'ci-trails-key',
}

process.chdir(rootDir)

run(
  stable ? 'Check stable package versions' : 'Check package versions',
  [stable ? 'check:stable-package-versions' : 'check:package-versions'],
)
run('Typecheck SDK', ['exec', 'tsc', '--noEmit'])
run('Test SDK', ['test'])
verifyPackages()
run('Test wagmi connector', ['--filter', '@polygonlabs/oms-wallet-wagmi-connector', 'test'])
run('Build Node example', ['--filter', 'node-example', 'build'])
run('Build Node contract deployment example', ['--filter', 'node-contract-deploy-example', 'build'])
run('Build React example', ['--filter', 'react-example', 'build'], releaseEnv)
run('Build custom Google redirect example', ['--filter', 'custom-google-redirect-example', 'build'], releaseEnv)
run('Build Trails Actions example', ['--filter', 'trails-actions-example', 'build'], releaseEnv)
run('Build wagmi example', ['--filter', 'wagmi-example', 'build'], releaseEnv)

console.log('\nVerified TypeScript SDK packages and examples.')

function run(label, args, env = process.env, quiet = false) {
  console.log(`\n==> ${label}`)
  const result = spawnSync(pnpm, args, {
    cwd: rootDir,
    env,
    encoding: quiet ? 'utf8' : undefined,
    stdio: quiet ? 'pipe' : 'inherit',
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    if (quiet) {
      process.stderr.write(result.stdout || '')
      process.stderr.write(result.stderr || '')
    }
    throw new Error(`${label} failed with exit code ${result.status ?? 1}.`)
  }
}

function verifyPackages() {
  const packageDir = mkdtempSync(join(tmpdir(), 'oms-wallet-release-'))
  try {
    run('Build and pack release packages', [
      '--filter',
      '@polygonlabs/oms-wallet',
      '--filter',
      '@polygonlabs/oms-wallet-wagmi-connector',
      'pack',
      '--pack-destination',
      packageDir,
    ], process.env, true)

    const archives = readdirSync(packageDir)
      .filter((name) => name.endsWith('.tgz'))
      .map((name) => join(packageDir, name))
    assert(archives.length === 2, `Expected two release archives; found ${archives.length}.`)

    const packages = new Map()
    for (const archive of archives) {
      const manifest = JSON.parse(readArchiveFile(archive, 'package/package.json'))
      const entries = listArchiveEntries(archive)
      assert(!JSON.stringify(manifest).includes('workspace:'), `${manifest.name} still contains a workspace: dependency.`)
      assert(manifest.version === readRootVersion(), `${manifest.name} has packed version ${manifest.version}.`)
      packages.set(manifest.name, { manifest, entries })
    }

    const sdk = requiredPackage(packages, '@polygonlabs/oms-wallet')
    requireEntries(sdk.entries, sdk.manifest.name, [
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/dist/esm/index.js',
      'package/dist/esm/index.d.ts',
      'package/API.md',
      'package/README.md',
      'package/LICENSE',
    ])

    const connector = requiredPackage(packages, '@polygonlabs/oms-wallet-wagmi-connector')
    requireEntries(connector.entries, connector.manifest.name, [
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/README.md',
      'package/LICENSE',
    ])
    const version = readRootVersion()
    assert(
      connector.manifest.peerDependencies?.['@polygonlabs/oms-wallet'] === `^${version}`,
      `Packed connector peer dependency must be @polygonlabs/oms-wallet@^${version}.`,
    )
    assert(
      connector.manifest.devDependencies?.['@polygonlabs/oms-wallet'] === version,
      `Packed connector dev dependency must be @polygonlabs/oms-wallet@${version}.`,
    )
  } finally {
    rmSync(packageDir, { recursive: true, force: true })
  }
}

function readRootVersion() {
  return JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version
}

function readArchiveFile(archive, path) {
  const result = spawnSync('tar', ['-xOf', archive, path], { encoding: 'utf8' })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`Unable to read ${path} from ${archive}: ${result.stderr.trim()}`)
  }
  return result.stdout
}

function listArchiveEntries(archive) {
  const result = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`Unable to inspect ${archive}: ${result.stderr.trim()}`)
  }
  return new Set(result.stdout.split('\n').filter(Boolean))
}

function requiredPackage(packages, name) {
  const packageEntry = packages.get(name)
  assert(packageEntry, `Release archive for ${name} is missing.`)
  return packageEntry
}

function requireEntries(entries, packageName, requiredEntries) {
  for (const entry of requiredEntries) {
    assert(entries.has(entry), `${packageName} archive is missing ${entry}.`)
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}
