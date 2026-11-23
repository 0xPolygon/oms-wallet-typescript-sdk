// Copies src/ into each SDK as committed files. `--check` fails instead when a copy differs, so a
// hand edit to a copy, or a protocol change without a sync, cannot pass CI. Both modes fail when the
// source imports a package an SDK does not declare as a dependency.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as prettier from 'prettier';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageRoot, '../..');
const sourceDirectory = path.join(packageRoot, 'src');
const sdks = ['packages/oms-wallet', 'packages/oms-server-wallet'];
const check = process.argv.includes('--check');

function header(file) {
  return `// DO NOT EDIT. Copied from packages/oms-wallet-protocol/src/${file} by\n// \`pnpm --filter oms-wallet-protocol sync\`; edit the source there and run it again.\n\n`;
}

/** Bare package names a source file imports, statically, dynamically or for types. */
function importedPackages(source) {
  const specifiers = [
    ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)
  ].map((match) => match[1]);
  return specifiers
    .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:'))
    .map((specifier) =>
      specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0]
    );
}

const problems = [];

// The copies are flat: one .ts file per module, nothing else.
const expected = new Map();
const imports = new Set();
for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) {
    problems.push(`src/${entry.name}: the protocol source must be flat .ts files only`);
    continue;
  }
  const filepath = path.join(sourceDirectory, entry.name);
  const source = await readFile(filepath, 'utf8');
  for (const name of importedPackages(source)) imports.add(name);
  const options = (await prettier.resolveConfig(filepath)) ?? {};
  expected.set(
    entry.name,
    await prettier.format(header(entry.name) + source, { ...options, filepath })
  );
}

for (const sdk of sdks) {
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, sdk, 'package.json'), 'utf8')
  );
  for (const name of imports) {
    if (!manifest.dependencies?.[name]) {
      problems.push(`${sdk}/package.json does not list ${name}, which the protocol source imports`);
    }
  }
}

for (const sdk of sdks) {
  const target = path.join(repositoryRoot, sdk, 'src/internal/protocol');
  const relativeTarget = path.relative(repositoryRoot, target);
  const existing = await readdir(target).catch(() => []);
  for (const entry of existing) {
    if (expected.has(entry)) continue;
    if (check) problems.push(`${relativeTarget}/${entry} has no source in the protocol package`);
    else await rm(path.join(target, entry), { recursive: true, force: true });
  }
  if (!check) await mkdir(target, { recursive: true });
  for (const [file, content] of expected) {
    const destination = path.join(target, file);
    const current = await readFile(destination, 'utf8').catch(() => null);
    if (current === content) continue;
    if (check) problems.push(`${relativeTarget}/${file} differs from its protocol source`);
    else await writeFile(destination, content);
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(
    'Edit the protocol source, not a copy, run `pnpm --filter oms-wallet-protocol sync`, and declare every package it imports in both SDKs.'
  );
  process.exitCode = 1;
} else {
  console.log(check ? 'Protocol copies match their source.' : 'Protocol copies are up to date.');
}
