import { createSingleProcessExecutor } from '@polygonlabs/oms-server-wallet-sdk';
import {
  TrailsError,
  type StoredSwapEntry,
  type SwapStore
} from '@polygonlabs/oms-server-wallet-sdk/trails';
import { encodeFunctionData } from 'viem';

import type { ChainReader } from '../src/trails/chain.js';
import type { PreparedRecovery, TrailsIntent, TrailsReceipt } from '../src/trails/protocol.js';
import type { SwapGateway, SwapRecord } from '../src/trails/types.js';

import { type SwapRecordCodec, trailsInternal } from '../src/trails/coordinator.js';
import { executeAbi } from '../src/trails/recovery-transaction.js';
import { createServerWalletInternal } from '../src/wallet.js';
import {
  contracts,
  intentId,
  originIntent,
  owner,
  quoteFixture,
  recoveryFixture,
  token
} from './fixtures/trails.js';
import { FakeWaas, MemoryStore, TEST_PUBLISHABLE_KEY } from './helpers.js';

/** Test-only 32-byte base64 key for swap record encryption. */
export const SWAP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

export class MemorySwapStore implements SwapStore {
  entries = new Map<string, StoredSwapEntry>();
  fail?: (record: SwapRecord) => boolean;
  /** The codec the bound coordinator uses, so tests can read and write records. */
  codec?: SwapRecordCodec;
  async get(id: string) {
    return structuredClone(this.entries.get(id) ?? null);
  }
  async findIntent(intent: string) {
    return [...this.entries.values()].find((e) => e.intentId === intent)?.id ?? null;
  }
  async save(entry: StoredSwapEntry) {
    if (this.fail && this.fail(await this.codec!.decode(entry)))
      throw new Error('Simulated storage outage');
    this.entries.set(entry.id, structuredClone(entry));
  }
  async list({ active, offset = 0, limit }: { active?: boolean; offset?: number; limit: number }) {
    return structuredClone(
      [...this.entries.values()]
        .filter((e) => !active || e.active)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(offset, offset + limit)
    );
  }
  /** Convenience helper for tests inspecting internal persisted SwapRecord state. */
  async getRecord(id: string): Promise<SwapRecord | null> {
    const entry = this.entries.get(id);
    return entry ? this.codec!.decode(entry) : null;
  }
  /** Convenience helper for tests mutating a stored SwapRecord directly. */
  async putRecord(record: SwapRecord): Promise<void> {
    this.entries.set(record.id, await this.codec!.encode(record));
  }
}

export const executeData = (payload: string, signature = '0x1234') =>
  encodeFunctionData({
    abi: executeAbi,
    functionName: 'execute',
    args: [payload as `0x${string}`, signature as `0x${string}`]
  });

