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
        'LICENSE-APACHE-2.0',
        'docs/ERRORS.md',
        'docs/NODE-INTEGRATION.md',
        'docs/SWAPS-INTEGRATION.md'
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
  type ServerWallet,
  type StateStore,
  type TypedDataSigningRequest
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
  save: async () => 'saved' as const,
  list: async () => []
};
const nsSwapStore: NamespacedSwapStore = {
  get: async () => null,
  findIntent: async () => null,
  save: async () => 'saved' as const,
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
  storage: { scope: 'wallet', adapter: swapStore, encryptionKey },
  environment: 'consumer'
});
const serviceSwaps = trails({
  apiKey: 'fixture',
  chains: { 137: 'https://rpc.example' },
  assets: [],
  storage: { scope: 'service', adapter: nsSwapStore, encryptionKey },
  environment: 'consumer'
});

// 1. Two-phase without swaps: neither send* nor swaps exist
const wTwoPhase = createServerWallet({
  publishableKey: key,
  oidc,
  storage: { adapter: state, encryptionKey },
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
  storage: { adapter: state, encryptionKey },
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
  storage: { adapter: state, encryptionKey },
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
createServerWallet({ publishableKey: key, oidc, storage: { adapter: state, encryptionKey }, executor: createSingleProcessExecutor(), swaps: serviceSwaps });
// @ts-expect-error wallet-scoped trails cannot be passed to createServerWalletService
createServerWalletService({ publishableKey: key, oidc: { issuer: oidc.issuer, audience: oidc.audience, getIdToken: oidc.getIdToken }, storage: { adapter: nsState, encryptionKey }, executor: createSingleProcessExecutorPool(), swaps: walletSwaps });

// Callers cannot claim capabilities via options annotations or generic arguments without enabling them:
// @ts-expect-error cannot claim allow-immediate without passing approval: 'allow-immediate'
createServerWallet<'allow-immediate'>({ publishableKey: key, oidc, storage: { adapter: state, encryptionKey }, executor: createSingleProcessExecutor() });
// @ts-expect-error cannot claim swaps facet without passing swaps: trails(...)
createServerWallet<typeof walletSwaps>({ publishableKey: key, oidc, storage: { adapter: state, encryptionKey }, executor: createSingleProcessExecutor() });
// @ts-expect-error cannot claim allow-immediate on service without passing approval: 'allow-immediate'
createServerWalletService<'allow-immediate'>({ publishableKey: key, oidc: { issuer: oidc.issuer, audience: oidc.audience, getIdToken: oidc.getIdToken }, storage: { adapter: nsState, encryptionKey }, executor: createSingleProcessExecutorPool() });
// @ts-expect-error cannot claim swaps facet on service without passing swaps: trails(...)
createServerWalletService<typeof serviceSwaps>({ publishableKey: key, oidc: { issuer: oidc.issuer, audience: oidc.audience, getIdToken: oidc.getIdToken }, storage: { adapter: nsState, encryptionKey }, executor: createSingleProcessExecutorPool() });

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

// Chain IDs and wait outcomes are checked at compile time.
// @ts-expect-error unsupported EVM chain ID
void wTwoPhase.evm.signMessage({ idempotencyKey: 'consumer-chain', chainId: 999999, message: 'hi' });
const waitOutcome = (result: Awaited<ReturnType<typeof wTwoPhase.evm.waitForOperation>>) => {
  // @ts-expect-error 'settled' was split into executed / failed / expired / signed
  if (result.outcome === 'settled') return 'ambiguous';
  return result.outcome === 'executed' ? 'paid' : 'not-paid';
};
void waitOutcome;

// In-memory handles (storage: 'memory'): the same wallet API, no executor, no disable(), and
// not substitutable for a durable ServerWallet.
const mem = createServerWallet({ publishableKey: key, oidc, storage: 'memory' });
void mem.evm.signMessage({ idempotencyKey: 'consumer-mem-sign', chainId: 80002, message: 'hi' });
void mem.evm.prepareTransfer({ idempotencyKey: 'consumer-mem-1', chainId: 80002, to: '0x2222222222222222222222222222222222222222', asset: 'native', amount: '1' });
// @ts-expect-error two-phase in-memory handles have no send*
void mem.evm.sendTransfer;
const memImmediate = createServerWallet({ publishableKey: key, oidc, storage: 'memory', approval: 'allow-immediate', swaps: walletSwaps });
void memImmediate.evm.sendTransfer({ idempotencyKey: 'consumer-mem-2', chainId: 80002, to: '0x2222222222222222222222222222222222222222', asset: 'native', amount: '1', onPrepared: async (op) => void op.quote.txnId });
void memImmediate.swaps.tick;
void memImmediate.evm.waitForTransaction({ txnId: 'txn_1', expiresAt: new Date().toISOString() }, { timeoutMs: 1000 });
const memService = createServerWalletService({ publishableKey: key, oidc: { issuer: oidc.issuer, audience: oidc.audience, getIdToken: oidc.getIdToken }, storage: 'memory', approval: 'allow-immediate', swaps: serviceSwaps, cache: { maxHandles: 100 } });
void memService.forSubject('alice').evm.sendTransfer;
void memService.forSubject('alice').swaps.tick;
// @ts-expect-error the service owns its handles' lifetime
void memService.forSubject('alice').close;
// @ts-expect-error wallet-scoped trails cannot be passed to the in-memory service
createServerWalletService({ publishableKey: key, oidc: { issuer: oidc.issuer, audience: oidc.audience, getIdToken: oidc.getIdToken }, storage: 'memory', swaps: walletSwaps });
// @ts-expect-error an in-memory handle is not a durable ServerWallet
const asDurable: ServerWallet = mem;
// @ts-expect-error in-memory handles have no disable()
void mem.disable;
// @ts-expect-error storage: 'memory' takes no executor
createServerWallet({ publishableKey: key, oidc, storage: 'memory', executor: createSingleProcessExecutor() });
// @ts-expect-error storage is required (no implicit memory default)
createServerWallet({ publishableKey: key, oidc });
// @ts-expect-error storage: 'memory' service takes no executor
createServerWalletService({ publishableKey: key, oidc: { issuer: oidc.issuer, audience: oidc.audience, getIdToken: oidc.getIdToken }, storage: 'memory', executor: createSingleProcessExecutorPool() });
// @ts-expect-error durable service takes no cache
createServerWalletService({ publishableKey: key, oidc: { issuer: oidc.issuer, audience: oidc.audience, getIdToken: oidc.getIdToken }, storage: { adapter: nsState, encryptionKey }, executor: createSingleProcessExecutorPool(), cache: { maxHandles: 10 } });
void asDurable;

// Wallet creation and selection: explicit create() on in-memory handles, wallets option, listWallets.
void mem.create({ families: ['evm', 'tron'] });
void mem.restore({ wallets: { evm: '0x2222222222222222222222222222222222222222' } });
void mem.listWallets();
void wTwoPhase.createOrRestore({ families: ['evm'], wallets: { evm: '0x2222222222222222222222222222222222222222' } });
void wTwoPhase.listWallets();
// @ts-expect-error in-memory handles create with create(), not createOrRestore()
void mem.createOrRestore;
// @ts-expect-error wallet selection is keyed by family
void mem.restore({ wallets: { bitcoin: 'x' } });

// Typed-data signing exists only with a signing policy, on durable, service and in-memory handles.
// @ts-expect-error signTypedData needs signing.authorizeTypedData
void wTwoPhase.evm.signTypedData;
// @ts-expect-error signTypedData needs signing.authorizeTypedData
void wImmediate.tron.signTypedData;
// @ts-expect-error signTypedData needs signing.authorizeTypedData
void mem.evm.signTypedData;
const signing = { authorizeTypedData: (request: TypedDataSigningRequest) => request.family === 'evm' };
const wSigning = createServerWallet({ publishableKey: key, oidc, storage: { adapter: state, encryptionKey }, executor: createSingleProcessExecutor(), signing });
void wSigning.evm.signTypedData;
void wSigning.tron.signTypedData;
// @ts-expect-error signing does not enable immediate send
void wSigning.evm.sendTransfer;
const svcSigning = createServerWalletService({ publishableKey: key, oidc: { issuer: oidc.issuer, audience: oidc.audience, getIdToken: oidc.getIdToken }, storage: { adapter: nsState, encryptionKey }, executor: createSingleProcessExecutorPool(), signing });
void svcSigning.forSubject('alice').evm.signTypedData;
const memSigning = createServerWallet({ publishableKey: key, oidc, storage: 'memory', signing });
void memSigning.tron.signTypedData;
// A wallet with signing still satisfies the plain ServerWallet type.
const plain: ServerWallet = wSigning;
void plain;

// Unknown option keys are compile errors even though the factories infer their options.
// @ts-expect-error misspelled approval
createServerWallet({ publishableKey: key, oidc, storage: { adapter: state, encryptionKey }, executor: createSingleProcessExecutor(), aproval: 'allow-immediate' });
// @ts-expect-error misspelled approval on storage: 'memory'
createServerWallet({ publishableKey: key, oidc, storage: 'memory', aproval: 'allow-immediate' });
// @ts-expect-error store was renamed to storage
createServerWallet({ publishableKey: key, oidc, store: { adapter: state, encryptionKey }, executor: createSingleProcessExecutor() });
// @ts-expect-error server wallets do not take an HTTP origin
createServerWallet({ publishableKey: key, origin: 'https://app.example', oidc, storage: 'memory' });

// Tron transfers and calls mirror EVM: prepareTransfer / prepareCall, with maxQuotedFee.
void wImmediate.tron.sendTransfer({ idempotencyKey: 'consumer-trc20', network: 'tron:nile', to: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', asset: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', amount: '1', maxQuotedFee: '1000000' });
void wTwoPhase.tron.prepareCall({ idempotencyKey: 'consumer-tron-abi', network: 'tron:nile', to: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', method: 'approve', args: [] });
void wTwoPhase.tron.prepareCall({ idempotencyKey: 'consumer-tron-raw', network: 'tron:nile', to: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', data: '0x', value: '1' });
// @ts-expect-error an ABI call takes no calldata
void wTwoPhase.tron.prepareCall({ idempotencyKey: 'consumer-tron-both', network: 'tron:nile', to: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', method: 'approve', data: '0x' });
// @ts-expect-error maxFee was renamed to maxQuotedFee
void wTwoPhase.tron.prepareTransfer({ idempotencyKey: 'consumer-tron-fee', network: 'tron:nile', to: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', asset: 'native', amount: '1', maxFee: '1' });
// @ts-expect-error prepareTransaction was replaced by prepareTransfer and prepareCall
void wTwoPhase.tron.prepareTransaction;
type Snapshot = Awaited<ReturnType<typeof wTwoPhase.inspect>>;
// @ts-expect-error snapshots list wallets by family
type RemovedWallet = Snapshot['wallet'];
export type SnapshotEvm = Snapshot['wallets']['evm'];

// Declaration emit: inferred public types must be nameable from the package entry points (TS4023).
export const declTwoPhase = wTwoPhase;
export const declImmediate = wImmediate;
export const declServiceWallet = wSvc;
export const declService = svcImmediateSwaps;
export const declEvmTwoPhase = wTwoPhase.evm;
export const declEvmImmediate = wImmediate.evm;
export const declSolanaImmediate = wImmediate.solana;
export const declTronTwoPhase = wTwoPhase.tron;
export const declSwapsFacet = wTwoPhaseSwaps.swaps;
export const declWalletSwaps = walletSwaps;
export const declServiceSwaps = serviceSwaps;
export const declInMemory = mem;
export const declInMemoryEvm = mem.evm;
export const declInMemoryImmediate = memImmediate;
export const declInMemoryService = memService;
export const declSigning = wSigning;
export const declSigningService = svcSigning;
export const declInMemorySigning = memSigning;
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
      declaration: true,
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
    save: async (entry, { expectedVersion }) => { if ((m.get(entry.id)?.version ?? 0) !== expectedVersion) return 'conflict'; m.set(entry.id, entry); return 'saved'; },
    list: async () => [...m.values()]
  };
};
const key = 'pk_live_smoke_secret';
const encryptionKey = btoa('k'.repeat(32));
const swaps = trails({
  apiKey: 'trails-key',
  chains: { 137: 'https://rpc.example' },
  assets: [],
  storage: { scope: 'wallet', adapter: swapMem(), encryptionKey },
  environment: 'smoke'
});
const wallet = createServerWallet({
  publishableKey: key,
  oidc: { issuer: 'https://issuer.example', audience: 'oms', subject: 'smoke-1', getIdToken: async () => ({ token: 't', expiresAt: 1 }) },
  storage: { adapter: mem(), encryptionKey },
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
    storage: { adapter: mem(), encryptionKey },
    executor: createSingleProcessExecutor(),
    swaps: { ...swaps }
  }),
  (err) => isWalletError(err) && err.code === 'CONFIGURATION'
);
const inMemory = createServerWallet({
  publishableKey: key,
  oidc: { issuer: 'https://issuer.example', audience: 'oms', subject: 'smoke-3', getIdToken: async () => ({ token: 't', expiresAt: 1 }) },
  storage: 'memory'
});
assert.equal(typeof inMemory.evm.prepareTransfer, 'function');
assert.equal('sendTransfer' in inMemory.evm, false);
assert.equal('disable' in inMemory, false);
await inMemory.close();
await assert.rejects(inMemory.inspect(), (err) => isWalletError(err) && err.code === 'WALLET_CLOSED');
assert.throws(
  () => createServerWallet({
    publishableKey: key,
    oidc: { issuer: 'https://issuer.example', audience: 'oms', subject: 'smoke-4', getIdToken: async () => ({ token: 't', expiresAt: 1 }) },
    storage: 'memory',
    executor: createSingleProcessExecutor()
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
