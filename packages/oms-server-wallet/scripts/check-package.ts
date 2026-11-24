import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Packaging + an isolated consumer only. This script has no publication/deployment command.
const output = resolve('.data/package');
mkdirSync(output, { recursive: true });

function packedArchive(): {
  filename: string;
  name: string;
  version: string;
  files: { path: string }[];
} {
  const given = process.env.PACKAGE_TARBALL;
  if (given) {
    const filename = resolve(given);
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOzf', filename, 'package/package.json'], { encoding: 'utf8' })
    ) as { name: string; version: string };
    const files = execFileSync('tar', ['-tzf', filename], { encoding: 'utf8' })
      .split('\n')
      .filter((entry) => entry && !entry.endsWith('/'))
      .map((entry) => ({ path: entry.replace(/^package\//, '') }));
    return { filename, name: manifest.name, version: manifest.version, files };
  }
  execFileSync('pnpm', ['build'], { stdio: 'inherit' });
  const packed = execFileSync(
    'pnpm',
    ['pack', '--pack-destination', output, '--json', '--config.ignore-scripts=true'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  );
  return JSON.parse(packed) as {
    filename: string;
    name: string;
    version: string;
    files: { path: string }[];
  };
}

/** Walk static ESM imports from `entryFile` inside the installed package and fail on forbidden targets. */
function verifyRootRuntimeGraph(pkgRoot: string) {
  const visited = new Set<string>();
  const queue = [join(pkgRoot, 'dist/index.js')];
  const importRegex = /(?:from|import)\s*['"]([^'"]+)['"]/g;
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const content = readFileSync(current, 'utf8');
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      const specifier = match[1];
      if (specifier.includes('wallet-primitives') || specifier.includes('/trails/'))
        throw new Error(
          `Root runtime graph imported forbidden dependency "${specifier}" from ${current}`
        );
      if (specifier.startsWith('.')) {
        const next = resolve(dirname(current), specifier);
        if (next.includes(`${join(pkgRoot, 'dist/trails')}`))
          throw new Error(`Root runtime graph reached Trails module ${next} from ${current}`);
        queue.push(next);
      }
    }
  }
}

const pack = packedArchive();
const integrity = `sha512-${createHash('sha512').update(readFileSync(pack.filename)).digest('base64')}`;
if (
  pack.files.some(
    (f) =>
      !/^dist\//.test(f.path) &&
      ![
        'package.json',
        'README.md',
        'API.md',
        'TRAILS-API.md',
        'CHANGELOG.md',
        'NOTICE',
        'LICENSE-APACHE-2.0'
      ].includes(f.path)
  )
)
  throw new Error('Unexpected file in release archive');

const directory = mkdtempSync(join(tmpdir(), 'oms-sdk-consumer-'));
writeFileSync(
  join(directory, 'package.json'),
  JSON.stringify({
    private: true,
    type: 'module',
    dependencies: {
      '@polygonlabs/oms-server-wallet-sdk': `file:${pack.filename}`,
      typescript: '5.9.3'
    }
  })
);
execFileSync('pnpm', ['--dir', directory, 'install', '--ignore-scripts'], { stdio: 'inherit' });

const installedPkgDir = join(directory, 'node_modules/@polygonlabs/oms-server-wallet-sdk');
verifyRootRuntimeGraph(installedPkgDir);

writeFileSync(
  join(directory, 'consumer.ts'),
  `import {
  createServerWallet,
  createServerWalletService,
  createSingleProcessExecutor,
  createSingleProcessExecutorPool,
  describeOperation,
  isUpstreamError,
  isWalletError,
  parseAmount,
  type NamespacedStateStore,
  type StateStore
} from '@polygonlabs/oms-server-wallet-sdk';
import {
  trails,
  TrailsError,
  type NamespacedSwapStore,
  type SwapStore
} from '@polygonlabs/oms-server-wallet-sdk/trails';

const state: StateStore = { read: async () => null, write: async () => {} };
const nsState: NamespacedStateStore = { read: async () => null, write: async () => {} };
const swapStore: SwapStore = {
  get: async () => null,
  findIntent: async () => null,
  save: async () => {},
  list: async () => []
};
const nsSwapStore: NamespacedSwapStore = {
  get: async () => null,
  findIntent: async () => null,
  save: async () => {},
  list: async () => []
};

const key = 'pk_live_consumer_secret';
const encryptionKey = btoa('k'.repeat(32));
const oidc = {
  issuer: 'https://issuer.example',
  audience: 'test',
  subject: 'consumer-1',
  getIdToken: async () => ({ token: 'test', expiresAt: 1 })
};
const walletSwaps = trails({
  apiKey: 'fixture',
  chains: { 137: 'https://rpc.example' },
  assets: [],
  store: { scope: 'wallet', adapter: swapStore },
  environment: 'consumer'
});
const serviceSwaps = trails({
  apiKey: 'fixture',
  chains: { 137: 'https://rpc.example' },
  assets: [],
  store: { scope: 'service', adapter: nsSwapStore },
  environment: 'consumer'
});

// 1. Two-phase without swaps: neither send* nor swaps exist
const wTwoPhase = createServerWallet({
  publishableKey: key,
  oidc,
  store: { adapter: state, encryptionKey },
  executor: createSingleProcessExecutor()
});
// @ts-expect-error two-phase mode omits sendTransfer
void wTwoPhase.evm.sendTransfer;
// @ts-expect-error swaps omitted when trails(...) not passed
void wTwoPhase.swaps;

// 2. Two-phase WITH swaps: swaps exists, send* STILL omitted
const wTwoPhaseSwaps = createServerWallet({
  publishableKey: key,
  oidc,
  store: { adapter: state, encryptionKey },
  executor: createSingleProcessExecutor(),
  swaps: walletSwaps
});
void wTwoPhaseSwaps.swaps.list;
// @ts-expect-error enabling swaps must not enable immediate send
void wTwoPhaseSwaps.evm.sendTransfer;

// 3. Immediate without swaps: send* exists, swaps STILL omitted
const wImmediate = createServerWallet({
  publishableKey: key,
  oidc,
  store: { adapter: state, encryptionKey },
  executor: createSingleProcessExecutor(),
  approval: 'allow-immediate'
});
void wImmediate.evm.sendTransfer;
// @ts-expect-error swaps omitted when trails(...) not passed
void wImmediate.swaps;

// 4. Immediate WITH swaps: both exist (via service)
const svcImmediateSwaps = createServerWalletService({
  publishableKey: key,
  oidc: { issuer: oidc.issuer, audience: oidc.audience, getIdToken: oidc.getIdToken },
  storage: { adapter: nsState, encryptionKey },
  executor: createSingleProcessExecutorPool(),
  approval: 'allow-immediate',
  swaps: serviceSwaps
});
const wSvc = svcImmediateSwaps.forSubject('alice');
void wSvc.evm.sendTransfer;
void wSvc.swaps.list;

// Scope mismatch is a compile-time error:
// @ts-expect-error service-scoped trails cannot be passed to createServerWallet
createServerWallet({ publishableKey: key, oidc, store: { adapter: state, encryptionKey }, executor: createSingleProcessExecutor(), swaps: serviceSwaps });
// @ts-expect-error wallet-scoped trails cannot be passed to createServerWalletService
createServerWalletService({ publishableKey: key, oidc: { issuer: oidc.issuer, audience: oidc.audience, getIdToken: oidc.getIdToken }, storage: { adapter: nsState, encryptionKey }, executor: createSingleProcessExecutorPool(), swaps: walletSwaps });

// Typed ABI checks on prepareCall / sendCall:
const erc20 = [{ type: 'function', name: 'transfer', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }] as const;
const pay = () => wImmediate.evm.sendCall({
  idempotencyKey: 'consumer-payment',
  chainId: 137,
  to: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  abi: erc20,
  functionName: 'transfer',
  args: ['0x2222222222222222222222222222222222222222', 1n]
});
// @ts-expect-error misspelled function name
const misspelled = () => wImmediate.evm.sendCall({ idempotencyKey: 'consumer-typo', chainId: 137, to: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', abi: erc20, functionName: 'tranfser', args: ['0x2222222222222222222222222222222222222222', 1n] });
// @ts-expect-error wrong arg types
const wrongArgs = () => wTwoPhase.evm.prepareCall({ idempotencyKey: 'consumer-args', chainId: 137, to: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', abi: erc20, functionName: 'transfer', args: [123, 'abc'] });
// @ts-expect-error selector instead of function name
const selector = () => wTwoPhase.evm.prepareCall({ idempotencyKey: 'consumer-hex', chainId: 137, to: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', abi: erc20, functionName: '0x123', args: ['0x2222222222222222222222222222222222222222', 1n] });
void pay; void misspelled; void wrongArgs; void selector;
void parseAmount; void describeOperation; void isWalletError; void isUpstreamError; void TrailsError;
`
);

writeFileSync(
  join(directory, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022', 'DOM'],
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      outDir: 'dist'
    },
    include: ['consumer.ts']
  })
);

