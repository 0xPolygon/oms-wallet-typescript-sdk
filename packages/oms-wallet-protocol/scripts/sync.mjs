// Copies src/ into each SDK as committed files. `--check` fails instead when a copy differs, so a
// hand edit to a copy, or a protocol change without a sync, cannot pass CI.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as prettier from 'prettier';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageRoot, '../..');
const sourceDirectory = path.join(packageRoot, 'src');
const targets = ['packages/oms-wallet', 'packages/oms-server-wallet'].map((sdk) =>
  path.join(repositoryRoot, sdk, 'src/internal/protocol')
);
const check = process.argv.includes('--check');

function header(file) {
  return `// DO NOT EDIT. Copied from packages/oms-wallet-protocol/src/${file} by\n// \`pnpm --filter oms-wallet-protocol sync\`; edit the source there and run it again.\n\n`;
}

const sourceFiles = (await readdir(sourceDirectory)).filter((file) => file.endsWith('.ts')).sort();
const expected = new Map();
for (const file of sourceFiles) {
  const source = await readFile(path.join(sourceDirectory, file), 'utf8');
  const filepath = path.join(sourceDirectory, file);
  const options = (await prettier.resolveConfig(filepath)) ?? {};
  expected.set(file, await prettier.format(header(file) + source, { ...options, filepath }));
}

const problems = [];
for (const target of targets) {
  const relativeTarget = path.relative(repositoryRoot, target);
  const existing = await readdir(target).catch(() => []);
  for (const file of existing) {
    if (expected.has(file)) continue;
    if (check) problems.push(`${relativeTarget}/${file} has no source in the protocol package`);
    else await rm(path.join(target, file));
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
    'Run `pnpm --filter oms-wallet-protocol sync`, and edit the protocol source, not a copy.'
  );
  process.exitCode = 1;
} else {
  console.log(check ? 'Protocol copies match their source.' : 'Protocol copies are up to date.');
}
