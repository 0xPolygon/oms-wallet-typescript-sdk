const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');

const projectRoot = path.resolve(__dirname, '..');
const declarationRoots = [
  path.join(projectRoot, 'dist', 'index.d.ts'),
  path.join(projectRoot, 'dist', 'esm', 'index.d.ts')
];
const generatedModulePattern = /(^|\/)generated(?:\/|$)|waas\.gen(?:\.js)?$/;
const visited = new Set();
const leaks = [];
const publicApiBaseline = path.join(projectRoot, 'scripts', 'public-api-baseline.txt');

for (const declarationRoot of declarationRoots) {
  if (!fs.existsSync(declarationRoot)) {
    throw new Error(
      `Missing built declaration entrypoint: ${path.relative(projectRoot, declarationRoot)}`
    );
  }
  visitDeclaration(declarationRoot);
}

if (leaks.length > 0) {
  process.stderr.write('Generated WaaS declarations leaked into the packaged public API:\n');
  for (const leak of leaks.sort()) {
    process.stderr.write(`- ${leak}\n`);
  }
  process.exitCode = 1;
} else {
  checkPublicApiBaseline();
  process.stdout.write(
    `Public API declaration check passed (${visited.size} declaration files).\n`
  );
}

function checkPublicApiBaseline() {
  const esmRoot = path.dirname(declarationRoots[1]);
  const actual =
    [...visited]
      .filter((filePath) => filePath === esmRoot || filePath.startsWith(`${esmRoot}${path.sep}`))
      .sort((left, right) => left.localeCompare(right))
      .map((filePath) => {
        const relativePath = path.relative(esmRoot, filePath).replaceAll(path.sep, '/');
        return `## ${relativePath}\n${fs.readFileSync(filePath, 'utf8').trimEnd()}`;
      })
      .join('\n\n') + '\n';

  if (process.env.UPDATE_PUBLIC_API_BASELINE === '1') {
    fs.writeFileSync(publicApiBaseline, actual);
    return;
  }
  if (!fs.existsSync(publicApiBaseline)) {
    throw new Error(
      'Missing scripts/public-api-baseline.txt. Regenerate with UPDATE_PUBLIC_API_BASELINE=1 pnpm check:public-api.'
    );
  }
  if (fs.readFileSync(publicApiBaseline, 'utf8') === actual) return;

  const actualPath = path.join(projectRoot, 'scripts', 'public-api-baseline.actual.txt');
  fs.writeFileSync(actualPath, actual);
  spawnSync('diff', ['-u', publicApiBaseline, actualPath], { stdio: 'inherit' });
  fs.rmSync(actualPath);
  throw new Error(
    'Packaged public API differs from scripts/public-api-baseline.txt. Review it, then regenerate intentionally with UPDATE_PUBLIC_API_BASELINE=1 pnpm check:public-api.'
  );
}

function visitDeclaration(filePath) {
  const normalizedPath = path.normalize(filePath);
  if (visited.has(normalizedPath)) return;
  visited.add(normalizedPath);

  const sourceText = fs.readFileSync(normalizedPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    normalizedPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  walk(sourceFile, sourceFile);
}

function walk(node, sourceFile) {
  const moduleSpecifier = moduleSpecifierFromNode(node);
  if (moduleSpecifier) {
    inspectModuleSpecifier(sourceFile.fileName, moduleSpecifier);
  }
  ts.forEachChild(node, (child) => walk(child, sourceFile));
}

function moduleSpecifierFromNode(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }

  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteral(node.argument.literal)
  ) {
    return node.argument.literal.text;
  }

  return undefined;
}

function inspectModuleSpecifier(importer, moduleSpecifier) {
  const normalizedSpecifier = moduleSpecifier.replaceAll('\\', '/');
  if (generatedModulePattern.test(normalizedSpecifier)) {
    leaks.push(`${path.relative(projectRoot, importer)} -> ${moduleSpecifier}`);
  }

  if (!moduleSpecifier.startsWith('.')) return;
  const declarationPath = resolveDeclaration(importer, moduleSpecifier);
  if (declarationPath) visitDeclaration(declarationPath);
}

function resolveDeclaration(importer, moduleSpecifier) {
  const importPath = path.resolve(path.dirname(importer), moduleSpecifier);
  const candidates = moduleSpecifier.endsWith('.js')
    ? [`${importPath.slice(0, -3)}.d.ts`]
    : [`${importPath}.d.ts`, path.join(importPath, 'index.d.ts')];

  return candidates.find((candidate) => fs.existsSync(candidate));
}
