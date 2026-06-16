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
const exactSemverPattern = /^\d+\.\d+\.\d+$/

let hasMismatch = false

for (const packagePath of packagePaths) {
  const packageJson = readPackage(packagePath)

  if (packageJson.version !== rootPackage.version) {
    report(`${packageJson.name} version ${packageJson.version} does not match ${rootPackage.name} version ${rootPackage.version}.`)
  }

  checkWorkspaceReference(packageJson.name, 'peer dependency', packageJson.peerDependencies?.[rootPackage.name])
  checkWorkspaceReference(packageJson.name, 'dev dependency', packageJson.devDependencies?.[rootPackage.name])
}

for (const packagePath of browserExamplePackagePaths) {
  checkReactRuntimeVersions(packagePath, readPackage(packagePath))
}

if (hasMismatch) {
  process.exitCode = 1
} else {
  console.log(`Publishable package versions match ${rootPackage.version}; SDK workspace references use ${exactWorkspaceProtocol}; browser examples pin matching React runtimes.`)
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

function checkReactRuntimeVersions(packagePath, packageJson) {
  const reactVersion = packageJson.dependencies?.react
  const reactDomVersion = packageJson.dependencies?.['react-dom']

  if (!exactSemverPattern.test(reactVersion)) {
    report(`${packagePath} must pin react to an exact semver version; found ${reactVersion}.`)
  }

  if (reactDomVersion !== reactVersion) {
    report(`${packagePath} must pin react-dom to the same exact version as react; found react ${reactVersion} and react-dom ${reactDomVersion}.`)
  }
}