writeFileSync(
  join(directory, 'smoke.mjs'),
  `import assert from 'node:assert/strict';
import {
  createServerWallet,
  createServerWalletService,
  createSingleProcessExecutor,
  createSingleProcessExecutorPool,
  describeOperation,
  isWalletError,
  parseAmount
} from '@polygonlabs/oms-server-wallet-sdk';
import { trails, TrailsError } from '@polygonlabs/oms-server-wallet-sdk/trails';

assert.equal(parseAmount('1.25', 6), '1250000');
const mem = () => {
  const m = new Map();
  return { read: async (k) => m.get(k) ?? null, write: async (k, v) => { m.set(k, v); } };
};
const swapMem = () => {
  const m = new Map();
  return {
    get: async (id) => m.get(id) ?? null,
    findIntent: async (intentId) => [...m.values()].find((e) => e.intentId === intentId)?.id ?? null,
    save: async (entry) => { m.set(entry.id, entry); },
    list: async () => [...m.values()]
  };
};
const key = 'pk_live_smoke_secret';
const encryptionKey = btoa('k'.repeat(32));
const swaps = trails({
  apiKey: 'trails-key',
  chains: { 137: 'https://rpc.example' },
  assets: [],
  store: { scope: 'wallet', adapter: swapMem() },
  environment: 'smoke'
});
const wallet = createServerWallet({
  publishableKey: key,
  oidc: { issuer: 'https://issuer.example', audience: 'oms', subject: 'smoke-1', getIdToken: async () => ({ token: 't', expiresAt: 1 }) },
  store: { adapter: mem(), encryptionKey },
  executor: createSingleProcessExecutor(),
  swaps
});
assert.equal('sendTransfer' in wallet.evm, false);
assert.equal(typeof wallet.swaps.list, 'function');
assert.deepEqual((await wallet.swaps.list()).items, []);
// Forged/cloned handle fails closed
assert.throws(
  () => createServerWallet({
    publishableKey: key,
    oidc: { issuer: 'https://issuer.example', audience: 'oms', subject: 'smoke-2', getIdToken: async () => ({ token: 't', expiresAt: 1 }) },
    store: { adapter: mem(), encryptionKey },
    executor: createSingleProcessExecutor(),
    swaps: { ...swaps }
  }),
  (err) => isWalletError(err) && err.code === 'CONFIGURATION'
);
assert.equal(typeof describeOperation, 'function');
assert.equal(typeof createServerWalletService, 'function');
assert.equal(typeof createSingleProcessExecutorPool, 'function');
assert.equal(typeof TrailsError, 'function');
console.log('Clean artifact ESM, 4-way type matrix, zero-Trails root graph, and trails binding passed.');
`
);

execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json'], {
  cwd: directory,
  stdio: 'inherit'
});
execFileSync(process.execPath, ['smoke.mjs'], { cwd: directory, stdio: 'inherit' });

const report = {
  name: pack.name,
  version: pack.version,
  integrity,
  archive: pack.filename,
  files: pack.files.length,
  consumer: directory,
  verifiedAt: new Date().toISOString()
};
const installed = JSON.parse(readFileSync(join(installedPkgDir, 'package.json'), 'utf8')) as {
  version: string;
};
if (installed.version !== pack.version) throw new Error('Consumer resolved the wrong package');
writeFileSync(join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
