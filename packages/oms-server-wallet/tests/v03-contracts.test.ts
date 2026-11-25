import { describe, expect, it, vi } from 'vitest';

import {
  EVM_NETWORKS,
  SOLANA_NETWORKS,
  TRON_NETWORKS,
  isSupportedEvmChainId,
  isWalletErrorCode,
  createServerWallet,
  createServerWalletService,
  createSingleProcessExecutor,
  createSingleProcessExecutorPool,
  describeOperation,
  isUpstreamError,
  isWalletError,
  UpstreamError,
  WalletError,
  type NamespacedStateStore,
  type WalletOperation
} from '@polygonlabs/oms-server-wallet-sdk';
import {
  trails,
  type NamespacedSwapStore,
  type StoredSwapEntry
} from '@polygonlabs/oms-server-wallet-sdk/trails';

import { environmentFromKey, resolveAttestationPolicy } from '../src/environment.js';
import { IndexerClient } from '../src/indexer.js';
import { computeIdentityNamespace } from '../src/storage.js';
import { trailsInternal } from '../src/trails/coordinator.js';
import { createServerWalletInternal, createServerWalletServiceInternal } from '../src/wallet.js';
import { quoteFixture, recoveryFixture } from './fixtures/trails.js';
import {
  FakeWaas,
  MemoryStore,
  SOLANA_RECIPIENT,
  TEST_PUBLISHABLE_KEY,
  TRON_RECIPIENT,
  sdkHarness
} from './helpers.js';
import { MemorySwapStore, SWAP_ENCRYPTION_KEY, swapHarness } from './swap-harness.js';

const validPcr0 = 'a'.repeat(96);
const debugPcr0 = '0'.repeat(96);
const encryptionKey = btoa('k'.repeat(32));

class MemoryNamespacedStore implements NamespacedStateStore {
  data = new Map<string, Map<string, string>>();
  async read(ns: string, key: string) {
    return this.data.get(ns)?.get(key) ?? null;
  }
  async write(ns: string, key: string, value: string) {
    let bucket = this.data.get(ns);
    if (!bucket) {
      bucket = new Map();
      this.data.set(ns, bucket);
    }
    bucket.set(key, value);
  }
}

class MemoryNamespacedSwapStore implements NamespacedSwapStore {
  stores = new Map<string, MemorySwapStore>();
  private bucket(ns: string) {
    let store = this.stores.get(ns);
    if (!store) {
      store = new MemorySwapStore();
      this.stores.set(ns, store);
    }
    return store;
  }
  get(ns: string, id: string) {
    return this.bucket(ns).get(id);
  }
  findIntent(ns: string, intentId: string) {
    return this.bucket(ns).findIntent(intentId);
  }
  save(ns: string, entry: StoredSwapEntry) {
    return this.bucket(ns).save(entry);
  }
  list(ns: string, options: { active?: boolean; offset?: number; limit: number }) {
    return this.bucket(ns).list(options);
  }
}

describe('attestation trust policy', () => {
  it('defaults to SDK stage-pinned PCR0s on managed non-debug routes and replaces them when explicit pins are provided', () => {
    const prod = environmentFromKey('pk_live_abc_secret');
    const stg = environmentFromKey('pk_stg_live_abc_secret');
    expect(resolveAttestationPolicy(prod).size).toBeGreaterThan(0);
    expect(resolveAttestationPolicy(stg).size).toBeGreaterThan(0);
    // Explicit pins REPLACE defaults rather than unioning.
    const custom = resolveAttestationPolicy(prod, { trustedPcr0s: [validPcr0] });
    expect([...custom]).toEqual([validPcr0]);
    expect(() => resolveAttestationPolicy(prod, { trustedPcr0s: [] })).toThrow(WalletError);
    expect(() => resolveAttestationPolicy(prod, { trustedPcr0s: ['not-hex'] })).toThrow(
      WalletError
    );
  });

  it('unconditionally rejects debug PCR0 on staging and production (including production sandbox)', () => {
    for (const key of ['pk_live_abc_secret', 'pk_sdbx_abc_secret', 'pk_stg_sdbx_abc_secret']) {
      const env = environmentFromKey(key);
      expect(() =>
        resolveAttestationPolicy(env, { trustedPcr0s: [debugPcr0], allowDebugEnclave: true })
      ).toThrow(/staging or production/i);
    }
  });

  it('requires explicit allowDebugEnclave: true on local/dev routes even when all-zero pin is passed explicitly', () => {
    for (const key of ['pk_dev_live_abc_secret', 'pk_local_sdbx_abc_secret']) {
      const env = environmentFromKey(key);
      expect(() => resolveAttestationPolicy(env)).toThrow(/allowDebugEnclave/);
      expect(() => resolveAttestationPolicy(env, { trustedPcr0s: [debugPcr0] })).toThrow(
        /allowDebugEnclave/
      );
      expect([...resolveAttestationPolicy(env, { allowDebugEnclave: true })]).toEqual([debugPcr0]);
      expect([...resolveAttestationPolicy(env, { trustedPcr0s: [validPcr0] })]).toEqual([
        validPcr0
      ]);
    }
  });
});

