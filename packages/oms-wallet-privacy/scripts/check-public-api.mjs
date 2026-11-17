// Fails when the public declarations name the privacy provider or its libraries, or import any
// module other than the OMS Wallet SDK and viem. Walks the .d.ts files reachable from
// dist/index.d.ts; internal declarations that the public types never reference are not checked.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist/index.d.ts');
const allowedPackages = new Set(['@polygonlabs/oms-wallet', 'viem']);
const forbidden = /hinkal|ethers/i;

if (!existsSync(entry)) {
  console.error('dist/index.d.ts is missing; run the build first.');
  process.exit(1);
}

const problems = [];
const seen = new Set();
const queue = [entry];
while (queue.length > 0) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  const name = relative(root, file);
  text.split('\n').forEach((line, index) => {
    if (forbidden.test(line)) problems.push(`${name}:${index + 1}: ${line.trim()}`);
  });
  const specifiers = [
    ...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm),
    ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)
  ].map((match) => match[1]);
  for (const specifier of specifiers) {
    if (specifier.startsWith('.')) {
      queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.d.ts')));
    } else if (!allowedPackages.has(specifier)) {
      problems.push(`${name}: imports ${specifier}`);
    }
  }
}

if (problems.length > 0) {
  console.error('The public declarations expose internals:\n' + problems.join('\n'));
  process.exit(1);
}
console.log(`Public declarations are clean (${seen.size} files).`);
