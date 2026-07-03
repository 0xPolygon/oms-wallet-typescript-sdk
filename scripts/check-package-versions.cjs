const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const rootDir = join(__dirname, '..')
const rootPackage = readPackage('package.json')
const packagePaths = [
  'packages/oms-wallet-wagmi-connector/package.json',
]
const browserExamplePackagePaths = [
  'examples/react/package.json',
  'examples/trails-actions/package.json',
  'examples/wagmi/package.json',
]
const exactWorkspaceProtocol = 'workspace:*'
const exactPackageVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const exactStableSemverPattern = /^\d+\.\d+\.\d+$/
const requireStablePackageVersions = process.argv.includes('--stable')

let hasMismatch = false

for (const packagePath of packagePaths) {
  const packageJson = readPackage(packagePath)

  checkPackageVersion(packageJson.name, packageJson.version)

  if (packageJson.version !== rootPackage.version) {
    report(`${packageJson.name} version ${packageJson.version} does not match ${rootPackage.name} version ${rootPackage.version}.`)
  }

  checkRequiredWorkspaceReference(packageJson.name, 'peer dependency', packageJson.peerDependencies?.[rootPackage.name])
  checkRequiredWorkspaceReference(packageJson.name, 'dev dependency', packageJson.devDependencies?.[rootPackage.name])
}

for (const packagePath of browserExamplePackagePaths) {
  checkReactRuntimeVersions(packagePath, readPackage(packagePath))
}

checkPackageVersion(rootPackage.name, rootPackage.version)

if (hasMismatch) {
  process.exitCode = 1
} else {
  const packageVersionKind = requireStablePackageVersions ? 'stable package versions' : 'package versions'
  console.log(`Publishable ${packageVersionKind} match ${rootPackage.version}; SDK workspace references use ${exactWorkspaceProtocol}; browser examples pin matching React runtimes.`)
}

function readPackage(packagePath) {
  return JSON.parse(readFileSync(join(rootDir, packagePath), 'utf8'))
}

function report(message) {
  hasMismatch = true
  console.error(message)
}

function checkWorkspaceReference(packageName, dependencyType, version) {
  if (version !== undefined && version !== exactWorkspaceProtocol) {
    report(`${packageName} ${dependencyType} ${rootPackage.name}@${version} must use ${exactWorkspaceProtocol}; pnpm publish rewrites it to ${rootPackage.version}.`)
  }
}

function checkPackageVersion(packageName, version) {
  const pattern = requireStablePackageVersions ? exactStableSemverPattern : exactPackageVersionPattern
  const versionKind = requireStablePackageVersions ? 'exact stable semver version' : 'exact semver or prerelease semver version'

  if (!pattern.test(version)) {
    report(`${packageName} version ${version} must be an ${versionKind}.`)
  }
}

function checkRequiredWorkspaceReference(packageName, dependencyType, version) {
  if (version === undefined) {
    report(`${packageName} must declare ${rootPackage.name} as a ${dependencyType}.`)
    return
  }

  checkWorkspaceReference(packageName, dependencyType, version)
}

function checkReactRuntimeVersions(packagePath, packageJson) {
  const reactVersion = packageJson.dependencies?.react
  const reactDomVersion = packageJson.dependencies?.['react-dom']

  if (!exactStableSemverPattern.test(reactVersion)) {
    report(`${packagePath} must pin react to an exact semver version; found ${reactVersion}.`)
  }

  if (reactDomVersion !== reactVersion) {
    report(`${packagePath} must pin react-dom to the same exact version as react; found react ${reactVersion} and react-dom ${reactDomVersion}.`)
  }
}