describe('approval mode, reviewId binding, and submissionMode isolation', () => {
  const evmTransfer = {
    chainId: 137 as const,
    to: '0x2222222222222222222222222222222222222222',
    asset: 'native',
    amount: '1000'
  };

  it('omits one-shot send* at runtime in default two-phase mode and exposes them only with allow-immediate', () => {
    const twoPhase = sdkHarness({ approval: 'two-phase' });
    expect('sendTransfer' in twoPhase.client.evm).toBe(false);
    expect('sendCall' in twoPhase.client.evm).toBe(false);
    expect('sendTransfer' in twoPhase.client.solana).toBe(false);
    expect('sendTransaction' in twoPhase.client.tron).toBe(false);
    expect('sendContractCall' in twoPhase.client.tron).toBe(false);
    expect('swaps' in twoPhase.client).toBe(false);

    const immediate = sdkHarness({ approval: 'allow-immediate' });
    expect(typeof immediate.client.evm.sendTransfer).toBe('function');
    expect(typeof immediate.client.evm.sendCall).toBe('function');
    expect(typeof immediate.client.solana.sendTransfer).toBe('function');
    expect(typeof immediate.client.tron.sendTransaction).toBe('function');
    expect(typeof immediate.client.tron.sendContractCall).toBe('function');
  });

  it('rejects execute with a wrong or missing reviewId without submitting', async () => {
    const h = sdkHarness();
    const prepared = await h.client.evm.prepareTransfer({
      idempotencyKey: 'review-check-1',
      ...evmTransfer
    });
    await expect(
      h.client.evm.execute({ idempotencyKey: 'review-check-1', reviewId: 'wrong-review-id' })
    ).rejects.toMatchObject({ code: 'STALE_REVIEW' });
    expect(h.remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(0);
    const executed = await h.client.evm.execute({
      idempotencyKey: 'review-check-1',
      reviewId: prepared.reviewId!
    });
    expect(executed.status).toBe('pending');
  });

  it('refuses immediate send on a quote prepared for manual review across restarts (even when interrupted in preparing)', async () => {
    const h = sdkHarness({ approval: 'allow-immediate' });
    // 1. EVM quoted review -> sendTransfer refused
    await h.client.evm.prepareTransfer({ idempotencyKey: 'review-only-evm', ...evmTransfer });
    await expect(
      h.create().evm.sendTransfer({ idempotencyKey: 'review-only-evm', ...evmTransfer })
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });

    // 2. EVM interrupted preparing review -> sendTransfer STILL refused!
    const stored = JSON.parse((await h.store.read('operation:review-only-evm'))!);
    stored.status = 'preparing';
    delete stored.quote;
    delete stored.reviewId;
    await h.store.write('operation:review-only-evm', JSON.stringify(stored));
    await expect(
      h.create().evm.sendTransfer({ idempotencyKey: 'review-only-evm', ...evmTransfer })
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });

    // 3. Solana review -> sendTransfer refused
    await h.client.solana.prepareTransfer({
      idempotencyKey: 'review-only-sol',
      network: 'solana:devnet',
      to: SOLANA_RECIPIENT,
      asset: 'native',
      amount: '1000'
    });
    await expect(
      h.create().solana.sendTransfer({
        idempotencyKey: 'review-only-sol',
        network: 'solana:devnet',
        to: SOLANA_RECIPIENT,
        asset: 'native',
        amount: '1000'
      })
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });

    // 4. Tron review -> sendTransaction refused
    await h.client.tron.prepareTransaction({
      idempotencyKey: 'review-only-trx',
      network: 'tron:nile',
      to: TRON_RECIPIENT,
      value: '1000'
    });
    await expect(
      h.create().tron.sendTransaction({
        idempotencyKey: 'review-only-trx',
        network: 'tron:nile',
        to: TRON_RECIPIENT,
        value: '1000'
      })
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(h.remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(0);
  });

  it('allows an immediate send retry to resume its own unsubmitted quote after a crash, and reconciles only once submitting', async () => {
    const h = sdkHarness({ approval: 'allow-immediate' });
    // Simulate a crash right after writing the immediate quote, before Execute runs:
    let failOnExecuteWrite = true;
    const origWrite = h.store.write.bind(h.store);
    h.store.write = async (key, value) => {
      if (failOnExecuteWrite && key === 'operation:imm-crash-1') {
        const parsed = JSON.parse(value);
        if (parsed.status === 'submitting') throw new Error('Crash before submit');
      }
      return origWrite(key, value);
    };
    await expect(
      h.client.evm.sendTransfer({ idempotencyKey: 'imm-crash-1', ...evmTransfer })
    ).rejects.toThrow('Crash before submit');
    expect((await h.client.evm.getOperation('imm-crash-1'))?.status).toBe('quoted');
    expect(h.remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(0);

    // Retry immediate send after restart: resumes its own quote and submits once.
    failOnExecuteWrite = false;
    const submitted = await h.create().evm.sendTransfer({
      idempotencyKey: 'imm-crash-1',
      ...evmTransfer
    });
    expect(submitted.status).toBe('pending');
    expect(h.remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(1);

    // Retrying again only reconciles.
    h.remote.txnStatus = 'executed';
    const settled = await h.create().evm.sendTransfer({
      idempotencyKey: 'imm-crash-1',
      ...evmTransfer
    });
    expect(settled.status).toBe('executed');
    expect(h.remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(1);
  });
});

describe('swaps: trails(...) binding, scope isolation, and coordination marker', () => {
  const fixture = quoteFixture();

  it('fails closed on forged/cloned handles, wrong scope, and wallet-scope reuse across namespaces', () => {
    const walletSwaps = trails({
      apiKey: 'trails-key',
      chains: { 137: 'https://polygon.rpc.example', 8453: 'https://base.rpc.example' },
      assets: fixture.assets,
      storage: {
        scope: 'wallet',
        adapter: new MemorySwapStore(),
        encryptionKey: SWAP_ENCRYPTION_KEY
      }
    });
    const serviceSwaps = trails({
      apiKey: 'trails-key',
      chains: { 137: 'https://polygon.rpc.example', 8453: 'https://base.rpc.example' },
      assets: fixture.assets,
      storage: {
        scope: 'service',
        adapter: new MemoryNamespacedSwapStore(),
        encryptionKey: SWAP_ENCRYPTION_KEY
      }
    });

    const baseOpts = {
      publishableKey: 'pk_live_abc_secret',
      oidc: {
        issuer: 'https://issuer.example',
        audience: 'oms',
        subject: 'user-1',
        getIdToken: async () => ({ token: 't', expiresAt: 1 })
      },
      store: { adapter: new MemoryStore(), encryptionKey },
      executor: createSingleProcessExecutor()
    };

    // Forged / cloned handles fail closed with CONFIGURATION.
    expect(() =>
      createServerWallet({ ...baseOpts, swaps: { ...walletSwaps } as typeof walletSwaps })
    ).toThrow(WalletError);
    // Wrong scope (service -> createServerWallet) fails closed.
    expect(() =>
      createServerWallet({ ...baseOpts, swaps: serviceSwaps as unknown as typeof walletSwaps })
    ).toThrow(/scope: "wallet"/);
    // Wrong scope (wallet -> createServerWalletService) fails closed.
    expect(() =>
      createServerWalletService({
        publishableKey: 'pk_live_abc_secret',
        oidc: {
          issuer: 'https://issuer.example',
          audience: 'oms',
          getIdToken: async () => ({ token: 't', expiresAt: 1 })
        },
        storage: { adapter: new MemoryNamespacedStore(), encryptionKey },
        executor: createSingleProcessExecutorPool(),
        swaps: walletSwaps as unknown as typeof serviceSwaps
      })
    ).toThrow(/scope: "service"/);

    // Wallet-scoped handle binds to first namespace, refuses a second namespace!
    createServerWallet({ ...baseOpts, swaps: walletSwaps });
    expect(() =>
      createServerWallet({
        ...baseOpts,
        oidc: { ...baseOpts.oidc, subject: 'user-2' },
        swaps: walletSwaps
      })
    ).toThrow(/second wallet namespace/);
  });

  it('refuses EVM debits on a stray plain wallet once swaps coordination is active on that state', async () => {
    const h = await swapHarness();
    await h.confirm();
    // Construct a plain handle pointing at the exact same wallet state without swaps: trails(...)
    const plain = createServerWalletInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc: {
          subject: 'customer-1',
          issuer: 'https://issuer.example',
          audience: 'oms-server-wallet',
          getIdToken: async () => ({ token: 't', expiresAt: Math.floor(Date.now() / 1000) + 300 })
        },
        store: { encryptedStore: h.waas.store },
        executor: h.waas.executor
      },
      { transport: h.waas.remote }
    );
    await expect(
      plain.evm.prepareTransfer({
        idempotencyKey: 'bypass-attempt-1',
        chainId: 137 as const,
        to: '0x2222222222222222222222222222222222222222',
        asset: 'native',
        amount: '1'
      })
    ).rejects.toMatchObject({ code: 'SWAPS_COORDINATION_REQUIRED' });
  });

  it('isolates multi-tenant service subjects across wallet stores, namespaces, and swap stores', async () => {
    const walletStorage = new MemoryNamespacedStore();
    const swapStorage = new MemoryNamespacedSwapStore();
    const pool = createSingleProcessExecutorPool();
    const remote = new FakeWaas();
    const origReq = remote.request.bind(remote);
    remote.request = async (method, body, cred) => {
      if (method === 'CompleteAuth') {
        const sub = String(body.answer).split(':')[1];
        return {
          identity: { type: 'oidc', iss: 'https://issuer.example', sub },
          credential: {
            credentialId: cred!.credentialId,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString()
          },
          wallets: []
        };
      }
      return origReq(method, body, cred);
    };

    const service = createServerWalletServiceInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc: {
          issuer: 'https://issuer.example',
          audience: 'oms',
          getIdToken: async (sub) => ({
            token: `tok:${sub}:${crypto.randomUUID()}`,
            expiresAt: Math.floor(Date.now() / 1000) + 300
          })
        },
        storage: { adapter: walletStorage, encryptionKey },
        executor: pool,
        swaps: trailsInternal(
          {
            apiKey: 'trails-key',
            chains: { 137: 'https://polygon.rpc.example', 8453: 'https://base.rpc.example' },
            assets: fixture.assets,
            storage: { scope: 'service', adapter: swapStorage, encryptionKey: SWAP_ENCRYPTION_KEY }
          },
          {
            gateway: {
              readiness: async () => ({ TrailsContracts: fixture.intent.trailsContracts }),
              quoteIntent: async () => ({ intent: structuredClone(fixture.intent) }),
              getIntent: async () => ({ intent: structuredClone(fixture.intent) }),
              executeIntent: async () => ({
                intentId: fixture.intent.intentId,
                intentStatus: 'EXECUTING'
              }),
              getIntentReceipt: async () => {
                throw new Error('unused');
              },
              retryIntent: async () => {
                throw new Error('unused');
              },
              prepareIntentRecovery: async () => {
                throw new Error('unused');
              },
              buildIntentRecoveryTransaction: async () => {
                throw new Error('unused');
              }
            } as any,
            chains: {
              balance: async () => '100000000',
              code: async () => '0x6000',
              receipt: async () => null
            }
          }
        )
      },
      { transport: remote }
    );

    const w1 = service.forSubject('alice');
    const w2 = service.forSubject('bob');
    await w1.createOrRestore();
    await w2.createOrRestore();
    expect(walletStorage.data.size).toBe(2);
    const env = environmentFromKey(TEST_PUBLISHABLE_KEY);
    expect(
      walletStorage.data.has(
        computeIdentityNamespace({
          waasOrigin: env.origin,
          projectId: env.projectId,
          issuer: 'https://issuer.example',
          audience: 'oms',
          subject: 'alice'
        })
      )
    ).toBe(true);
    expect((await w1.swaps.list()).items).toEqual([]);
    expect((await w2.swaps.list()).items).toEqual([]);
    const identity = {
      waasOrigin: env.origin,
      projectId: env.projectId,
      audience: 'oms',
      subject: 'alice'
    };
    expect(computeIdentityNamespace({ ...identity, issuer: 'https://issuer.example/' })).toBe(
      computeIdentityNamespace({ ...identity, issuer: 'https://issuer.example' })
    );
  });
});

