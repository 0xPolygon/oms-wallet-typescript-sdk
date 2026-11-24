import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
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
import { computeIdentityNamespace, EncryptedStore } from '../src/storage.js';
import { trailsInternal } from '../src/trails/coordinator.js';
import { createServerWalletInternal, createServerWalletServiceInternal } from '../src/wallet.js';
import { quoteFixture } from './fixtures/trails.js';
import {
  FakeWaas,
  MemoryStore,
  SOLANA_RECIPIENT,
  TEST_PUBLISHABLE_KEY,
  TRON_RECIPIENT,
  sdkHarness
} from './helpers.js';
import { MemorySwapStore, swapHarness } from './swap-harness.js';

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
    chainId: 137,
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
      store: { scope: 'wallet', adapter: new MemorySwapStore() }
    });
    const serviceSwaps = trails({
      apiKey: 'trails-key',
      chains: { 137: 'https://polygon.rpc.example', 8453: 'https://base.rpc.example' },
      assets: fixture.assets,
      store: { scope: 'service', adapter: new MemoryNamespacedSwapStore() }
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
        chainId: 137,
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
            store: { scope: 'service', adapter: swapStorage }
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
  });
});

describe('observation, waitForOperation, describeOperation, indexer facet, and error guards', () => {
  it('keeps getOperation local and supports waitForOperation settled / timed-out / cancelled / reconciliation-required', async () => {
    const h = sdkHarness();
    const sent = await h.client.evm.sendTransfer({
      idempotencyKey: 'wait-op-1',
      chainId: 137,
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
    expect(timedOut.operation.id).toBe('wait-op-1');

    // Cancelled via pre-aborted AbortSignal makes ZERO remote WaaS calls
    const beforeAbortCalls = h.remote.calls.length;
    const controller = new AbortController();
    controller.abort();
    const cancelled = await h.client.evm.waitForOperation('wait-op-1', {
      timeoutMs: 5_000,
      signal: controller.signal
    });
    expect(cancelled.outcome).toBe('cancelled');
    expect(cancelled.operation.id).toBe('wait-op-1');
    expect(h.remote.calls.length).toBe(beforeAbortCalls);

    // Escalation to reconciliation-required stops wait with distinct outcome
    const h2 = sdkHarness();
    const prep2 = await h2.client.evm.prepareTransfer({
      idempotencyKey: 'wait-recon-1',
      chainId: 137,
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
    expect(settled.outcome).toBe('settled');
    expect(settled.operation.status).toBe('executed');
  });

  it('derives safe next actions from operation evidence in describeOperation', () => {
    const base = {
      id: 'op-12345678',
      family: 'evm' as const,
      kind: 'transfer' as const,
      chainId: 137,
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
    // Legacy expired record without proof it was unsent MUST NOT advise re-preparing!
    expect(
      describeOperation({ ...base, status: 'expired', provenUnsent: false } as WalletOperation)
    ).toMatchObject({ action: 'reconcile-original' });
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
            chainId: 137,
            results: [
              {
                chainId: 137,
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

  it('migrates an encrypted 0.2.x wallet with pending op, interrupted preparing op, and uncertain create via createServerWallet({ adapter, encryptionKey })', async () => {
    const raw = new MemoryStore();
    const env = environmentFromKey(TEST_PUBLISHABLE_KEY);
    const ns = computeIdentityNamespace({
      waasOrigin: env.origin,
      projectId: env.projectId,
      issuer: 'https://issuer.example',
      audience: 'oms',
      subject: 'customer-1'
    });
    const encrypted = new EncryptedStore(raw, encryptionKey, ns);
    await encrypted.write(
      'wallet',
      JSON.stringify({
        disabled: false,
        creating: true
      })
    );
    await encrypted.write('operationIndex', JSON.stringify(['pend-op-1', 'prep-op-1']));
    await encrypted.write(
      'operation:pend-op-1',
      JSON.stringify({
        id: 'pend-op-1',
        kind: 'transfer',
        inputHash: 'hash1',
        createdAt: new Date().toISOString(),
        status: 'pending',
        chainId: 137
      })
    );
    await encrypted.write(
      'operation:prep-op-1',
      JSON.stringify({
        id: 'prep-op-1',
        kind: 'transfer',
        inputHash: 'hash2',
        createdAt: new Date().toISOString(),
        status: 'preparing',
        chainId: 137
      })
    );

    const remote = new FakeWaas();
    const wallet = createServerWalletInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        origin: 'https://app.example', // Must NOT affect storage namespace AAD!
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
    const snap = await wallet.inspect();
    expect(snap.creationUncertain).toBe(true);
    const open = await wallet.evm.listOperations({ status: 'open' });
    expect(open.items.map((o) => [o.id, o.status, o.provenUnsent])).toEqual([
      ['pend-op-1', 'pending', false],
      ['prep-op-1', 'preparing', true]
    ]);
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
            store: { scope: 'wallet', adapter: h.store }
          },
          { gateway: h.gateway, chains: h.chains }
        )
      },
      { transport: remoteB }
    );
    await walletB.createOrRestore();
    const callsBefore = remoteB.calls.length;
    await expect(walletB.swaps.list()).rejects.toMatchObject({ code: 'WALLET_MISMATCH' });
    await expect(walletB.swaps.tick()).rejects.toMatchObject({ code: 'WALLET_MISMATCH' });
    // Wallet B must never Prepare or Execute anything for wallet A's swap.
    expect(
      remoteB.calls
        .slice(callsBefore)
        .filter((c) => c.method === 'PrepareEthereumTransaction' || c.method === 'Execute')
    ).toHaveLength(0);
  });

  it('persists authoritative swap reservations in wallet state so a second worker with an empty swap store cannot bypass DEBIT_PENDING', async () => {
    const h = await swapHarness();
    await h.confirm();
    // Worker 2 shares wallet state + executor, but points at a fresh/empty swap store (e.g. rollout mismatch).
    const emptySwapStore = new MemorySwapStore();
    const storeOpt = { scope: 'wallet' as const, adapter: emptySwapStore };
    const swapsCfg = trailsInternal(
      {
        apiKey: 'trails-key',
        chains: { 137: 'https://polygon.rpc.example', 8453: 'https://base.rpc.example' },
        assets: h.fixture.assets,
        store: storeOpt
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
        chainId: 137,
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
    expect(await h.wallet.evm.getOperation(signingId)).toBeNull();
    expect(await h.wallet.evm.refreshOperation(signingId)).toBeNull();
    expect(await h.wallet.evm.getOperation(record.fundingId)).toBeNull();
  });

  it('upgrades pre-0.3.0 heuristic expired records into open reconciliation, blocks competing debits, and requires affirmative evidence for failed provenUnsent', async () => {
    const h = await swapHarness();
    // Simulate a pre-0.3.0 store: v1 openOperationIndex (omitting legacy expired) + legacy expired & failed ops.
    await h.waas.store.write('operationIndex', JSON.stringify(['legacy-exp-01', 'legacy-fail-01']));
    await h.waas.store.write('openOperationIndex', JSON.stringify({ synced: 2, ids: [] }));
    await h.waas.store.write(
      'operation:legacy-exp-01',
      JSON.stringify({
        id: 'legacy-exp-01',
        kind: 'transfer',
        inputHash: 'h1',
        createdAt: new Date().toISOString(),
        status: 'expired',
        chainId: 137,
        error: 'TRANSACTION_EXPIRED',
        quote: {
          txnId: 'legacy-txn-1',
          status: 'quoted',
          sponsored: true,
          expiresAt: new Date(Date.now() - 300_000).toISOString()
        }
      })
    );
    await h.waas.store.write(
      'operation:legacy-fail-01',
      JSON.stringify({
        id: 'legacy-fail-01',
        kind: 'transfer',
        inputHash: 'h2',
        createdAt: new Date().toISOString(),
        status: 'failed',
        chainId: 137,
        error: 'PREPARATION_FAILED'
      })
    );

    const open = await h.wallet.evm.listOperations({ status: 'open' });
    expect(open.items.map((o) => [o.id, o.status, o.error, o.provenUnsent])).toEqual([
      ['legacy-exp-01', 'unknown', 'RECONCILIATION_REQUIRED', false]
    ]);
    const legacyFail = await h.wallet.evm.getOperation('legacy-fail-01');
    expect(legacyFail?.provenUnsent).toBe(false);

    // Competing swap on chain 137 MUST be blocked by the upgraded legacy-exp-01!
    h.waas.remote.evmStatusError = 7309;
    const q = await h.quote();
    await expect(
      h.swaps.confirm({ swapId: q.id, reviewId: q.quote.reviewId })
    ).rejects.toMatchObject({ code: 'DEBIT_PENDING' });
  });

  it('decrypts the actual checked-in published 0.2.0 fixture via createServerWallet with explicit encryptionContext and never falls back on wrong context', async () => {
    const legacy = JSON.parse(
      readFileSync(new URL('./fixtures/state-0.2.0.json', import.meta.url), 'utf8')
    ) as { subject: string; encryptionKey: string; store: Record<string, string> };
    const raw = new MemoryStore();
    for (const [k, v] of Object.entries(legacy.store)) raw.values.set(k, v);

    // Without matching encryptionContext, fails closed with STORAGE_INTEGRITY (no fallback!).
    const wrongContext = createServerWallet({
      publishableKey: 'pk_live_abc_secret',
      oidc: {
        subject: legacy.subject,
        issuer: 'https://issuer.example',
        audience: 'oms-server-wallet',
        getIdToken: async () => ({ token: 't', expiresAt: 1 })
      },
      store: { adapter: raw, encryptionKey: legacy.encryptionKey },
      executor: createSingleProcessExecutor()
    });
    await expect(wrongContext.inspect()).rejects.toMatchObject({ code: 'STORAGE_INTEGRITY' });

    // With explicit legacy encryptionContext, decrypts and migrates cleanly through the public factory!
    const migrated = createServerWallet({
      publishableKey: 'pk_live_abc_secret',
      oidc: {
        subject: legacy.subject,
        issuer: 'https://issuer.example',
        audience: 'oms-server-wallet',
        getIdToken: async () => ({ token: 't', expiresAt: 1 })
      },
      store: {
        adapter: raw,
        encryptionKey: legacy.encryptionKey,
        encryptionContext: legacy.subject
      },
      executor: createSingleProcessExecutor()
    });
    const snap = await migrated.inspect();
    expect(snap.wallet?.id).toBe('wallet-legacy');
    const ops = await migrated.evm.listOperations();
    expect(ops.items.map((o) => o.id)).toEqual(['legacy-sign-1', 'legacy-transfer-1']);
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