export async function swapHarness(native = false) {
  const walletStore = new MemoryStore();
  const remote = new FakeWaas();
  const executor = createSingleProcessExecutor();
  const original = remote.request.bind(remote);
  remote.request = async (...args) => {
    const result = await original(...args);
    if (args[0] === 'PrepareEthereumTransaction')
      (result as { expiresAt: string }).expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    return result;
  };

  let clock = Date.now();
  const fixture = quoteFixture(native);
  let intent: TrailsIntent = {
    ...fixture.intent,
    expiresAt: new Date(clock + 900_000).toISOString()
  } as TrailsIntent;
  let receipt: TrailsReceipt = {
    intentId,
    status: 'EXECUTING',
    ownerAddress: owner,
    originChainId: 137,
    destinationChainId: 8453,
    depositTransaction: {
      intentId,
      chainId: 137,
      status: 'PENDING',
      type: 'DEPOSIT',
      fromAddress: owner,
      toAddress: originIntent,
      tokenAddress: intent.originTokenAddress,
      tokenAmount: fixture.input.amount,
      txnHash: `0x${'00'.repeat(32)}`
    },
    summary: {
      originIntentAddress: originIntent,
      destinationIntentAddress: intent.destinationIntentAddress!
    }
  };
  const calls: string[] = [];
  const flags = {
    loseActivation: false,
    missingReceipt: false,
    chainFailure: false,
    chainReverted: false,
    deployed: true,
    badBuild: false,
    balance: '100000000000000000000',
    intentBalance: '0',
    recovered: false,
    recoveredAmount: '1000'
  };
  let recovery = recoveryFixture() as PreparedRecovery;
  const gateway: SwapGateway = {
    readiness: async () => {
      calls.push('readiness');
      return { TrailsContracts: contracts };
    },
    quoteIntent: async () => {
      calls.push('quote');
      return { intent: structuredClone(intent) };
    },
    getIntent: async () => {
      calls.push('getIntent');
      return { intent: structuredClone(intent) };
    },
    executeIntent: async () => {
      calls.push('activate');
      intent.status = 'EXECUTING';
      if (flags.loseActivation) throw new Error('lost activation');
      return { intentId, intentStatus: 'EXECUTING' };
    },
    getIntentReceipt: async () => {
      calls.push('receipt');
      if (flags.missingReceipt) throw new TrailsError('GetIntentReceipt', 400, 8000);
      return { intentReceipt: structuredClone(receipt) };
    },
    retryIntent: async () => {
      calls.push('repair');
      receipt.depositTransaction!.status = 'SUCCEEDED';
      intent.status = 'EXECUTING';
      return { intentId, intentStatus: 'EXECUTING' };
    },
    prepareIntentRecovery: async () => {
      calls.push('prepareRecovery');
      return structuredClone(recovery);
    },
    buildIntentRecoveryTransaction: async () => {
      calls.push('buildRecovery');
      return {
        to: flags.badBuild ? owner : recovery.intentAddress,
        data: executeData(recovery.payload.encoded),
        value: '0',
        chainId: recovery.chainId,
        intentAddress: recovery.intentAddress,
        requiresDeploy: false,
        payloadHash: recovery.payloadHash
      };
    }
  };
  const chains: ChainReader = {
    balance: async (_chain, address, asset) => {
      if (flags.chainFailure) throw new Error('RPC down');
      if (address.toLowerCase() === owner)
        return flags.recovered ? (BigInt(flags.balance) + 1000n).toString() : flags.balance;
      return asset === token || native ? flags.intentBalance : '0';
    },
    code: async () => (flags.deployed ? '0x60006000' : '0x'),
    receipt: async (_chain, hash) => {
      calls.push('chainReceipt');
      if (flags.chainFailure) throw new Error('RPC down');
      return {
        hash,
        status: flags.chainReverted ? 'reverted' : 'success',
        blockNumber: '100',
        transfers: flags.recovered
          ? [
              {
                asset: token,
                from: recovery.intentAddress,
                to: owner,
                amount: flags.recoveredAmount
              }
            ]
          : [{ asset: token, from: owner, to: originIntent, amount: fixture.input.amount }]
      };
    }
  };
  const store = new MemorySwapStore();

  const create = (enabled = true, environment = 'default') =>
    createServerWalletInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc: {
          subject: 'customer-1',
          issuer: 'https://issuer.example',
          audience: 'oms-server-wallet',
          getIdToken: async () => ({
            token: `fixture-${crypto.randomUUID()}`,
            expiresAt: Math.floor(Date.now() / 1000) + 300
          })
        },
        storage: { encryptedStore: walletStore },
        executor,
        approval: 'allow-immediate',
        swaps: trailsInternal(
          {
            apiKey: 'fixture-trails-key',
            chains: { 137: 'https://polygon.rpc.example', 8453: 'https://base.rpc.example' },
            assets: fixture.assets,
            storage: { scope: 'wallet', adapter: store, encryptionKey: SWAP_ENCRYPTION_KEY },
            enabled,
            environment
          },
          { gateway, chains, clock: () => clock, onCodec: (codec) => (store.codec = codec) }
        )
      },
      { transport: remote, clock: () => clock }
    );

  let wallet = create();
  await wallet.createOrRestore();

  const quote = async (idempotencyKey = 'swap-test-0001') =>
    wallet.swaps.quote({ idempotencyKey, ...fixture.input });
  const confirm = async () => {
    const q = await quote();
    return wallet.swaps.confirm({ swapId: q.id, reviewId: q.quote.reviewId });
  };
  const tick = async (count = 1) => {
    for (let i = 0; i < count; i++) {
      clock += 5001;
      await wallet.swaps.tick();
    }
  };
  return {
    waas: { store: walletStore, remote, executor },
    fixture,
    flags,
    gateway,
    chains,
    store,
    calls,
    quote,
    confirm,
    tick,
    create,
    get wallet() {
      return wallet;
    },
    get swaps() {
      return wallet.swaps;
    },
    restart(enabled = true, environment = 'default') {
      wallet = create(enabled, environment);
    },
    get intent() {
      return intent;
    },
    set intent(v: TrailsIntent) {
      intent = v;
    },
    get receipt() {
      return receipt;
    },
    set receipt(v: TrailsReceipt) {
      receipt = v;
    },
    get recovery() {
      return recovery;
    },
    set recovery(v: PreparedRecovery) {
      recovery = v;
    },
    advance(ms: number) {
      clock += ms;
    },
    record: async () => (await store.getRecord('swap-test-0001'))!
  };
}