describe('observation, waitForOperation, describeOperation, indexer facet, and error guards', () => {
  it('keeps getOperation local and supports waitForOperation settled / timed-out / cancelled / reconciliation-required', async () => {
    const h = sdkHarness();
    const sent = await h.client.evm.sendTransfer({
      idempotencyKey: 'wait-op-1',
      chainId: 137 as const,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '1000'
    });
    expect(sent.status).toBe('pending');
    const callsBefore = h.remote.calls.length;
    expect((await h.client.evm.getOperation('wait-op-1'))?.status).toBe('pending');
    expect(h.remote.calls.length).toBe(callsBefore);

    // Timed out while still pending
    const timedOut = await h.client.evm.waitForOperation('wait-op-1', {
      timeoutMs: 10,
      pollIntervalMs: 250
    });
    expect(timedOut.outcome).toBe('timed-out');
    expect(timedOut.operation?.id).toBe('wait-op-1');

    // A pre-aborted AbortSignal ends the wait as 'aborted' with ZERO remote WaaS calls
    const beforeAbortCalls = h.remote.calls.length;
    const controller = new AbortController();
    controller.abort();
    const cancelled = await h.client.evm.waitForOperation('wait-op-1', {
      timeoutMs: 5_000,
      signal: controller.signal
    });
    expect(cancelled.outcome).toBe('aborted');
    expect(h.remote.calls.length).toBe(beforeAbortCalls);

    // Escalation to reconciliation-required stops wait with distinct outcome
    const h2 = sdkHarness();
    const prep2 = await h2.client.evm.prepareTransfer({
      idempotencyKey: 'wait-recon-1',
      chainId: 137 as const,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '1000'
    });
    h2.remote.failExecute = true;
    await h2.client.evm.execute({ idempotencyKey: 'wait-recon-1', reviewId: prep2.reviewId! });
    h2.remote.evmStatusError = 7309;
    const stored2 = JSON.parse((await h2.store.read('operation:wait-recon-1'))!);
    stored2.quote.expiresAt = new Date(Date.now() - 121_000).toISOString();
    await h2.store.write('operation:wait-recon-1', JSON.stringify(stored2));
    const recon = await h2.client.evm.waitForOperation('wait-recon-1', {
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });
    expect(recon.outcome).toBe('reconciliation-required');
    expect(recon.operation).toMatchObject({ status: 'unknown', error: 'RECONCILIATION_REQUIRED' });

    // Settled once WaaS reports executed
    h.remote.txnStatus = 'executed';
    const settled = await h.client.evm.waitForOperation('wait-op-1', {
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });
    expect(settled.outcome).toBe('executed');
    // The 'executed' outcome narrows the operation to its executed status.
    if (settled.outcome === 'executed') expect(settled.operation.quote.txnId).toBeTruthy();
    expect(settled.operation?.status).toBe('executed');
  });

  it('keeps waiting through a stale TransactionExpired read and guides re-prepare after operator resolution', async () => {
    const h = sdkHarness();
    const prep = await h.client.evm.prepareTransfer({
      idempotencyKey: 'grace-op-1',
      chainId: 137 as const,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '1000'
    });
    h.remote.failExecute = true;
    await h.client.evm.execute({ idempotencyKey: 'grace-op-1', reviewId: prep.reviewId! });
    h.remote.evmStatusError = 7309;
    const stored = JSON.parse((await h.store.read('operation:grace-op-1'))!);
    const txnId = stored.quote.txnId as string;

    // Inside the post-expiry grace window the TransactionExpired read may predate the claim.
    stored.quote.expiresAt = new Date(Date.now() - 10_000).toISOString();
    await h.store.write('operation:grace-op-1', JSON.stringify(stored));
    const waited = await h.client.evm.waitForOperation('grace-op-1', {
      timeoutMs: 300,
      pollIntervalMs: 250
    });
    expect(waited.outcome).toBe('timed-out');
    expect(waited.operation).toMatchObject({ status: 'unknown', error: 'SUBMISSION_UNCERTAIN' });

    // Past the grace window the operation escalates; an operator resolution ends in re-prepare.
    stored.quote.expiresAt = new Date(Date.now() - 121_000).toISOString();
    await h.store.write('operation:grace-op-1', JSON.stringify(stored));
    await h.client.evm.refreshOperation('grace-op-1');
    const resolved = await h.client.evm.resolveReconciliation({
      idempotencyKey: 'grace-op-1',
      txnId,
      resolution: 'not-broadcast'
    });
    expect(resolved).toMatchObject({
      status: 'expired',
      provenUnsent: false,
      operatorResolved: true
    });
    expect((await h.client.evm.getOperation('grace-op-1'))?.operatorResolved).toBe(true);
    expect(describeOperation(resolved)).toMatchObject({ action: 'safe-to-reprepare' });
  });

  it('rejects malformed waitForOperation and resolveReconciliation input with INVALID_INPUT', async () => {
    const h = sdkHarness();
    await expect(
      h.client.evm.waitForOperation('missing-op-1', { timeoutMs: 0 })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', status: 400 });
    await expect(
      h.client.evm.resolveReconciliation({
        idempotencyKey: 'missing-op-1',
        txnId: '',
        resolution: 'not-broadcast'
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      h.client.evm.resolveReconciliation({
        idempotencyKey: 'missing-op-1',
        txnId: 'txn-1',
        resolution: 'broadcast' as 'not-broadcast'
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('keeps executed operations executed through stale reads and backfills a missing hash', async () => {
    const h = sdkHarness();
    const sent = await h.client.evm.sendTransfer({
      idempotencyKey: 'mono-exec-1',
      chainId: 137,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '1000'
    });
    expect(sent.status).toBe('pending');
    const request = h.remote.request.bind(h.remote);
    const reads: unknown[] = [{ status: 'executed' }, { status: 'quoted' }, { status: 'pending' }];
    h.remote.request = async (method, body, credential) =>
      method === 'TransactionStatus' && reads.length
        ? reads.shift()
        : request(method, body, credential);
    expect(await h.client.evm.refreshOperation('mono-exec-1')).toMatchObject({
      status: 'executed'
    });
    const waited = await h.client.evm.waitForOperation('mono-exec-1', { timeoutMs: 1_000 });
    expect(waited.outcome).toBe('executed');
    // Stale reads after execution never move it back.
    expect((await h.client.evm.refreshOperation('mono-exec-1'))?.status).toBe('executed');
    expect((await h.client.evm.refreshOperation('mono-exec-1'))?.status).toBe('executed');
    h.remote.txnStatus = 'executed';
    expect(await h.client.evm.refreshOperation('mono-exec-1')).toMatchObject({
      status: 'executed',
      txnHash: `0x${'ab'.repeat(32)}`
    });
  });

  it('treats TransactionNotFound like expiry only after the quote expired, and lets operators resolve it', async () => {
    const h = sdkHarness();
    const prepared = await h.client.evm.prepareTransfer({
      idempotencyKey: 'not-found-1',
      chainId: 137,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '1000'
    });
    h.remote.failExecute = true;
    await h.client.evm.execute({ idempotencyKey: 'not-found-1', reviewId: prepared.reviewId! });
    h.remote.evmStatusError = 7308;
    // Before expiry, absence is not explained by expiry: surfaced to the caller.
    await expect(h.client.evm.refreshOperation('not-found-1')).rejects.toMatchObject({
      upstreamCode: 7308
    });
    const stored = JSON.parse((await h.store.read('operation:not-found-1'))!);
    stored.quote.expiresAt = new Date(Date.now() - 10_000).toISOString();
    await h.store.write('operation:not-found-1', JSON.stringify(stored));
    expect((await h.client.evm.refreshOperation('not-found-1'))?.status).toBe('unknown');
    stored.quote.expiresAt = new Date(Date.now() - 121_000).toISOString();
    await h.store.write('operation:not-found-1', JSON.stringify(stored));
    expect(await h.client.evm.refreshOperation('not-found-1')).toMatchObject({
      status: 'unknown',
      error: 'RECONCILIATION_REQUIRED'
    });
    expect(
      await h.client.evm.resolveReconciliation({
        idempotencyKey: 'not-found-1',
        txnId: stored.quote.txnId,
        resolution: 'not-broadcast'
      })
    ).toMatchObject({ status: 'expired', operatorResolved: true });
  });

  it('cancels an unsubmitted operation so it can never execute, and refuses to cancel a submitted one', async () => {
    const h = sdkHarness();
    const transfer = {
      chainId: 137,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '1000'
    } as const;
    const quoted = await h.client.evm.prepareTransfer({
      idempotencyKey: 'cancel-me-1',
      ...transfer
    });
    const cancelled = await h.client.evm.cancel({ idempotencyKey: 'cancel-me-1' });
    expect(cancelled).toMatchObject({ status: 'cancelled', provenUnsent: true });
    expect(describeOperation(cancelled).action).toBe('safe-to-reprepare');
    // Idempotent, and the same key keeps returning the cancelled record.
    expect((await h.client.evm.cancel({ idempotencyKey: 'cancel-me-1' })).status).toBe('cancelled');
    expect(
      (await h.client.evm.prepareTransfer({ idempotencyKey: 'cancel-me-1', ...transfer })).status
    ).toBe('cancelled');
    const executes = h.remote.calls.filter((call) => call.method === 'Execute').length;
    await expect(
      h.client.evm.execute({ idempotencyKey: 'cancel-me-1', reviewId: quoted.reviewId! })
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    expect(h.remote.calls.filter((call) => call.method === 'Execute')).toHaveLength(executes);

    await h.client.evm.sendTransfer({ idempotencyKey: 'cancel-late-1', ...transfer });
    await expect(h.client.evm.cancel({ idempotencyKey: 'cancel-late-1' })).rejects.toMatchObject({
      code: 'INVALID_STATE'
    });
    await expect(h.client.evm.cancel({ idempotencyKey: 'missing-key-1' })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    });

    const sol = await h.client.solana.prepareTransfer({
      idempotencyKey: 'cancel-sol-1',
      network: 'solana:devnet',
      to: SOLANA_RECIPIENT,
      asset: 'native',
      amount: '1000'
    });
    expect(sol.status).toBe('quoted');
    expect(await h.client.solana.cancel({ idempotencyKey: 'cancel-sol-1' })).toMatchObject({
      status: 'cancelled'
    });
  });

  it('marks an expired, unsent quote as expired on refresh without calling execute', async () => {
    const h = sdkHarness();
    await h.client.evm.prepareTransfer({
      idempotencyKey: 'stale-quote-1',
      chainId: 137,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '1000'
    });
    const stored = JSON.parse((await h.store.read('operation:stale-quote-1'))!);
    stored.quote.expiresAt = new Date(Date.now() - 1_000).toISOString();
    await h.store.write('operation:stale-quote-1', JSON.stringify(stored));
    const refreshed = await h.client.evm.refreshOperation('stale-quote-1');
    expect(refreshed).toMatchObject({
      status: 'expired',
      error: 'QUOTE_EXPIRED',
      provenUnsent: true
    });
    expect(describeOperation(refreshed!).action).toBe('safe-to-reprepare');
    expect(h.remote.calls.filter((call) => call.method === 'Execute')).toHaveLength(0);
  });

  it('bounds waitForOperation by its deadline and abort signal, even behind a busy lock or slow refresh', async () => {
    const h = sdkHarness();
    await h.client.evm.sendTransfer({
      idempotencyKey: 'bounded-wait-1',
      chainId: 137,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '1000'
    });
    await expect(
      h.client.evm.waitForOperation('bounded-wait-1', {
        timeoutMs: 1_000,
        pollIntervalMs: Number.NaN
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    // Queued behind a long task: the wait ends at its deadline without the first read.
    let release!: () => void;
    const busy = h.executor.run(() => new Promise<void>((resolve) => (release = resolve)));
    const started = Date.now();
    const queued = await h.client.evm.waitForOperation('bounded-wait-1', { timeoutMs: 50 });
    expect(queued).toEqual({ outcome: 'timed-out' });
    expect(Date.now() - started).toBeLessThan(1_000);
    release();
    await busy;

    // A slow refresh is abandoned on abort; its later failure is observed, not unhandled.
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) => {
      if (method !== 'TransactionStatus') return request(method, body, credential);
      await new Promise((resolve) => setTimeout(resolve, 150));
      throw new Error('late failure after the caller gave up');
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const aborted = await h.client.evm.waitForOperation('bounded-wait-1', {
      timeoutMs: 5_000,
      signal: controller.signal
    });
    expect(aborted).toMatchObject({ outcome: 'aborted', operation: { id: 'bounded-wait-1' } });
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  it('fails closed on a stored record that breaks its status guarantees', async () => {
    const h = sdkHarness();
    await h.client.evm.prepareTransfer({
      idempotencyKey: 'broken-quoted-1',
      chainId: 137,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '1000'
    });
    const stored = JSON.parse((await h.store.read('operation:broken-quoted-1'))!);
    delete stored.reviewId;
    await h.store.write('operation:broken-quoted-1', JSON.stringify(stored));
    await expect(h.client.evm.getOperation('broken-quoted-1')).rejects.toMatchObject({
      code: 'INVALID_STATE'
    });
  });

  it('exports the supported networks and guards for chain IDs and error codes', async () => {
    expect(EVM_NETWORKS.map((network) => network.id)).toEqual(
      expect.arrayContaining([1, 137, 80002, 11155111, 8453, 84532])
    );
    expect(EVM_NETWORKS).toHaveLength(16);
    expect(SOLANA_NETWORKS).toEqual(['solana:mainnet', 'solana:devnet']);
    expect(TRON_NETWORKS).toEqual(['tron:mainnet', 'tron:nile']);
    expect(isSupportedEvmChainId(80002)).toBe(true);
    expect(isSupportedEvmChainId(999_999)).toBe(false);
    expect(isSupportedEvmChainId('137')).toBe(false);
    expect(isWalletErrorCode('QUOTE_EXPIRED')).toBe(true);
    expect(isWalletErrorCode('TRAILS_FAILED')).toBe(false);
    expect(isWalletErrorCode('toString')).toBe(false);

    // A stored operation recording a code outside the union is unrecognised state.
    const h = sdkHarness();
    await h.client.evm.prepareTransfer({
      idempotencyKey: 'bad-code-1',
      chainId: 137,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '1000'
    });
    const stored = JSON.parse((await h.store.read('operation:bad-code-1'))!);
    await h.store.write('operation:bad-code-1', JSON.stringify({ ...stored, error: 'NOT_A_CODE' }));
    await expect(h.client.evm.getOperation('bad-code-1')).rejects.toMatchObject({
      code: 'INVALID_STATE'
    });
  });

  it('reports failed and expired operations as their own wait outcomes, never as executed', async () => {
    const h = sdkHarness();
    const transfer = {
      chainId: 137 as const,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '1000'
    } as const;
    const refused = await h.client.evm.prepareTransfer({
      idempotencyKey: 'wait-failed-1',
      ...transfer
    });
    h.remote.evmExecuteRefusal = 7206;
    await h.client.evm.execute({ idempotencyKey: 'wait-failed-1', reviewId: refused.reviewId! });
    const failed = await h.client.evm.waitForOperation('wait-failed-1', { timeoutMs: 1_000 });
    expect(failed).toMatchObject({ outcome: 'failed', operation: { provenUnsent: true } });

    const stale = await h.client.evm.prepareTransfer({
      idempotencyKey: 'wait-expired-1',
      ...transfer
    });
    const stored = JSON.parse((await h.store.read('operation:wait-expired-1'))!);
    stored.quote.expiresAt = new Date(Date.now() - 1_000).toISOString();
    await h.store.write('operation:wait-expired-1', JSON.stringify(stored));
    await expect(
      h.client.evm.execute({ idempotencyKey: 'wait-expired-1', reviewId: stale.reviewId! })
    ).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    const expired = await h.client.evm.waitForOperation('wait-expired-1', { timeoutMs: 1_000 });
    expect(expired).toMatchObject({ outcome: 'expired', operation: { provenUnsent: true } });
  });

  it('reads transaction status by txnId without settling operations or creating wallets', async () => {
    const h = sdkHarness();
    for (const facet of [h.client.evm, h.client.solana, h.client.tron])
      await expect(facet.getTransactionStatus('txn-unknown-1')).rejects.toMatchObject({
        code: 'WALLET_NOT_INITIALIZED'
      });
    expect(h.remote.calls.filter((call) => call.method === 'CreateWallet')).toHaveLength(0);
    for (const bad of ['', 'has space', 'x'.repeat(257)])
      await expect(h.client.evm.getTransactionStatus(bad)).rejects.toMatchObject({
        code: 'INVALID_INPUT'
      });

    const sent = await h.client.evm.sendTransfer({
      idempotencyKey: 'status-evm-1',
      chainId: 137 as const,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '1000'
    });
    expect(sent.status).toBe('pending');
    h.remote.txnStatus = 'executed';
    expect(await h.client.evm.getTransactionStatus(sent.quote!.txnId)).toEqual({
      txnId: sent.quote!.txnId,
      status: 'executed',
      txnHash: `0x${'ab'.repeat(32)}`
    });
    // A status read never settles the stored operation.
    expect((await h.client.evm.getOperation('status-evm-1'))?.status).toBe('pending');

    const sol = await h.client.solana.sendTransfer({
      idempotencyKey: 'status-sol-1',
      network: 'solana:devnet',
      to: SOLANA_RECIPIENT,
      asset: 'native',
      amount: '1000'
    });
    expect(await h.client.solana.getTransactionStatus(sol.quote!.txnId)).toMatchObject({
      txnId: sol.quote!.txnId,
      status: sol.status,
      ...(sol.txnHash ? { txnHash: sol.txnHash } : {})
    });
  });

  it('reports malformed WaaS responses as INVALID_RESPONSE and records the code', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore();
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) => {
      if (method === 'PrepareEthereumTransaction') return { txnId: 7 };
      if (method === 'SignMessage') return { signature: 42 };
      return request(method, body, credential);
    };
    const failure = await h.client.evm
      .prepareTransfer({
        idempotencyKey: 'malformed-quote-1',
        chainId: 137 as const,
        to: '0x2222222222222222222222222222222222222222',
        asset: 'native',
        amount: '1000'
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WalletError);
    expect(failure).toMatchObject({ code: 'INVALID_RESPONSE', status: 502 });
    expect(await h.client.evm.getOperation('malformed-quote-1')).toMatchObject({
      status: 'failed',
      error: 'INVALID_RESPONSE'
    });
    await expect(
      h.client.evm.signMessage({
        idempotencyKey: 'malformed-sign-1',
        chainId: 137 as const,
        message: 'hi'
      })
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('prunes an open-index ID whose record was never written (crash before first write)', async () => {
    const h = sdkHarness();
    await h.client.evm.prepareTransfer({
      idempotencyKey: 'open-kept-1',
      chainId: 137 as const,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '1000'
    });
    const index = JSON.parse((await h.store.read('openOperationIndex'))!);
    await h.store.write(
      'openOperationIndex',
      JSON.stringify({ ...index, ids: [...index.ids, 'orphan-crash-1'] })
    );
    const page = await h.client.evm.listOperations({ status: 'open' });
    expect(page.items.map((op) => op.id)).toEqual(['open-kept-1']);
    expect(JSON.parse((await h.store.read('openOperationIndex'))!).ids).toEqual(['open-kept-1']);
  });

  it('derives safe next actions from operation evidence in describeOperation', () => {
    const base = {
      id: 'op-12345678',
      family: 'evm' as const,
      kind: 'transfer' as const,
      chainId: 137 as const,
      inputHash: 'hash',
      createdAt: new Date().toISOString(),
      submissionMode: 'review' as const,
      provenUnsent: false
    };
    expect(
      describeOperation({ ...base, status: 'quoted', reviewId: 'rev-1' } as WalletOperation)
    ).toMatchObject({ action: 'await-review', reviewId: 'rev-1' });
    expect(
      describeOperation({ ...base, status: 'expired', provenUnsent: true } as WalletOperation)
    ).toMatchObject({ action: 'safe-to-reprepare' });
    // An expired record without proof it was unsent MUST NOT advise re-preparing!
    expect(
      describeOperation({ ...base, status: 'expired', provenUnsent: false } as WalletOperation)
    ).toMatchObject({ action: 'reconcile-original' });
    expect(
      describeOperation({
        ...base,
        status: 'expired',
        provenUnsent: false,
        operatorResolved: true
      } as WalletOperation)
    ).toMatchObject({ action: 'safe-to-reprepare' });
    expect(
      describeOperation({
        ...base,
        status: 'unknown',
        error: 'RECONCILIATION_REQUIRED'
      } as WalletOperation)
    ).toMatchObject({ action: 'reconcile-original' });
    expect(
      describeOperation({
        ...base,
        kind: 'sign',
        status: 'unknown'
      } as WalletOperation)
    ).toMatchObject({ action: 'reconcile-original' });
    expect(
      describeOperation({
        ...base,
        status: 'failed',
        provenUnsent: false
      } as WalletOperation)
    ).toMatchObject({ action: 'done' });
    expect(
      describeOperation({
        ...base,
        status: 'executed',
        txnHash: `0x${'ab'.repeat(32)}`
      } as WalletOperation)
    ).toMatchObject({ action: 'done', txnHash: `0x${'ab'.repeat(32)}` });
  });

  it('reports WALLET_NOT_INITIALIZED on wallet.indexer without authenticating, filters EVM chainIds, and wraps invalid addresses', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        nativeBalances: [
          {
            chainId: 137 as const,
            results: [
              {
                chainId: 137 as const,
                accountAddress: '0x1111111111111111111111111111111111111111',
                balanceWei: '500'
              }
            ]
          }
        ],
        balances: []
      })
    );
    const store = new MemoryStore();
    const remote = new FakeWaas();
    const wallet = createServerWalletInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc: {
          subject: 'customer-1',
          issuer: 'https://issuer.example',
          audience: 'oms',
          getIdToken: async () => ({ token: 't', expiresAt: 1000 })
        },
        store: { encryptedStore: store },
        executor: createSingleProcessExecutor()
      },
      { transport: remote, indexer: new IndexerClient(TEST_PUBLISHABLE_KEY, fetcher) }
    );
    await expect(wallet.indexer.getEvmBalances()).rejects.toMatchObject({
      code: 'WALLET_NOT_INITIALIZED'
    });
    await expect(wallet.indexer.getSolanaBalances()).rejects.toMatchObject({
      code: 'WALLET_NOT_INITIALIZED'
    });
    await expect(wallet.indexer.getTronBalances()).rejects.toMatchObject({
      code: 'WALLET_NOT_INITIALIZED'
    });
    expect(remote.calls).toHaveLength(0);

    await wallet.createOrRestore();
    const balances = await wallet.indexer.getEvmBalances({ chainIds: [137] });
    expect(balances.items).toHaveLength(1);
    expect(balances.errors).toEqual([]);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).chainIds).toEqual([137]);

    const idx = new IndexerClient(TEST_PUBLISHABLE_KEY, fetcher);
    await expect(idx.getBalances('not-an-address')).rejects.toMatchObject({
      code: 'INVALID_ADDRESS'
    });
  });

  it('provides accurate UpstreamError.name and error type guards', () => {
    const w = new WalletError('INVALID_AMOUNT', 'bad');
    const u = new UpstreamError(7306, 'Execute');
    expect(u.name).toBe('UpstreamError');
    expect(isWalletError(w)).toBe(true);
    expect(isWalletError(u)).toBe(true);
    expect(isWalletError(new Error('other'))).toBe(false);
    expect(isUpstreamError(u)).toBe(true);
    expect(isUpstreamError(w)).toBe(false);
  });

  it('keeps storage encryption AAD independent of the HTTP Origin header', async () => {
    const raw = new MemoryStore();
    const remote = new FakeWaas();
    const make = (origin: string) =>
      createServerWalletInternal(
        {
          publishableKey: TEST_PUBLISHABLE_KEY,
          origin,
          oidc: {
            subject: 'customer-1',
            issuer: 'https://issuer.example',
            audience: 'oms',
            getIdToken: async () => ({
              token: `tok-${crypto.randomUUID()}`,
              expiresAt: Math.floor(Date.now() / 1000) + 300
            })
          },
          store: { adapter: raw, encryptionKey },
          executor: createSingleProcessExecutor()
        },
        { transport: remote }
      );
    const created = await make('https://app-a.example').createOrRestore();
    const restored = await make('https://app-b.example').inspect();
    expect(restored.wallet).toEqual(created.wallet);
  });
});

describe('review-audit boundary regressions', () => {
  it('blocks mis-scoped swap adapters in list() and tick() so wallet B never executes wallet A swaps', async () => {
    const h = await swapHarness();
    await h.confirm();

    // Wallet B has a DIFFERENT EVM address but erroneously points at wallet A's swap store.
    const storeB = new MemoryStore();
    const remoteB = new FakeWaas();
    remoteB.wallet = {
      id: 'wallet-b',
      address: '0x9999999999999999999999999999999999999999',
      networkFamily: 'evm'
    };
    const origReq = remoteB.request.bind(remoteB);
    remoteB.request = async (method, body, cred) => {
      if (method === 'CompleteAuth') {
        return {
          identity: { type: 'oidc', iss: 'https://issuer.example', sub: 'customer-b' },
          credential: {
            credentialId: cred!.credentialId,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString()
          },
          wallets: [remoteB.wallet!]
        };
      }
      return origReq(method, body, cred);
    };
    const walletB = createServerWalletInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc: {
          subject: 'customer-b',
          issuer: 'https://issuer.example',
          audience: 'oms-server-wallet',
          getIdToken: async () => ({
            token: 'tok-b',
            expiresAt: Math.floor(Date.now() / 1000) + 300
          })
        },
        store: { encryptedStore: storeB },
        executor: createSingleProcessExecutor(),
        swaps: trailsInternal(
          {
            apiKey: 'trails-key',
            chains: { 137: 'https://polygon.rpc.example', 8453: 'https://base.rpc.example' },
            assets: h.fixture.assets,
            storage: { scope: 'wallet', adapter: h.store, encryptionKey: SWAP_ENCRYPTION_KEY }
          },
          { gateway: h.gateway, chains: h.chains }
        )
      },
      { transport: remoteB }
    );
    await walletB.createOrRestore();
    const callsBefore = remoteB.calls.length;
    // Records are sealed per wallet namespace, so wallet B cannot even decrypt them.
    await expect(walletB.swaps.list()).rejects.toMatchObject({ code: 'STORAGE_INTEGRITY' });
    await expect(walletB.swaps.tick()).rejects.toMatchObject({ code: 'STORAGE_INTEGRITY' });
    // Wallet B must never Prepare or Execute anything for wallet A's swap.
    expect(
      remoteB.calls
        .slice(callsBefore)
        .filter((c) => c.method === 'PrepareEthereumTransaction' || c.method === 'Execute')
    ).toHaveLength(0);
  });

  it('requires a 32-byte swap encryption key at trails() configuration time', () => {
    const base = {
      apiKey: 'trails-key',
      chains: { 137: 'https://polygon.rpc.example' },
      assets: quoteFixture().assets
    };
    for (const encryptionKey of [undefined, '', 'c2hvcnQ=']) {
      expect(() =>
        trails({
          ...base,
          storage: {
            scope: 'wallet',
            adapter: new MemorySwapStore(),
            encryptionKey: encryptionKey!
          }
        })
      ).toThrow(expect.objectContaining({ code: 'CONFIGURATION' }));
    }
  });

  it('encrypts swap payloads and fails closed on any edited entry field', async () => {
    const h = await swapHarness();
    const q = await h.quote();
    const original = structuredClone(h.store.entries.get(q.id)!);
    expect(original.payload).not.toContain(q.quote.reviewId);
    expect(original.payload).not.toContain(h.fixture.intent.intentId);
    const edits: Partial<StoredSwapEntry>[] = [
      { active: !original.active },
      { nextAt: 1 },
      { version: original.version + 1 },
      { createdAt: '2020-01-01T00:00:00.000Z' },
      { intentId: 'other-intent' },
      { payload: original.payload.replace(/"data":"./, '"data":"A') }
    ];
    for (const edit of edits) {
      h.store.entries.set(q.id, { ...original, ...edit });
      await expect(h.swaps.get(q.id)).rejects.toMatchObject({ code: 'STORAGE_INTEGRITY' });
    }
    // An entry stored under another ID is not accepted for this one.
    h.store.entries.set('swap-test-0002', original);
    h.store.entries.set(q.id, original);
    await expect(h.swaps.get('swap-test-0002')).rejects.toMatchObject({
      code: 'STORAGE_INTEGRITY'
    });
    h.store.entries.delete('swap-test-0002');
    expect((await h.swaps.get(q.id)).id).toBe(q.id);
  });

  it('only an authentic record for the same intent can block a quote as already tracked', async () => {
    const h = await swapHarness();
    // A store whose intent index points at a missing or unrelated swap is refused, not trusted.
    h.store.findIntent = async () => 'swap-not-there';
    await expect(h.quote('swap-test-0002')).rejects.toMatchObject({ code: 'STORAGE_INTEGRITY' });
    delete (h.store as { findIntent?: unknown }).findIntent;
    const first = await h.quote('swap-test-0001');
    await expect(h.quote('swap-test-0002')).rejects.toMatchObject({
      code: 'INTENT_ALREADY_TRACKED'
    });
    expect(first.id).toBe('swap-test-0001');
  });

  it('persists authoritative swap reservations in wallet state so a second worker with an empty swap store cannot bypass DEBIT_PENDING', async () => {
    const h = await swapHarness();
    await h.confirm();
    // Worker 2 shares wallet state + executor, but points at a fresh/empty swap store (e.g. rollout mismatch).
    const emptySwapStore = new MemorySwapStore();
    const storeOpt = {
      scope: 'wallet' as const,
      adapter: emptySwapStore,
      encryptionKey: SWAP_ENCRYPTION_KEY
    };
    const swapsCfg = trailsInternal(
      {
        apiKey: 'trails-key',
        chains: { 137: 'https://polygon.rpc.example', 8453: 'https://base.rpc.example' },
        assets: h.fixture.assets,
        storage: storeOpt
      },
      { gateway: h.gateway, chains: h.chains }
    );
    // Mutating the caller's store object after trails(...) registration has no effect.
    (storeOpt as { adapter: MemorySwapStore }).adapter = h.store;
    const worker2 = createServerWalletInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc: {
          subject: 'customer-1',
          issuer: 'https://issuer.example',
          audience: 'oms-server-wallet',
          getIdToken: async () => ({ token: 'tok', expiresAt: Math.floor(Date.now() / 1000) + 300 })
        },
        store: { encryptedStore: h.waas.store },
        executor: h.waas.executor,
        swaps: swapsCfg
      },
      { transport: h.waas.remote }
    );
    await expect(
      worker2.evm.prepareTransfer({
        idempotencyKey: 'bypass-rollout-1',
        chainId: 137 as const,
        to: '0x2222222222222222222222222222222222222222',
        asset: 'native',
        amount: '1'
      })
    ).rejects.toMatchObject({ code: 'DEBIT_PENDING' });
  });

  it('hides internal Trails recovery signatures and child operations from public EVM getOperation / listOperations / refreshOperation', async () => {
    const h = await swapHarness();
    await h.confirm();
    await h.tick(4);
    h.waas.remote.txnStatus = 'executed';
    await h.tick();
    h.intent.status = 'FAILED';
    h.receipt.status = 'FAILED';
    h.flags.intentBalance = '1000';
    const view = await h.swaps.prepareRecovery({
      swapId: 'swap-test-0001',
      idempotencyKey: 'recovery-hide-1',
      source: 'origin'
    });
    await h.swaps.confirmRecovery({
      swapId: view.id,
      recoveryId: 'recovery-hide-1',
      reviewId: view.recoveries[0].reviewId
    });
    await h.tick(3);
    const record = await h.record();
    const signingId = record.recoveries[0].signingId;
    expect(record.recoveries[0].signed?.signature).toBe('0x1234');
    // Public EVM history MUST NOT expose internal swp_* funding, signing, deployment, or recovery ops!
    expect((await h.wallet.evm.listOperations()).items).toEqual([]);
    expect(await h.waas.store.read('operationIndex:evm:meta')).toBeNull();
    expect(await h.wallet.evm.getOperation(signingId)).toBeNull();
    expect(await h.wallet.evm.refreshOperation(signingId)).toBeNull();
    expect(await h.wallet.evm.getOperation(record.fundingId)).toBeNull();
    // Deleting openOperationIndex still rebuilds open internal ops from the internal bucket.
    h.waas.store.values.delete('openOperationIndex');
    await h.wallet.evm.listOperations({ status: 'open' });
    expect(JSON.parse((await h.waas.store.read('openOperationIndex'))!).ids).toContain(
      record.recoveries[0].transactionId
    );
  });

  it('snapshots swap and recovery confirmation inputs synchronously before queuing', async () => {
    const h = await swapHarness();
    const q = await h.quote();
    // Hold the executor lock while a stale confirm is queued, then mutate the caller's input object.
    const mutableConfirm = { swapId: q.id, reviewId: 'stale-revision' };
    const blocker = h.waas.executor.run(() => new Promise((r) => setTimeout(r, 20)));
    const pendingConfirm = h.swaps.confirm(mutableConfirm);
    mutableConfirm.reviewId = q.quote.reviewId;
    await blocker;
    await expect(pendingConfirm).rejects.toMatchObject({ code: 'STALE_QUOTE' });
  });
});

describe('deep systems hardening', () => {
  it('prevents a second worker with an empty swap store from clearing or bypassing an active reservation via quote() or confirm()', async () => {
    const h = await swapHarness();
    await h.confirm(); // Reserves chain 137 under swap-test-0001 in wallet state.

    const emptySwapStore = new MemorySwapStore();
    const worker2 = createServerWalletInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc: {
          subject: 'customer-1',
          issuer: 'https://issuer.example',
          audience: 'oms-server-wallet',
          getIdToken: async () => ({ token: 'tok', expiresAt: Math.floor(Date.now() / 1000) + 300 })
        },
        store: { encryptedStore: h.waas.store },
        executor: h.waas.executor,
        swaps: trailsInternal(
          {
            apiKey: 'trails-key',
            chains: { 137: 'https://polygon.rpc.example', 8453: 'https://base.rpc.example' },
            assets: h.fixture.assets,
            storage: {
              scope: 'wallet',
              adapter: emptySwapStore,
              encryptionKey: SWAP_ENCRYPTION_KEY
            }
          },
          { gateway: h.gateway, chains: h.chains }
        )
      },
      { transport: h.waas.remote }
    );

    // Calling quote with the SAME swapId on worker2 MUST fail closed and MUST NOT clear wallet state's reservation!
    await expect(
      worker2.swaps.quote({ idempotencyKey: 'swap-test-0001', ...h.fixture.input })
    ).rejects.toMatchObject({ code: 'DEBIT_PENDING' });

    // Confirming a DIFFERENT swap on the same chain via worker2 MUST also be blocked by wallet state's reservation!
    const otherQuote = await worker2.swaps.quote({
      idempotencyKey: 'swap-other-0002',
      ...h.fixture.input
    });
    await expect(
      worker2.swaps.confirm({ swapId: otherQuote.id, reviewId: otherQuote.quote.reviewId })
    ).rejects.toMatchObject({ code: 'DEBIT_PENDING' });

    // Ordinary EVM debit on worker2 stays blocked AND names the blocking swapId!
    await expect(
      worker2.evm.prepareTransfer({
        idempotencyKey: 'ordinary-blocked-1',
        chainId: 137 as const,
        to: '0x2222222222222222222222222222222222222222',
        asset: 'native',
        amount: '1'
      })
    ).rejects.toThrow(/swap-test-0001/);

    // Tick on worker2 with missing swap store record retains the reservation (fails closed).
    await worker2.swaps.tick();
    const state = JSON.parse((await h.waas.store.read('wallet'))!);
    expect(state.swapReservations).toMatchObject({ 'swap-test-0001': { chainId: 137 } });
  });

  it('keeps a reservation whose swap record lags behind it until the swap step is retried', async () => {
    const h = await swapHarness();
    const q = await h.quote();
    // SwapStore.save fails during confirm AFTER wallet state persisted the reservation.
    h.store.fail = (r) => r.phase === 'preparing';
    await expect(h.swaps.confirm({ swapId: q.id, reviewId: q.quote.reviewId })).rejects.toThrow(
      'Simulated storage outage'
    );
    h.store.fail = undefined;
    const held = async () => JSON.parse((await h.waas.store.read('wallet'))!).swapReservations;
    expect(await held()).toMatchObject({ 'swap-test-0001': { chainId: 137 } });
    // The stored record is older than the reservation, which a rollback would look like too:
    // tick() has no evidence it is safe to release, so the hold stays.
    expect(await h.swaps.tick()).toEqual({ nextAt: null });
    expect(await held()).toMatchObject({ 'swap-test-0001': { chainId: 137 } });
    // Retrying the step rewrites record and reservation consistently.
    expect((await h.swaps.confirm({ swapId: q.id, reviewId: q.quote.reviewId })).phase).toBe(
      'preparing'
    );
    expect(await held()).toMatchObject({ 'swap-test-0001': { chainId: 137 } });
  });

  it('never lets a rolled-back swap record release a newer reservation', async () => {
    const h = await swapHarness();
    const q = await h.quote();
    const quotedEntry = structuredClone(h.store.entries.get(q.id)!);
    await h.swaps.confirm({ swapId: q.id, reviewId: q.quote.reviewId });
    const held = async () => JSON.parse((await h.waas.store.read('wallet'))!).swapReservations;
    expect(await held()).toMatchObject({ 'swap-test-0001': { chainId: 137 } });
    // Roll the swap store back to the authentic, unreserved quote-phase record.
    h.store.entries.set(q.id, quotedEntry);
    await h.swaps.tick();
    expect(await held()).toMatchObject({ 'swap-test-0001': { chainId: 137 } });
    await expect(
      h.wallet.evm.prepareTransfer({
        idempotencyKey: 'rollback-debit-1',
        chainId: 137,
        to: '0x2222222222222222222222222222222222222222',
        asset: 'native',
        amount: '1'
      })
    ).rejects.toMatchObject({ code: 'DEBIT_PENDING' });
  });

  it('reloads wallet state after checkEvmDebitGate so gate-driven nonce/credential updates are never overwritten', async () => {
    const h = await swapHarness();
    // Create an open EVM op on chain 137 whose refresh triggers a credential rotation (expiredOnce).
    const first = await h.wallet.evm.prepareTransfer({
      idempotencyKey: 'gate-refresh-1',
      chainId: 137 as const,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '1'
    });
    await h.wallet.evm.execute({ idempotencyKey: 'gate-refresh-1', reviewId: first.reviewId! });
    const credBefore = (await h.wallet.inspect()).credentialId;

    // Now TransactionStatus will first hit KeyExpired (7203) -> rotate credential -> return executed!
    h.waas.remote.txnStatus = 'executed';
    let rotatedOnce = false;
    const origReq = h.waas.remote.request.bind(h.waas.remote);
    h.waas.remote.request = async (method, body, cred) => {
      if (method === 'TransactionStatus' && !rotatedOnce) {
        rotatedOnce = true;
        throw new UpstreamError(7203, method);
      }
      return origReq(method, body, cred);
    };

    // Preparing a new transfer invokes checkEvmDebitGate -> refreshes gate-refresh-1 -> rotates credential.
    // Must reload state after the gate and use the NEW credential rather than overwriting it with the old one!
    const second = await h.wallet.evm.prepareTransfer({
      idempotencyKey: 'gate-refresh-2',
      chainId: 137 as const,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '2'
    });
    expect(second.status).toBe('quoted');
    expect((await h.wallet.inspect()).credentialId).not.toBe(credBefore);
  });

  it('preserves pre-claim UpstreamError when re-auth fails during Execute retry (no false SUBMISSION_UNCERTAIN)', async () => {
    let failIdp = false;
    const store = new MemoryStore();
    const remote = new FakeWaas();
    const wallet = createServerWalletInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc: {
          subject: 'customer-1',
          issuer: 'https://issuer.example',
          audience: 'oms-server-wallet',
          getIdToken: async () => {
            if (failIdp) throw new Error('IdP outage');
            return {
              token: `tok-${crypto.randomUUID()}`,
              expiresAt: Math.floor(Date.now() / 1000) + 300
            };
          }
        },
        store: { encryptedStore: store },
        executor: createSingleProcessExecutor()
      },
      { transport: remote }
    );
    const prep = await wallet.evm.prepareTransfer({
      idempotencyKey: 'reauth-fail-1',
      chainId: 137 as const,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '100'
    });
    // WaaS rejects Execute pre-claim with KeyExpired (7203), and the IdP is down during retry:
    remote.evmExecuteRefusal = 7203;
    failIdp = true;
    const result = await wallet.evm.execute({
      idempotencyKey: 'reauth-fail-1',
      reviewId: prep.reviewId!
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: 'EXECUTE_REFUSED',
      provenUnsent: true
    });
  });

  it('detects tampered swap payload funding target or digest before confirm and before funding', async () => {
    const h = await swapHarness();
    const q = await h.quote();
    const rec = await h.record();
    // Attacker tampers with stored funding recipient without changing intent:
    rec.quote = {
      ...rec.quote,
      funding: { ...rec.quote.funding, to: '0x9999999999999999999999999999999999999999' }
    };
    await h.store.putRecord(rec);
    await expect(
      h.swaps.confirm({ swapId: q.id, reviewId: q.quote.reviewId })
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('rejects public evm.signTypedData for Sequence Wallet Calls payloads and self verifyingContract', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore();
    const selfAddress = (await h.client.inspect()).wallet!.address;
    const { typedData } = recoveryFixture();
    // Sequence Wallet Calls payload must be refused on public signTypedData.
    await expect(
      h.client.evm.signTypedData({
        idempotencyKey: 'block-seq-calls',
        chainId: 137 as const,
        typedData
      })
    ).rejects.toMatchObject({ code: 'INVALID_TYPED_DATA' });

    // Any typed data with verifyingContract === walletAddress must also be refused.
    await expect(
      h.client.evm.signTypedData({
        idempotencyKey: 'block-self-vc',
        chainId: 137 as const,
        typedData: {
          domain: {
            name: 'App',
            version: '1',
            chainId: 137 as const,
            verifyingContract: selfAddress
          },
          types: { Note: [{ name: 'text', type: 'string' }] },
          primaryType: 'Note',
          message: { text: 'hi' }
        }
      })
    ).rejects.toMatchObject({ code: 'INVALID_TYPED_DATA' });
  });

  it('resolves RECONCILIATION_REQUIRED on ordinary EVM and swap funding operations via resolveReconciliation', async () => {
    const h = await swapHarness();
    await h.confirm();
    h.waas.remote.failExecute = true;
    await h.tick(4);
    const { fundingId } = await h.record();
    h.waas.remote.evmStatusError = 7309;
    const rawOp = JSON.parse((await h.waas.store.read(`operation:${fundingId}`))!);
    rawOp.quote.expiresAt = new Date(Date.now() - 121_000).toISOString();
    await h.waas.store.write(`operation:${fundingId}`, JSON.stringify(rawOp));
    await h.tick();
    expect((await h.record()).error).toBe('RECONCILIATION_REQUIRED');

    // Wrong txnId is refused
    await expect(
      h.swaps.resolveReconciliation({
        swapId: 'swap-test-0001',
        txnId: 'wrong-txn-id',
        resolution: 'not-broadcast'
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Valid operator resolution re-checks WaaS (still 7309 past grace) -> expires swap & frees chain 137!
    const resolved = await h.swaps.resolveReconciliation({
      swapId: 'swap-test-0001',
      txnId: rawOp.quote.txnId,
      resolution: 'not-broadcast'
    });
    expect(resolved).toMatchObject({ phase: 'expired', error: 'QUOTE_EXPIRED' });
    // Chain 137 is now unlocked for new ordinary transfers!
    await expect(
      h.wallet.evm.prepareTransfer({
        idempotencyKey: 'after-op-resolve',
        chainId: 137 as const,
        to: '0x2222222222222222222222222222222222222222',
        asset: 'native',
        amount: '1'
      })
    ).resolves.toMatchObject({ status: 'quoted' });

    // Ordinary EVM operation: if WaaS actually answers 'executed' during resolveReconciliation, settle instead of expiring!
    const h2 = sdkHarness();
    const p2 = await h2.client.evm.prepareTransfer({
      idempotencyKey: 'ord-resolve-1',
      chainId: 137 as const,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '10'
    });
    h2.remote.failExecute = true;
    await h2.client.evm.execute({ idempotencyKey: 'ord-resolve-1', reviewId: p2.reviewId! });
    h2.remote.evmStatusError = 7309;
    const raw2 = JSON.parse((await h2.store.read('operation:ord-resolve-1'))!);
    raw2.quote.expiresAt = new Date(Date.now() - 121_000).toISOString();
    await h2.store.write('operation:ord-resolve-1', JSON.stringify(raw2));
    await h2.client.evm.refreshOperation('ord-resolve-1');
    h2.remote.evmStatusError = undefined;
    h2.remote.txnStatus = 'executed';
    const settled = await h2.client.evm.resolveReconciliation({
      idempotencyKey: 'ord-resolve-1',
      txnId: raw2.quote.txnId,
      resolution: 'not-broadcast'
    });
    expect(settled).toMatchObject({ status: 'executed', txnHash: `0x${'ab'.repeat(32)}` });
  });

  it('guides an interrupted preparation back to its own key and reports unknown signatures as reconciliation-required', async () => {
    const base = {
      id: 'interrupted-1',
      family: 'evm' as const,
      kind: 'transfer' as const,
      chainId: 137 as const,
      inputHash: 'h',
      createdAt: new Date().toISOString(),
      provenUnsent: true
    };
    // Never 'safe-to-reprepare': the original key can still resume and execute.
    expect(
      describeOperation({
        ...base,
        status: 'preparing',
        submissionMode: 'review'
      } as WalletOperation)
    ).toMatchObject({ action: 'resume-original', reason: expect.stringContaining('prepare*') });
    expect(
      describeOperation({
        ...base,
        status: 'preparing',
        submissionMode: 'immediate'
      } as WalletOperation)
    ).toMatchObject({ action: 'resume-original', reason: expect.stringContaining('send*') });
    expect(
      describeOperation({
        ...base,
        status: 'cancelled',
        submissionMode: 'review'
      } as WalletOperation)
    ).toMatchObject({ action: 'safe-to-reprepare' });

    // Unknown signature operation returns reconciliation-required immediately from waitForOperation without polling.
    const h = sdkHarness();
    await h.store.write(
      'operation:sig-unknown-1',
      JSON.stringify({
        id: 'sig-unknown-1',
        kind: 'sign',
        chainId: 137 as const,
        inputHash: 'h',
        createdAt: new Date().toISOString(),
        status: 'unknown',
        submissionMode: 'review'
      })
    );
    const waited = await h.client.evm.waitForOperation('sig-unknown-1', { timeoutMs: 5_000 });
    expect(waited.outcome).toBe('reconciliation-required');
    expect(h.remote.calls).toHaveLength(0);
  });

  it('recovers when a durable cached credential was revoked server-side before adding a family', async () => {
    const h = sdkHarness();
    const first = await h.client.createOrRestore({ families: ['evm'] });
    h.remote.revoked.add(first.credentialId!);
    const second = await h.client.createOrRestore({ families: ['evm', 'solana'] });
    expect(second.credentialId).not.toBe(first.credentialId);
    expect(second.wallets.evm?.address).toBe(first.wallets.evm?.address);
    expect(second.wallets.solana?.address).toBeDefined();
  });

  it('re-checks quote expiry after re-auth so a quote expiring mid-execute is never sent to WaaS', async () => {
    let now = Date.parse('2026-06-01T00:00:00.000Z');
    const store = new MemoryStore();
    const remote = new FakeWaas();
    let advanceOnAuth = false;
    const client = createServerWalletInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc: {
          subject: 'customer-1',
          issuer: 'https://issuer.example',
          audience: 'oms-server-wallet',
          getIdToken: async () => {
            if (advanceOnAuth) now += 600_000; // Quote expires while fetching fresh ID token
            return { token: `tok-${crypto.randomUUID()}`, expiresAt: Math.floor(now / 1000) + 300 };
          }
        },
        store: { encryptedStore: store },
        executor: createSingleProcessExecutor()
      },
      { transport: remote, clock: () => now }
    );
    await client.createOrRestore({ families: ['evm', 'solana'] });

    // Prepare EVM and Solana transfers whose quotes expire at now + 120s.
    const evmPrep = await client.evm.prepareTransfer({
      idempotencyKey: 'recheck-evm-1',
      chainId: 137 as const,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '10'
    });
    const solPrep = await client.solana.prepareTransfer({
      idempotencyKey: 'recheck-sol-1',
      network: 'solana:devnet',
      to: '11111111111111111111111111111111',
      asset: 'native',
      amount: '1000'
    });
    // Set both quotes to expire at now + 120s, and force re-auth during execute by clearing expiresAt.
    for (const key of ['operation:recheck-evm-1', 'operation:recheck-sol-1']) {
      const op = JSON.parse((await store.read(key))!);
      op.quote.expiresAt = new Date(now + 120_000).toISOString();
      await store.write(key, JSON.stringify(op));
    }
    const clearCredExpiry = async () => {
      const walletState = JSON.parse((await store.read('wallet'))!);
      walletState.credential.expiresAt = new Date(now - 1_000).toISOString();
      await store.write('wallet', JSON.stringify(walletState));
    };

    const executesBefore = remote.calls.filter((c) => c.method === 'Execute').length;
    advanceOnAuth = true;
    await clearCredExpiry();
    await expect(
      client.evm.execute({ idempotencyKey: 'recheck-evm-1', reviewId: evmPrep.reviewId! })
    ).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    expect(await client.evm.getOperation('recheck-evm-1')).toMatchObject({
      status: 'expired',
      error: 'QUOTE_EXPIRED',
      provenUnsent: true
    });

    // Reset clock so Solana quote is still valid before re-auth, then expires during re-auth.
    now = Date.parse('2026-06-01T00:00:00.000Z');
    await clearCredExpiry();
    await expect(
      client.solana.execute({ idempotencyKey: 'recheck-sol-1', reviewId: solPrep.reviewId! })
    ).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    expect(await client.solana.getOperation('recheck-sol-1')).toMatchObject({
      status: 'expired',
      error: 'QUOTE_EXPIRED',
      provenUnsent: true
    });
    expect(remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(executesBefore);
  });

  it('rejects non-string subject and malformed getIdToken results as typed WalletErrors', async () => {
    const store = new MemoryStore();
    expect(() =>
      createServerWalletInternal(
        {
          publishableKey: TEST_PUBLISHABLE_KEY,
          oidc: {
            subject: 123 as unknown as string,
            issuer: 'https://issuer.example',
            audience: 'oms-server-wallet',
            getIdToken: async () => ({ token: 't', expiresAt: 1 })
          },
          store: { encryptedStore: store },
          executor: createSingleProcessExecutor()
        },
        { transport: new FakeWaas() }
      )
    ).toThrow(expect.objectContaining({ code: 'INVALID_IDENTITY' }));

    const client = createServerWalletInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc: {
          subject: 'customer-1',
          issuer: 'https://issuer.example',
          audience: 'oms-server-wallet',
          getIdToken: async () => ({ token: '', expiresAt: Number.NaN })
        },
        store: { encryptedStore: store },
        executor: createSingleProcessExecutor()
      },
      { transport: new FakeWaas() }
    );
    await expect(client.createOrRestore()).rejects.toMatchObject({
      code: 'CONFIGURATION',
      status: 503
    });
  });
});
