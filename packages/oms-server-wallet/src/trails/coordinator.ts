import { zeroAddress } from 'viem';
import { z } from 'zod';

import type {
  BoundSwaps,
  CoordinatorGate,
  LockedEnginePrimitives,
  SwapsConfig
} from '../internal/swapsBridge.js';
import type { StoredEvmOperation } from '../state.js';
import type { ChainReader } from './chain.js';
import type { TrailsIntent, TrailsReceipt } from './protocol.js';
import type { SwapAsset } from './quote.js';
import type {
  ConfirmRecoveryInput,
  ConfirmSwapInput,
  ListSwapsOptions,
  NamespacedSwapStore,
  PrepareRecoveryInput,
  QuoteSwapInput,
  RecoveryRecord,
  ResolveSwapReconciliationInput,
  StoredSwapEntry,
  SwapGateway,
  SwapListPage,
  SwapRecord,
  SwapsFacet,
  SwapStore,
  SwapView,
  TickSwapsOptions,
  TickSwapsResult,
  TrailsOptions,
  TrailsStorageOption
} from './types.js';

import { sha256 } from '../encoding.js';
import { WalletError } from '../errors.js';
import { registerSwapsBinder } from '../internal/swapsBridge.js';
import { canonicalJson } from '../json.js';
import { isStaleExpiryRead } from '../settlement.js';
import { NamespaceCipher } from '../storage.js';
import { parseOrThrow } from '../validation.js';
import { EvmChainReader } from './chain.js';
import { TrailsClient, TrailsError } from './client.js';
import { recoveryTokenSchema } from './protocol.js';
import { buildSwapRequest, tokenAddress, validateSwapQuote } from './quote.js';
import { recoveryAuthorization } from './recovery-authorization.js';
import { validateRecoveryTransaction } from './recovery-transaction.js';
import { validateRecoveryPayload } from './recovery.js';
import { swapView } from './view.js';

const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,100}$/)
  .refine((id) => !id.startsWith('swp_'));
const uncertain = (op?: StoredEvmOperation) =>
  !!op && ['submitting', 'pending', 'unknown'].includes(op.status);
const terminalUpstream = new Set(['FAILED', 'ABORTED', 'INVALID', 'REFUNDED', 'SUCCEEDED']);
const emptyCode = (code: string) => /^0x0*$/.test(code);
const errorCode = (error: unknown) =>
  error instanceof WalletError ? error.code : 'SWAP_UNAVAILABLE';

function validateId(id: unknown): string {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success)
    throw new WalletError(
      'INVALID_IDEMPOTENCY_KEY',
      'An operation ID of 8–100 letters, digits, underscores or hyphens is required (and must not start with "swp_").'
    );
  return parsed.data;
}

const integrity = (message: string) => new WalletError('STORAGE_INTEGRITY', message, 500);

/**
 * Seals swap records into `StoredSwapEntry` payloads. The AAD binds the wallet namespace and every
 * metadata field the host stores beside the payload, so editing, swapping or relabelling an entry
 * fails closed. Replaying an older authentic entry is not detectable here.
 */
export class SwapRecordCodec {
  private readonly cipher: NamespaceCipher;
  constructor(
    encryptionKey: string,
    private readonly namespace: string
  ) {
    this.cipher = new NamespaceCipher(encryptionKey, 'trails-swap', namespace);
  }

  private aad(entry: Omit<StoredSwapEntry, 'payload'>): string {
    return JSON.stringify([
      'oms-server-wallet:trails-swap:v1',
      this.namespace,
      entry.id,
      entry.intentId,
      entry.version,
      entry.active,
      entry.nextAt,
      entry.createdAt,
      entry.reservedChainId
    ]);
  }

  async encode(record: SwapRecord, reservedChainId: number | null): Promise<StoredSwapEntry> {
    const metadata = {
      id: record.id,
      intentId: record.quote.intent.intentId,
      version: record.version,
      active: record.action !== null,
      nextAt: record.nextAt,
      createdAt: record.createdAt,
      reservedChainId
    };
    return {
      ...metadata,
      payload: await this.cipher.seal(JSON.stringify(record), this.aad(metadata))
    };
  }

  /** Decode an entry; `expectedId` is the ID it was looked up by, when there was one. */
  async decode(entry: StoredSwapEntry, expectedId?: string): Promise<SwapRecord> {
    if (!entry || typeof entry !== 'object' || typeof entry.payload !== 'string')
      throw integrity('Stored swap entry is malformed.');
    if (expectedId !== undefined && entry.id !== expectedId)
      throw integrity('The swap store returned an entry for a different swap ID.');
    const plain = await this.cipher.open(entry.payload, this.aad(entry));
    if (plain === null)
      throw integrity(
        'Stored swap entry failed authentication (wrong encryption key, other wallet, or edited entry).'
      );
    const candidate = JSON.parse(plain) as Partial<SwapRecord> | null;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      candidate.id !== entry.id ||
      candidate.version !== entry.version ||
      typeof candidate.owner !== 'string' ||
      typeof candidate.requestHash !== 'string' ||
      candidate.quote?.intent?.intentId !== entry.intentId
    )
      throw new WalletError(
        'STORAGE_INTEGRITY',
        'Stored swap entry payload is not in a recognised format.',
        500
      );
    return candidate as SwapRecord;
  }
}

/** A fresh internal operation ID for a retried step: `<base>_r<n>`. */
function retryId(id: string): string {
  const match = /^(.*)_r([0-9]+)$/.exec(id);
  return match ? `${match[1]}_r${Number(match[2]) + 1}` : `${id}_r1`;
}

const credentialChanged = (error: unknown) =>
  error instanceof WalletError && error.code === 'CREDENTIAL_CHANGED';
const swapConflict = (error: unknown) =>
  error instanceof WalletError && error.code === 'SWAP_CONFLICT';

function scopeSwapStore(store: NamespacedSwapStore, namespace: string): SwapStore {
  return {
    get: (id) => store.get(namespace, id),
    findIntent: (intentId) => store.findIntent(namespace, intentId),
    save: (entry, options) => store.save(namespace, entry, options),
    list: (options) => store.list(namespace, options)
  };
}

export interface CoordinatorConfig {
  readonly primitives: LockedEnginePrimitives;
  readonly trails: SwapGateway;
  readonly chains: ChainReader;
  readonly store: SwapStore;
  readonly codec: SwapRecordCodec;
  readonly assets: readonly SwapAsset[];
  readonly enabled: boolean;
  readonly environment: string;
  readonly clock: () => number;
}

/**
 * Internal durable Trails coordinator bound to ONE identity executor and ONE submission gate.
 * Never reacquires the executor or invokes public wallet facade methods.
 */
export class TrailsCoordinator {
  private readonly now: () => number;
  constructor(private readonly config: CoordinatorConfig) {
    this.now = config.clock;
  }

  gate(): CoordinatorGate {
    return {
      assertChainAvailableLocked: (chainId, options) =>
        this.availableLocked(
          chainId,
          undefined,
          options?.exceptOperationId ? [options.exceptOperationId] : []
        )
    };
  }

  facet(): SwapsFacet {
    return Object.freeze({
      quote: (input: QuoteSwapInput) => this.quoteSwap(input),
      confirm: (input: ConfirmSwapInput) => this.confirmSwap(input),
      get: (swapId: string) => this.getSwap(swapId),
      list: (options?: ListSwapsOptions) => this.listSwaps(options),
      reconcile: (swapId: string) => this.reconcileSwap(swapId),
      tick: (options?: TickSwapsOptions) => this.tick(options?.limit),
      prepareRecovery: (input: PrepareRecoveryInput) => this.prepareRecovery(input),
      confirmRecovery: (input: ConfirmRecoveryInput) => this.confirmRecovery(input),
      resolveReconciliation: (input: ResolveSwapReconciliationInput) =>
        this.resolveReconciliation(input)
    });
  }

  private async enabledLocked(recovery = false): Promise<string> {
    if (!recovery && !this.config.enabled)
      throw new WalletError('SWAPS_DISABLED', 'New swap transactions are disabled.', 409);
    const snapshot = await this.config.primitives.inspectLocked();
    if (snapshot.disabled)
      throw new WalletError('WALLET_DISABLED', 'This wallet is disabled.', 409);
    if (!snapshot.wallet)
      throw new WalletError(
        'WALLET_NOT_INITIALIZED',
        'Swaps need the EVM wallet: create or restore it first.',
        409
      );
    return snapshot.wallet.address.toLowerCase();
  }

  private async assertRecordOwnerLocked(record: SwapRecord): Promise<void> {
    const snapshot = await this.config.primitives.inspectLocked();
    if (!snapshot.wallet || snapshot.wallet.address.toLowerCase() !== record.owner)
      throw new WalletError('WALLET_MISMATCH', 'Swap belongs to another wallet.', 409);
  }

  private async loadRecordLocked(id: string): Promise<SwapRecord> {
    validateId(id);
    const entry = await this.config.store.get(id);
    if (!entry) throw new WalletError('NOT_FOUND', 'Swap not found.', 404);
    const record = await this.config.codec.decode(entry, id);
    this.checkEnvironment(record);
    await this.assertRecordOwnerLocked(record);
    return record;
  }

  private checkEnvironment(record: SwapRecord) {
    if (record.environment !== this.config.environment)
      throw new WalletError(
        'SWAP_ENVIRONMENT_CHANGED',
        'Restore the original Trails endpoint/project before reconciling this swap.',
        409
      );
  }

  /**
   * Compare-and-set the record at the version it was read at. Throws `SWAP_CONFLICT` if another
   * worker saved first (the caller stops: the other worker owns this step), and
   * `INTENT_ALREADY_TRACKED` if inserting would track an intent twice. The chain the swap holds
   * is saved with the record, so taking and releasing a hold is part of the same write.
   */
  private async saveLocked(record: SwapRecord, delay: number | null = record.action ? 5000 : null) {
    const expectedVersion = record.version;
    record.version++;
    record.updatedAt = new Date(this.now()).toISOString();
    record.nextAt = delay === null ? null : this.now() + delay;
    const result: unknown = await this.config.store.save(
      await this.config.codec.encode(record, this.reservedChain(record) ?? null),
      { expectedVersion }
    );
    if (result === 'saved') return;
    record.version = expectedVersion;
    if (result === 'conflict')
      throw new WalletError(
        'SWAP_CONFLICT',
        'Another worker updated this swap first. Read it again.',
        409
      );
    if (result === 'intent-taken')
      throw new WalletError(
        'INTENT_ALREADY_TRACKED',
        'This intent is already tracked by another swap. Open its existing activity.',
        409
      );
    throw new WalletError(
      'CONFIGURATION',
      "SwapStore.save must return 'saved', 'conflict' or 'intent-taken'.",
      503
    );
  }

  /** Give this wallet store the swap's internal operations it lacks, from the record's copies. */
  private async adoptLocked(record: SwapRecord): Promise<void> {
    const recovery = this.currentRecovery(record, false);
    const copies = [record.funding, recovery?.deployment, recovery?.transaction].filter(
      (op): op is StoredEvmOperation => !!op
    );
    if (copies.length) await this.config.primitives.adoptEvmOperationsLocked(copies);
  }

  private async activeRecordsLocked(): Promise<SwapRecord[]> {
    const entries = await this.config.store.list({ active: true, limit: 1001 });
    if (entries.length > 1000)
      throw new WalletError('WALLET_BUSY', 'Too many unresolved wallet operations.', 409);
    const records = await Promise.all(entries.map((e) => this.config.codec.decode(e)));
    if (records.length > 0) {
      const snapshot = await this.config.primitives.inspectLocked();
      const owner = snapshot.wallet?.address.toLowerCase();
      for (const record of records) {
        if (!owner || owner !== record.owner)
          throw new WalletError('WALLET_MISMATCH', 'Swap belongs to another wallet.', 409);
      }
    }
    return records;
  }

  private reservedChain(record: SwapRecord): number | undefined {
    const recovery = record.recoveries.find((r) => r.id === record.activeRecoveryId);
    if (recovery) return recovery.chainId;
    if (
      uncertain(record.funding) ||
      (record.confirmedAt &&
        !record.fundingConfirmed &&
        ['prepare-funding', 'activate', 'fund'].includes(record.action ?? '') &&
        !['failed', 'expired'].includes(record.phase))
    )
      return record.request.originChainId;
    return undefined;
  }

  private async availableLocked(
    chainId: number,
    exceptSwap?: string,
    exceptOperations: readonly string[] = []
  ): Promise<void> {
    for (const record of await this.activeRecordsLocked()) {
      if (record.id !== exceptSwap && this.reservedChain(record) === chainId)
        throw new WalletError(
          'DEBIT_PENDING',
          `Another debit on chain ${chainId} (swap "${record.id}") must be reconciled first.`,
          409
        );
    }
    const disabled = (await this.config.primitives.inspectLocked()).disabled;
    const operations = await this.config.primitives.listOpenEvmOperationsLocked();
    for (let operation of operations) {
      if (
        operation.chainId !== chainId ||
        exceptOperations.includes(operation.id) ||
        !uncertain(operation) ||
        !['transfer', 'call', 'deployment', 'recovery'].includes(operation.kind)
      )
        continue;
      if (!disabled) {
        try {
          operation =
            (await this.config.primitives.refreshEvmOperationLocked(operation.id)) ?? operation;
        } catch (error) {
          // A stale TransactionExpired read inside the grace window leaves the debit uncertain.
          if (!isStaleExpiryRead(error)) throw error;
        }
      }
      if (uncertain(operation))
        throw new WalletError(
          'DEBIT_PENDING',
          'A previous wallet transaction has an uncertain or pending debit.',
          409
        );
    }
  }

  private async quoteSwap(input: QuoteSwapInput): Promise<SwapView> {
    if (!input || typeof input !== 'object')
      throw new WalletError('INVALID_SWAP', 'Provide swap quote parameters.');
    // Snapshot caller fields synchronously before waiting on the executor.
    const id = validateId(input.idempotencyKey);
    const swapInput = {
      originChainId: input.originChainId,
      originAsset: input.originAsset,
      destinationChainId: input.destinationChainId,
      destinationAsset: input.destinationAsset,
      amount: input.amount,
      ...(input.slippageBps !== undefined ? { slippageBps: input.slippageBps } : {})
    };
    return this.config.primitives.runLocked(async () => {
      const owner = await this.enabledLocked();
      const request = buildSwapRequest(owner, swapInput, this.config.assets);
      const requestHash = await sha256(canonicalJson(request));
      const existingEntry = await this.config.store.get(id);
      if (existingEntry) {
        const existing = await this.config.codec.decode(existingEntry, id);
        if (existing.requestHash !== requestHash || existing.owner !== owner)
          throw new WalletError(
            'IDEMPOTENCY_CONFLICT',
            'Swap ID was already used with different input.',
            409
          );
        return swapView(existing);
      }
      const { TrailsContracts } = await this.config.trails.readiness();
      const { intent } = await this.config.trails.quoteIntent(
        request as unknown as Record<string, unknown>
      );
      const quote = await validateSwapQuote(intent, request, TrailsContracts, this.now());
      const previous = await this.config.store.findIntent(intent.intentId);
      if (previous && previous !== id) {
        // The intent index is host data: only an authentic record for that intent may block.
        const entry = await this.config.store.get(validateId(previous));
        const tracked = entry ? await this.config.codec.decode(entry, previous) : undefined;
        if (tracked?.quote.intent.intentId !== intent.intentId)
          throw integrity('The swap store intent index points at a record for another intent.');
        throw new WalletError(
          'INTENT_ALREADY_TRACKED',
          'This intent is already tracked by another swap. Open its existing activity.',
          409
        );
      }
      const timestamp = new Date(this.now()).toISOString();
      const metadata = (chainId: number, token: string) => {
        const asset = this.config.assets.find(
          (a) => a.chainId === chainId && tokenAddress(a.asset) === token
        )!;
        return {
          decimals: asset.decimals,
          ...(asset.symbol ? { symbol: asset.symbol.slice(0, 32) } : {})
        };
      };
      const record: SwapRecord = {
        id,
        version: 0,
        requestHash,
        owner,
        environment: this.config.environment,
        assetMetadata: {
          origin: metadata(request.originChainId, request.originTokenAddress),
          destination: metadata(request.destinationChainId, request.destinationTokenAddress)
        },
        request: {
          originChainId: request.originChainId,
          originAsset:
            request.originTokenAddress === zeroAddress ? 'native' : request.originTokenAddress,
          destinationChainId: request.destinationChainId,
          destinationAsset:
            request.destinationTokenAddress === zeroAddress
              ? 'native'
              : request.destinationTokenAddress,
          amount: request.originTokenAmount,
          slippageBps: Math.round(request.options.slippageTolerance * 10000) as 10 | 50 | 100
        },
        quote,
        phase: 'quoted',
        action: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        nextAt: null,
        attempts: 0,
        fundingId: `swp_fund_${await sha256(id)}`,
        fundingConfirmed: false,
        recoveries: []
      };
      try {
        await this.saveLocked(record, null);
      } catch (error) {
        if (!swapConflict(error)) throw error;
        // Another worker inserted this swap ID first: the same request returns its swap.
        const raced = await this.loadRecordLocked(id);
        if (raced.requestHash !== requestHash)
          throw new WalletError(
            'IDEMPOTENCY_CONFLICT',
            'Swap ID was already used with different input.',
            409
          );
        return swapView(raced);
      }
      return swapView(record);
    });
  }

  /**
   * Check that the stored quote digest and funding transfer agree with the stored request and
   * intent. A consistency check against corrupted or partially written records: the digest is an
   * unkeyed hash, so it does not authenticate records that a writer to the SwapStore rewrites
   * consistently. The caller's `reviewId` is bound to the digest only at `confirm`.
   */
  private async verifyStoredQuoteIntegrity(record: SwapRecord): Promise<void> {
    const request = buildSwapRequest(record.owner, record.request, this.config.assets);
    const expectedDigest = await sha256(canonicalJson({ request, intent: record.quote.intent }));
    const deposit = record.quote.intent.depositTransaction;
    const native = request.originTokenAddress === zeroAddress;
    const expectedAsset = native ? 'native' : request.originTokenAddress;
    const funding = record.quote.funding;
    if (
      expectedDigest !== record.quote.digest ||
      funding.chainId !== request.originChainId ||
      funding.to.toLowerCase() !== record.quote.intent.originIntentAddress.toLowerCase() ||
      funding.to.toLowerCase() !== deposit.toAddress.toLowerCase() ||
      tokenAddress(funding.asset) !== tokenAddress(expectedAsset) ||
      funding.amount !== request.originTokenAmount ||
      funding.amount !== deposit.amount
    )
      throw new WalletError(
        'STORAGE_INTEGRITY',
        'Stored swap quote payload failed integrity verification.',
        500
      );
  }

  private async confirmSwap(input: ConfirmSwapInput): Promise<SwapView> {
    if (!input || typeof input !== 'object')
      throw new WalletError('STALE_QUOTE', 'Provide swapId and reviewId to confirm.', 409);
    // Snapshot approval IDs synchronously so mutating the caller's object while queued cannot
    // approve a different swap or revision.
    const swapId = input.swapId;
    const reviewId = input.reviewId;
    return this.config.primitives.runLocked(async () => {
      const record = await this.loadRecordLocked(swapId);
      await this.verifyStoredQuoteIntegrity(record);
      if (record.quote.digest !== reviewId)
        throw new WalletError('STALE_QUOTE', 'Review the current quote before confirming.', 409);
      if (record.confirmedAt) return swapView(record);
      await this.enabledLocked();
      if (record.phase !== 'quoted' || this.expired(record))
        throw new WalletError('QUOTE_EXPIRED', 'Request and review a new quote.', 409);
      await this.availableLocked(record.request.originChainId, record.id);
      await this.funds(record);
      // Persist coordination marker in wallet state before authorizing the first swap debit.
      await this.config.primitives.markSwapsCoordinatedLocked();
      record.confirmedAt = new Date(this.now()).toISOString();
      record.phase = 'preparing';
      record.action = 'prepare-funding';
      await this.saveLocked(record, 0);
      return swapView(record);
    });
  }

  private getSwap(swapId: string): Promise<SwapView> {
    return this.config.primitives.runLocked(async () => {
      const record = await this.loadRecordLocked(swapId);
      if (record.phase === 'quoted' && this.expired(record)) {
        record.phase = 'expired';
        await this.saveLocked(record);
      }
      return swapView(record);
    });
  }

  private async listSwaps(options: ListSwapsOptions = {}): Promise<SwapListPage> {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new WalletError('INVALID_PAGE', 'limit must be an integer between 1 and 100.');
    let offset = 0;
    if (options.cursor !== undefined) {
      if (typeof options.cursor !== 'string' || !/^[0-9]{1,6}$/.test(options.cursor))
        throw new WalletError('INVALID_PAGE', 'Invalid pagination cursor.');
      offset = Number(options.cursor);
    }
    return this.config.primitives.runLocked(async () => {
      const entries = await this.config.store.list({ offset, limit: limit + 1 });
      const hasMore = entries.length > limit;
      const records = await Promise.all(
        entries.slice(0, limit).map((e) => this.config.codec.decode(e))
      );
      for (const record of records) {
        this.checkEnvironment(record);
        await this.assertRecordOwnerLocked(record);
      }
      const items = records.map(swapView);
      return {
        items,
        ...(hasMore ? { nextCursor: String(offset + limit) } : {})
      };
    });
  }

  private reconcileSwap(swapId: string): Promise<SwapView> {
    return this.config.primitives.runLocked(async () => {
      const record = await this.loadRecordLocked(swapId);
      if (record.action && (record.nextAt ?? 0) <= this.now()) await this.advanceLocked(record);
      return swapView(record);
    });
  }

  private tick(limit = 3): Promise<TickSwapsResult> {
    return this.config.primitives.runLocked(async () => {
      const active = await this.activeRecordsLocked();
      const due = active
        .filter((r) => r.action && (r.nextAt ?? 0) <= this.now())
        .sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0));
      for (const record of due.slice(0, Math.max(1, Math.min(limit, 10)))) {
        try {
          await this.advanceLocked(record);
        } catch (error) {
          // Another worker advanced this swap first; it owns the step.
          if (!swapConflict(error)) throw error;
        }
      }

      const remaining = await this.activeRecordsLocked();
      let nextAt: number | null = null;
      for (const record of remaining) {
        if (record.nextAt !== null && (nextAt === null || record.nextAt < nextAt))
          nextAt = record.nextAt;
      }
      return { nextAt };
    });
  }

  private async resolveReconciliation(input: ResolveSwapReconciliationInput): Promise<SwapView> {
    if (!input || typeof input !== 'object')
      throw new WalletError(
        'INVALID_INPUT',
        'Provide swapId, txnId, and resolution: "not-broadcast".'
      );
    const swapId = validateId(input.swapId);
    const txnId = input.txnId;
    const resolution = input.resolution;
    if (typeof txnId !== 'string' || !txnId.trim() || resolution !== 'not-broadcast')
      throw new WalletError(
        'INVALID_INPUT',
        'Provide a valid txnId and resolution: "not-broadcast".'
      );
    return this.config.primitives.runLocked(async () => {
      const record = await this.loadRecordLocked(swapId);
      await this.adoptLocked(record);
      // Case 1: funding transaction in RECONCILIATION_REQUIRED
      if (record.funding?.quote?.txnId === txnId) {
        record.funding = await this.config.primitives.resolveEvmReconciliationLocked(
          record.fundingId,
          txnId
        );
        if (record.funding.status === 'expired' && record.funding.operatorResolved === true) {
          record.phase = 'expired';
          record.action = null;
          record.error = 'QUOTE_EXPIRED';
        }
        await this.saveLocked(record);
        return swapView(record);
      }
      // Case 2: active recovery deployment or transaction in RECONCILIATION_REQUIRED
      const recovery = this.currentRecovery(record, false);
      if (recovery && recovery.deployment?.quote?.txnId === txnId) {
        recovery.deployment = await this.config.primitives.resolveEvmReconciliationLocked(
          recovery.deploymentId,
          txnId
        );
        if (
          recovery.deployment.status === 'expired' &&
          recovery.deployment.operatorResolved === true
        ) {
          recovery.status = 'expired';
          recovery.error = 'RECOVERY_EXPIRED';
          record.activeRecoveryId = undefined;
          record.phase = 'attention';
          record.action = 'observe';
          record.error = 'RECOVERY_EXPIRED';
        }
        await this.saveLocked(record);
        return swapView(record);
      }
      if (recovery && recovery.transaction?.quote?.txnId === txnId) {
        recovery.transaction = await this.config.primitives.resolveEvmReconciliationLocked(
          recovery.transactionId,
          txnId
        );
        if (
          recovery.transaction.status === 'expired' &&
          recovery.transaction.operatorResolved === true
        ) {
          recovery.status = 'expired';
          recovery.error = 'RECOVERY_EXPIRED';
          record.activeRecoveryId = undefined;
          record.phase = 'attention';
          record.action = 'observe';
          record.error = 'RECOVERY_EXPIRED';
        }
        await this.saveLocked(record);
        return swapView(record);
      }
      throw new WalletError(
        'NOT_FOUND',
        'No funding or active recovery operation matches that txnId.',
        404
      );
    });
  }

  private expired(record: SwapRecord): boolean {
    return Date.parse(record.quote.expiresAt) <= this.now() + 30_000;
  }

  private async funds(record: SwapRecord): Promise<void> {
    const amount = await this.config.chains.balance(
      record.request.originChainId,
      record.owner,
      record.request.originAsset
    );
    if (BigInt(amount) < BigInt(record.quote.funding.amount))
      throw new WalletError(
        'INSUFFICIENT_BALANCE',
        'Current on-chain balance is below the reviewed input amount.',
        409
      );
  }

  private async advanceLocked(record: SwapRecord): Promise<void> {
    // Validate wallet ownership before any state write or remote call (even before error catch/save).
    await this.assertRecordOwnerLocked(record);
    try {
      this.checkEnvironment(record);
      await this.adoptLocked(record);
      if (['prepare-funding', 'activate', 'fund'].includes(record.action ?? '')) {
        record.funding =
          (await this.config.primitives.readEvmOperationsLocked([record.fundingId])).find(
            (op) => op.id === record.fundingId
          ) ?? record.funding;
        if (uncertain(record.funding) || record.funding?.status === 'executed')
          record.action = 'fund';
      }
      const recovery = this.currentRecovery(record, false);
      if (recovery) {
        const children = await this.config.primitives.readEvmOperationsLocked([
          recovery.deploymentId,
          recovery.transactionId
        ]);
        recovery.deployment =
          children.find((op) => op.id === recovery.deploymentId) ?? recovery.deployment;
        recovery.transaction =
          children.find((op) => op.id === recovery.transactionId) ?? recovery.transaction;
        if (
          uncertain(recovery.deployment) &&
          !(await this.config.primitives.inspectLocked()).disabled
        )
          recovery.deployment =
            (await this.config.primitives.refreshEvmOperationLocked(recovery.deploymentId)) ??
            recovery.deployment;
        if (uncertain(recovery.transaction) || recovery.transaction?.status === 'executed')
          record.action = 'observe-recovery';
      }
      if (
        ['prepare-funding', 'activate', 'fund'].includes(record.action ?? '') &&
        !uncertain(record.funding) &&
        record.funding?.status !== 'executed' &&
        this.expired(record)
      ) {
        record.phase = 'expired';
        record.action = null;
        record.error = 'QUOTE_EXPIRED';
        await this.saveLocked(record);
        return;
      }
      switch (record.action) {
        case 'prepare-funding': {
          await this.enabledLocked();
          await this.verifyStoredQuoteIntegrity(record);
          await this.availableLocked(record.request.originChainId, record.id, [record.fundingId]);
          await this.funds(record);
          await this.saveLocked(record);
          record.funding = await this.config.primitives.prepareEvmTransferLocked(
            record.fundingId,
            record.quote.funding,
            { allowSwapsPrefix: true, skipGate: true }
          );
          this.sponsored(record.funding);
          record.phase = 'activating';
          record.action = 'activate';
          break;
        }
        case 'activate':
          await this.activateLocked(record);
          break;
        case 'fund':
          await this.fundLocked(record);
          break;
        case 'observe':
          await this.observeLocked(record);
          break;
        case 'deploy-owner':
          await this.deployOwnerLocked(record);
          break;
        case 'sign-recovery':
          await this.signRecoveryLocked(record);
          break;
        case 'build-recovery':
          await this.buildRecoveryLocked(record);
          break;
        case 'submit-recovery':
          await this.submitRecoveryLocked(record);
          break;
        case 'observe-recovery':
          await this.observeRecoveryLocked(record);
          break;
      }
      record.attempts = 0;
      if (!['attention', 'failed', 'expired'].includes(record.phase)) record.error = undefined;
      await this.saveLocked(
        record,
        record.action ? (record.phase === 'attention' ? 30_000 : 5000) : null
      );
    } catch (error) {
      if (swapConflict(error)) throw error;
      record.attempts++;
      record.error = errorCode(error);
      const recovery = this.currentRecovery(record, false);
      if (
        [
          'SPONSORSHIP_REQUIRED',
          'QUOTE_EXPIRED',
          'RECOVERY_EXPIRED',
          'INVALID_RECOVERY',
          'INVALID_RECOVERY_TRANSACTION',
          'RECOVERY_CHANGED',
          'SIGNATURE_INVALID'
        ].includes(record.error)
      ) {
        if (recovery && !uncertain(recovery.transaction) && !uncertain(recovery.deployment)) {
          recovery.status = 'failed';
          recovery.error = record.error;
          record.activeRecoveryId = undefined;
          record.phase = 'attention';
          record.action = 'observe';
        } else if (!recovery && !record.fundingConfirmed && !uncertain(record.funding)) {
          record.phase = 'failed';
          record.action = null;
        }
      }
      await this.saveLocked(
        record,
        record.action ? Math.min(300_000, 5000 * 2 ** Math.min(record.attempts, 6)) : null
      );
    }
  }

  private sponsored(op: StoredEvmOperation) {
    if (op.status !== 'quoted' || !op.quote?.sponsored)
      throw new WalletError(
        'SPONSORSHIP_REQUIRED',
        'A sponsored prepared transaction is required.',
        409
      );
    if (Date.parse(op.quote.expiresAt) <= this.now() + 30_000)
      throw new WalletError('QUOTE_EXPIRED', 'Prepared transaction expires too soon.', 409);
  }

  private identity(record: SwapRecord, intent: TrailsIntent) {
    const original = record.quote.intent;
    for (const key of [
      'intentId',
      'ownerAddress',
      'originChainId',
      'destinationChainId',
      'originTokenAddress',
      'destinationTokenAddress',
      'originIntentAddress',
      'destinationIntentAddress'
    ] as const) {
      if (intent[key] !== original[key])
        throw new WalletError(
          'INVALID_RESPONSE',
          'Trails returned a different intent context.',
          502
        );
    }
  }

  private async receipt(record: SwapRecord): Promise<TrailsReceipt | undefined> {
    try {
      const { intentReceipt } = await this.config.trails.getIntentReceipt(
        record.quote.intent.intentId
      );
      const original = record.quote.intent;
      if (
        intentReceipt.intentId !== original.intentId ||
        intentReceipt.ownerAddress !== record.owner ||
        intentReceipt.originChainId !== record.request.originChainId ||
        intentReceipt.destinationChainId !== record.request.destinationChainId ||
        intentReceipt.summary.originIntentAddress !== original.originIntentAddress ||
        intentReceipt.summary.destinationIntentAddress !==
          (original.destinationIntentAddress ?? original.originIntentAddress)
      )
        throw new WalletError(
          'INVALID_RESPONSE',
          'Receipt does not belong to the reviewed intent.',
          502
        );
      record.receipt = intentReceipt;
      return intentReceipt;
    } catch (error) {
      if (error instanceof TrailsError && (error.httpStatus === 404 || error.upstreamCode === 8000))
        return undefined;
      throw error;
    }
  }

  private acceptsFunding(record: SwapRecord, receipt?: TrailsReceipt) {
    const deposit = receipt?.depositTransaction;
    return (
      receipt?.status === 'EXECUTING' &&
      !!deposit &&
      ['PENDING', 'MINING', 'SENT', 'RELAYING', 'ON_HOLD'].includes(deposit.status) &&
      deposit.intentId === record.quote.intent.intentId &&
      deposit.chainId === record.request.originChainId &&
      deposit.fromAddress === record.owner &&
      deposit.toAddress === record.quote.intent.originIntentAddress &&
      tokenAddress(deposit.tokenAddress) === tokenAddress(record.request.originAsset) &&
      deposit.tokenAmount === record.quote.funding.amount
    );
  }

  private async activateLocked(record: SwapRecord) {
    await this.enabledLocked();
    this.sponsored(record.funding!);
    const { intent } = await this.config.trails.getIntent(record.quote.intent.intentId);
    this.identity(record, intent);
    record.upstreamStatus = intent.status;
    if (intent.status === 'QUOTED') {
      await this.saveLocked(record);
      await this.config.trails.executeIntent(intent.intentId);
      return;
    }
    const receipt = await this.receipt(record);
    if (this.acceptsFunding(record, receipt)) {
      record.phase = 'funding';
      record.action = 'fund';
      return;
    }
    if (terminalUpstream.has(intent.status)) {
      record.phase = 'failed';
      record.action = null;
      record.error = 'INTENT_NOT_FUNDABLE';
    }
  }

  private async fundLocked(record: SwapRecord) {
    const disabled = (await this.config.primitives.inspectLocked()).disabled;
    record.funding = disabled
      ? (await this.config.primitives.readEvmOperationsLocked([record.fundingId])).find(
          (op) => op.id === record.fundingId
        )
      : ((await this.config.primitives.refreshEvmOperationLocked(record.fundingId)) ??
        record.funding);
    if (!record.funding)
      throw new WalletError(
        'FUNDING_UNKNOWN',
        'Funding operation is missing; reconcile before proceeding.',
        409
      );
    if (record.funding.status === 'quoted') {
      await this.enabledLocked();
      this.sponsored(record.funding);
      await this.availableLocked(record.request.originChainId, record.id, [record.fundingId]);
      await this.funds(record);
      const receipt = await this.receipt(record);
      if (!this.acceptsFunding(record, receipt)) {
        if (receipt && terminalUpstream.has(receipt.status)) {
          record.phase = 'failed';
          record.action = null;
          record.error = 'INTENT_NOT_FUNDABLE';
        }
        return;
      }
      // Journal the submission before Execute, so a worker that takes over polls this txnId
      // instead of preparing a second funding transfer.
      const quoted = record.funding;
      record.funding = { ...quoted, status: 'submitting', submitted: true };
      await this.saveLocked(record);
      try {
        record.funding = await this.config.primitives.executeEvmOperationLocked(
          record.fundingId,
          ['transfer'],
          { skipGate: true, bypassReviewId: true }
        );
      } catch (error) {
        if (credentialChanged(error)) {
          // Only the credential that prepared it can execute it, and that one is gone: nothing
          // was sent, so prepare the funding again under a new ID.
          record.fundingId = retryId(record.fundingId);
          record.funding = undefined;
          record.phase = 'preparing';
          record.action = 'prepare-funding';
          return;
        }
        if (!(error instanceof WalletError) || error.code !== 'QUOTE_EXPIRED') throw error;
        record.funding =
          (await this.config.primitives.readEvmOperationsLocked([record.fundingId])).find(
            (op) => op.id === record.fundingId
          ) ?? quoted;
      }
    }
    if (record.funding.status === 'executed' && record.funding.txnHash) {
      const receipt = await this.config.chains.receipt(
        record.request.originChainId,
        record.funding.txnHash
      );
      if (receipt?.status === 'success') {
        if (record.request.originAsset !== 'native') {
          const received = receipt.transfers
            .filter(
              (t) =>
                tokenAddress(t.asset) === tokenAddress(record.request.originAsset) &&
                t.from === record.owner &&
                t.to === record.quote.intent.originIntentAddress
            )
            .reduce((sum, t) => sum + BigInt(t.amount), 0n);
          if (received !== BigInt(record.quote.funding.amount))
            throw new WalletError(
              'FUNDING_RECEIPT_UNVERIFIED',
              'The token receipt does not prove the exact reviewed deposit.',
              409
            );
        }
        record.fundingConfirmed = true;
        record.phase = 'settling';
        record.action = 'observe';
      } else if (receipt?.status === 'reverted') {
        record.phase = 'attention';
        record.action = 'observe';
        record.error = 'FUNDING_REVERTED';
      }
    } else if (record.funding.status === 'failed') {
      record.phase = 'attention';
      record.action = 'observe';
      record.error = 'FUNDING_FAILED';
    } else if (record.funding.status === 'expired' && record.funding.preSubmitExpired === true) {
      // Only a proven pre-submit local quote expiry releases the swap & origin reservation.
      record.phase = 'expired';
      record.action = null;
      record.error = 'QUOTE_EXPIRED';
    } else if (uncertain(record.funding)) {
      if (record.funding.error === 'RECONCILIATION_REQUIRED') {
        record.phase = 'attention';
        record.action = 'fund';
        record.error = 'RECONCILIATION_REQUIRED';
      } else {
        record.phase = 'funding';
      }
    }
  }

  private async observeLocked(record: SwapRecord) {
    const { intent } = await this.config.trails.getIntent(record.quote.intent.intentId);
    this.identity(record, intent);
    record.upstreamStatus = intent.status;
    const receipt = await this.receipt(record);
    if (!receipt) return;
    await this.repairDepositLocked(record, intent, receipt);
    if (receipt.status === 'SUCCEEDED') {
      if (
        !record.fundingConfirmed ||
        receipt.summary.destinationToAddress !== record.owner ||
        receipt.summary.destinationTokenAddress !== tokenAddress(record.request.destinationAsset) ||
        !receipt.summary.destinationTokenAmount ||
        BigInt(receipt.summary.destinationTokenAmount) <
          BigInt(record.quote.intent.quote.toAmountMin)
      ) {
        record.phase = 'attention';
        record.error = 'SETTLEMENT_REQUIRES_REVIEW';
        return;
      }
      record.phase = 'succeeded';
      record.outcomeEvidence = 'provider-reported';
      record.action = null;
    } else if (receipt.status === 'REFUNDED') {
      const refund = receipt.refundTransaction;
      if (
        !refund ||
        refund.status !== 'SUCCEEDED' ||
        refund.toAddress !== record.owner ||
        ![record.request.originChainId, record.request.destinationChainId].includes(refund.chainId)
      ) {
        record.phase = 'attention';
        record.error = 'REFUND_REQUIRES_REVIEW';
        return;
      }
      record.phase = 'refunded';
      record.outcomeEvidence = 'provider-reported';
      record.action = null;
    } else if (terminalUpstream.has(receipt.status)) {
      record.phase = 'attention';
      record.error = `TRAILS_${receipt.status}`;
    } else if (record.fundingConfirmed) record.phase = 'settling';
  }

  private async repairDepositLocked(
    record: SwapRecord,
    intent: TrailsIntent,
    receipt: TrailsReceipt
  ) {
    const failed = ['FAILED', 'ABORTED', 'REVERTED'];
    const deposit = receipt.depositTransaction;
    if (
      !record.fundingConfirmed ||
      !record.funding?.txnHash ||
      record.activeRecoveryId ||
      !this.config.enabled ||
      !['EXECUTING', 'INVALID', 'ABORTED'].includes(intent.status) ||
      !deposit ||
      !failed.includes(deposit.status) ||
      (record.repairAttemptedAt && this.now() - Date.parse(record.repairAttemptedAt) < 120_000)
    )
      return;
    for (const dependent of [receipt.originTransaction, receipt.destinationTransaction]) {
      if (!dependent || dependent.status === 'ON_HOLD') continue;
      const reason =
        typeof dependent.statusReason === 'string' ? dependent.statusReason.toLowerCase() : '';
      if (
        !failed.includes(dependent.status) ||
        (!reason.startsWith('deposit transaction') && !reason.startsWith('aborted: deposit'))
      )
        return;
    }
    if (receipt.refundTransaction && !failed.includes(receipt.refundTransaction.status)) return;
    if ((await this.config.primitives.inspectLocked()).disabled) return;
    const proof = await this.config.chains.receipt(
      record.request.originChainId,
      record.funding.txnHash
    );
    if (proof?.status !== 'success') return;
    record.repairAttemptedAt = new Date(this.now()).toISOString();
    await this.saveLocked(record);
    await this.config.trails.retryIntent(intent.intentId, record.funding.txnHash);
  }

  private currentRecovery(record: SwapRecord, required: true): RecoveryRecord;
  private currentRecovery(record: SwapRecord, required?: false): RecoveryRecord | undefined;
  private currentRecovery(record: SwapRecord, required = false) {
    const recovery = record.recoveries.find((r) => r.id === record.activeRecoveryId);
    if (!recovery && required)
      throw new WalletError('INVALID_RECOVERY', 'No authorized recovery is active.', 409);
    return recovery;
  }

  private async recoveryAllowedLocked(record: SwapRecord) {
    await this.adoptLocked(record);
    record.funding =
      (await this.config.primitives.readEvmOperationsLocked([record.fundingId])).find(
        (op) => op.id === record.fundingId
      ) ?? record.funding;
    if (uncertain(record.funding))
      throw new WalletError('DEBIT_PENDING', 'Reconcile funding before starting recovery.', 409);
    const { intent } = await this.config.trails.getIntent(record.quote.intent.intentId);
    this.identity(record, intent);
    const receipt = await this.receipt(record);
    const lastProgress =
      typeof receipt?.updatedAt === 'string'
        ? Date.parse(receipt.updatedAt)
        : Date.parse(record.confirmedAt ?? record.createdAt);
    const stalled =
      intent.status === 'EXECUTING' &&
      this.now() - Date.parse(record.confirmedAt ?? record.createdAt) > 900_000 &&
      this.now() - lastProgress > 300_000;
    if (!terminalUpstream.has(intent.status) && !stalled)
      throw new WalletError(
        'RECOVERY_NOT_READY',
        'The route is still progressing. Recovery is available after failure or a prolonged stall.',
        409
      );
  }

  private async prepareRecovery(input: PrepareRecoveryInput): Promise<SwapView> {
    if (!input || typeof input !== 'object')
      throw new WalletError('INVALID_RECOVERY', 'Provide swapId, idempotencyKey, and source.');
    // Snapshot caller fields synchronously before waiting on the executor.
    const swapId = validateId(input.swapId);
    const recoveryId = validateId(input.idempotencyKey);
    const source = parseOrThrow(
      z.enum(['origin', 'destination']),
      input.source,
      () => new WalletError('INVALID_RECOVERY', 'Set source to "origin" or "destination".')
    );
    return this.config.primitives.runLocked(async () => {
      await this.enabledLocked(true);
      const record = await this.loadRecordLocked(swapId);
      const existing = record.recoveries.find((r) => r.id === recoveryId);
      if (existing) {
        if (existing.source !== source)
          throw new WalletError('IDEMPOTENCY_CONFLICT', 'Recovery ID has different input.', 409);
        return swapView(record);
      }
      if (record.activeRecoveryId)
        throw new WalletError('RECOVERY_PENDING', 'Reconcile the active recovery first.', 409);
      await this.recoveryAllowedLocked(record);
      const intent = record.quote.intent;
      const target =
        source === 'origin' ? intent.originIntentAddress : intent.destinationIntentAddress;
      const chainId = source === 'origin' ? intent.originChainId : intent.destinationChainId;
      if (!target)
        throw new WalletError(
          'INVALID_RECOVERY',
          'This intent has no separate destination wallet.'
        );
      await this.availableLocked(chainId, record.id, [record.fundingId]);
      const originalPrepared = await this.config.trails.prepareIntentRecovery(
        intent.intentId,
        target,
        record.owner
      );
      if (
        originalPrepared.intentAddress !== target ||
        originalPrepared.intentSource !== source ||
        originalPrepared.chainId !== chainId
      )
        throw new WalletError(
          'INVALID_RECOVERY',
          'Recovery response changed the reviewed intent side.',
          502
        );
      if (record.recoveries.length >= 100)
        throw new WalletError(
          'RECOVERY_LIMIT',
          'Recovery history limit reached; operator intervention is required.',
          409
        );
      const tokens = parseOrThrow(
        z.array(recoveryTokenSchema).max(64),
        originalPrepared.recoveryTokens ?? [],
        () => new WalletError('INVALID_RESPONSE', 'Trails returned invalid recovery tokens.', 502)
      );
      const candidates = new Map<string, { symbol: string; decimals: number }>();
      for (const t of tokens) {
        if (t.chainId !== 0 && t.chainId !== chainId)
          throw new WalletError('INVALID_RECOVERY', 'Recovery token belongs to another chain.');
        candidates.set(tokenAddress(t.contractAddress), { symbol: t.symbol, decimals: t.decimals });
      }
      if (!candidates.size) {
        for (const a of this.config.assets.filter((a) => a.chainId === chainId))
          candidates.set(tokenAddress(a.asset), {
            symbol: a.asset === 'native' ? 'Native' : a.asset,
            decimals: a.decimals
          });
      }
      const assets: RecoveryRecord['assets'] = [];
      for (const [asset, metadata] of candidates) {
        const amount = await this.config.chains.balance(chainId, target, asset);
        if (BigInt(amount) > 0n)
          assets.push({ asset: asset === zeroAddress ? 'native' : asset, amount, ...metadata });
      }
      if (!assets.length)
        throw new WalletError(
          'NO_RECOVERABLE_BALANCE',
          'No recoverable on-chain balance exists on this intent side.',
          409
        );
      const prepared = recoveryAuthorization(originalPrepared, intent, record.owner, assets);
      const requiresOwnerDeployment = emptyCode(
        await this.config.chains.code(chainId, record.owner)
      );
      const expiresAt = new Date(this.now() + 300_000).toISOString();
      const revision = await sha256(
        canonicalJson({ prepared, assets, requiresOwnerDeployment, expiresAt })
      );
      const prefix = `swp_${await sha256(`${swapId}:${recoveryId}`)}`;
      record.recoveries.push({
        id: recoveryId,
        source,
        chainId,
        intentAddress: target,
        prepared,
        originalPrepared,
        assets,
        requiresOwnerDeployment,
        expiresAt,
        revision,
        status: 'quoted',
        deploymentId: `${prefix}_deploy`,
        signingId: `${prefix}_sign`,
        transactionId: `${prefix}_recover`
      });
      await this.saveLocked(record);
      return swapView(record);
    });
  }

  private async confirmRecovery(input: ConfirmRecoveryInput): Promise<SwapView> {
    if (!input || typeof input !== 'object')
      throw new WalletError('STALE_RECOVERY', 'Provide swapId, recoveryId, and reviewId.', 409);
    // Snapshot approval IDs synchronously so mutating the caller's object while queued cannot
    // confirm a different swap, recovery, or revision.
    const swapId = input.swapId;
    const recoveryId = input.recoveryId;
    const reviewId = input.reviewId;
    return this.config.primitives.runLocked(async () => {
      const record = await this.loadRecordLocked(swapId);
      const recovery = record.recoveries.find((r) => r.id === recoveryId);
      if (!recovery || recovery.revision !== reviewId)
        throw new WalletError(
          'STALE_RECOVERY',
          'Review the current recovery before confirming.',
          409
        );
      if (recovery.status !== 'quoted') return swapView(record);
      await this.enabledLocked(true);
      await this.recoveryAllowedLocked(record);
      if (record.activeRecoveryId)
        throw new WalletError('RECOVERY_PENDING', 'Another recovery is active.', 409);
      await this.availableLocked(recovery.chainId, record.id, [record.fundingId]);
      await this.recheckRecovery(record, recovery);
      await this.config.primitives.markSwapsCoordinatedLocked();
      recovery.status = 'confirmed';
      record.activeRecoveryId = recovery.id;
      record.phase = 'recovering';
      record.action = recovery.requiresOwnerDeployment ? 'deploy-owner' : 'sign-recovery';
      await this.saveLocked(record, 0);
      return swapView(record);
    });
  }

  private async recheckRecovery(record: SwapRecord, recovery: RecoveryRecord) {
    if (Date.parse(recovery.expiresAt) <= this.now())
      throw new WalletError(
        'RECOVERY_EXPIRED',
        'Recovery review expired. Prepare a new review.',
        409
      );
    for (const asset of recovery.assets) {
      if (
        (await this.config.chains.balance(
          recovery.chainId,
          recovery.intentAddress,
          asset.asset
        )) !== asset.amount
      )
        throw new WalletError(
          'RECOVERY_CHANGED',
          'Recoverable balances changed. Prepare a new review.',
          409
        );
    }
    validateRecoveryPayload(recovery.prepared, record.quote.intent, record.owner, recovery.assets);
  }

  private async deployOwnerLocked(record: SwapRecord) {
    const recovery = this.currentRecovery(record, true);
    if (!emptyCode(await this.config.chains.code(recovery.chainId, record.owner))) {
      record.action = 'sign-recovery';
      return;
    }
    await this.enabledLocked(true);
    let op =
      (await this.config.primitives.readEvmOperationsLocked([recovery.deploymentId])).find(
        (candidate) => candidate.id === recovery.deploymentId
      ) ?? recovery.deployment;
    if (op?.status === 'failed' && op.error === 'CREDENTIAL_CHANGED') {
      recovery.deploymentId = retryId(recovery.deploymentId);
      op = undefined;
    }
    if (!uncertain(op) && op?.status !== 'executed') {
      await this.recoveryAllowedLocked(record);
      await this.recheckRecovery(record, recovery);
    }
    recovery.status = 'deploying';
    if (!op || op.status === 'preparing') {
      await this.saveLocked(record);
      op = await this.config.primitives.prepareDeploymentLocked(
        recovery.deploymentId,
        recovery.chainId
      );
    }
    if (op.status === 'quoted') {
      this.sponsored(op);
      // Journal the submission before Execute (see fundLocked).
      recovery.deployment = { ...op, status: 'submitting', submitted: true };
      await this.saveLocked(record);
      try {
        op = await this.config.primitives.executeEvmOperationLocked(
          recovery.deploymentId,
          ['deployment'],
          { skipGate: true, bypassReviewId: true }
        );
      } catch (error) {
        if (!credentialChanged(error)) throw error;
        recovery.deploymentId = retryId(recovery.deploymentId);
        recovery.deployment = undefined;
        return;
      }
    } else
      op = (await this.config.primitives.refreshEvmOperationLocked(recovery.deploymentId)) ?? op;
    recovery.deployment = op;
    if (
      recovery.deployment.status === 'unknown' &&
      recovery.deployment.error === 'RECONCILIATION_REQUIRED'
    ) {
      recovery.error = 'RECONCILIATION_REQUIRED';
      record.phase = 'attention';
      record.error = 'RECONCILIATION_REQUIRED';
      return;
    }
    if (
      recovery.deployment.status === 'failed' ||
      (recovery.deployment.status === 'expired' && recovery.deployment.preSubmitExpired === true)
    )
      throw new WalletError(
        'INVALID_RECOVERY',
        `Owner deployment ${recovery.deployment.status}. Prepare a new recovery review.`,
        409
      );
    if (recovery.deployment.status === 'executed' && recovery.deployment.txnHash) {
      const receipt = await this.config.chains.receipt(
        recovery.chainId,
        recovery.deployment.txnHash
      );
      if (receipt?.status === 'reverted')
        throw new WalletError(
          'INVALID_RECOVERY',
          'Owner deployment reverted. Prepare a new recovery review.',
          409
        );
    }
  }

  private async signRecoveryLocked(record: SwapRecord) {
    const recovery = this.currentRecovery(record, true);
    await this.enabledLocked(true);
    await this.recoveryAllowedLocked(record);
    await this.recheckRecovery(record, recovery);
    if (emptyCode(await this.config.chains.code(recovery.chainId, record.owner)))
      throw new WalletError(
        'INVALID_RECOVERY',
        'The owner must be deployed on the recovery chain.',
        409
      );
    recovery.status = 'signing';
    await this.saveLocked(record);
    const validated = validateRecoveryPayload(
      recovery.prepared,
      record.quote.intent,
      record.owner,
      recovery.assets
    );
    recovery.signed = await this.config.primitives.signEvmTypedDataLocked(
      recovery.signingId,
      recovery.chainId,
      validated.typedData,
      { allowSwapsPrefix: true }
    );
    if (
      !recovery.signed.verified ||
      !recovery.signed.signature ||
      recovery.signed.signature.endsWith('6492'.repeat(16))
    )
      throw new WalletError(
        'INVALID_RECOVERY',
        'A verified deployed-wallet signature is required for Trails recovery.',
        409
      );
    record.action = 'build-recovery';
  }

  private async buildRecoveryLocked(record: SwapRecord) {
    const recovery = this.currentRecovery(record, true);
    await this.enabledLocked(true);
    await this.recheckRecovery(record, recovery);
    recovery.built = await this.config.trails.buildIntentRecoveryTransaction(
      recovery.prepared,
      recovery.signed!.signature!,
      record.owner
    );
    const permit = validateRecoveryTransaction(
      recovery.built,
      recovery.prepared,
      record.quote.intent,
      record.owner,
      recovery.assets
    );
    void permit;
    record.action = 'submit-recovery';
  }

  /**
   * Prepare, journal and execute the recovery transaction in one step, under one credential, so
   * the prepared transaction is never left for a later step that may hold another credential.
   */
  private async submitRecoveryLocked(record: SwapRecord) {
    const recovery = this.currentRecovery(record, true);
    await this.enabledLocked(true);
    let op =
      (await this.config.primitives.readEvmOperationsLocked([recovery.transactionId])).find(
        (candidate) => candidate.id === recovery.transactionId
      ) ?? recovery.transaction;
    if (op?.status === 'failed' && op.error === 'CREDENTIAL_CHANGED') {
      recovery.transactionId = retryId(recovery.transactionId);
      op = undefined;
    }
    if (op && op.status !== 'quoted' && op.status !== 'preparing') {
      recovery.transaction =
        (await this.config.primitives.refreshEvmOperationLocked(recovery.transactionId)) ?? op;
      recovery.status = 'pending';
      record.action = 'observe-recovery';
      return;
    }
    await this.recoveryAllowedLocked(record);
    await this.recheckRecovery(record, recovery);
    await this.availableLocked(recovery.chainId, record.id, [
      record.fundingId,
      recovery.deploymentId,
      recovery.transactionId
    ]);
    const permit = validateRecoveryTransaction(
      recovery.built,
      recovery.prepared,
      record.quote.intent,
      record.owner,
      recovery.assets
    );
    if (!op || op.status === 'preparing') {
      await this.saveLocked(record);
      op = await this.config.primitives.prepareRecoveryLocked(recovery.transactionId, permit);
    }
    this.sponsored(op);
    // Journal the submission before Execute (see fundLocked).
    recovery.transaction = { ...op, status: 'submitting', submitted: true };
    recovery.status = 'submitting';
    await this.saveLocked(record);
    try {
      recovery.transaction = await this.config.primitives.executeEvmOperationLocked(
        recovery.transactionId,
        ['recovery'],
        { skipGate: true, bypassReviewId: true }
      );
    } catch (error) {
      if (!credentialChanged(error)) throw error;
      recovery.transactionId = retryId(recovery.transactionId);
      recovery.transaction = undefined;
      return;
    }
    recovery.status = 'pending';
    record.action = 'observe-recovery';
  }

  private async observeRecoveryLocked(record: SwapRecord) {
    const recovery = this.currentRecovery(record, true);
    if (!(await this.config.primitives.inspectLocked()).disabled)
      recovery.transaction =
        (await this.config.primitives.refreshEvmOperationLocked(recovery.transactionId)) ??
        recovery.transaction;
    if (
      recovery.transaction?.status === 'failed' ||
      (recovery.transaction?.status === 'expired' && recovery.transaction.preSubmitExpired === true)
    ) {
      recovery.status = recovery.transaction.status;
      recovery.error =
        recovery.transaction.status === 'expired' ? 'RECOVERY_EXPIRED' : 'RECOVERY_FAILED';
      record.activeRecoveryId = undefined;
      record.phase = 'attention';
      record.action = 'observe';
      return;
    }
    if (
      recovery.transaction?.status === 'unknown' &&
      recovery.transaction.error === 'RECONCILIATION_REQUIRED'
    ) {
      recovery.error = 'RECONCILIATION_REQUIRED';
      record.phase = 'attention';
      record.error = 'RECONCILIATION_REQUIRED';
      return;
    }
    if (recovery.transaction?.status !== 'executed' || !recovery.transaction.txnHash) return;
    const receipt = await this.config.chains.receipt(
      recovery.chainId,
      recovery.transaction.txnHash
    );
    if (receipt?.status === 'reverted')
      throw new WalletError(
        'INVALID_RECOVERY_TRANSACTION',
        'Recovery reverted on chain. Prepare a new recovery review.',
        409
      );
    if (receipt?.status !== 'success') return;
    const recovered: RecoveryRecord['assets'] = [];
    let partial = false;
    for (const asset of recovery.assets) {
      const remaining = await this.config.chains.balance(
        recovery.chainId,
        recovery.intentAddress,
        asset.asset
      );
      const logged = receipt.transfers
        .filter(
          (t) =>
            tokenAddress(t.asset) === tokenAddress(asset.asset) &&
            t.to === record.owner &&
            t.from === recovery.intentAddress
        )
        .reduce((sum, t) => sum + BigInt(t.amount), 0n);
      // Native transfers emit no logs: the evidence is the intent address's balance going down
      // from the amount re-checked just before submission. Debits of the owner wallet elsewhere
      // cannot touch it.
      const drained = BigInt(asset.amount) - BigInt(remaining);
      const actual = asset.asset === 'native' ? (drained > 0n ? drained : 0n) : logged;
      if (asset.asset === 'native' && actual === 0n && BigInt(asset.amount) > 0n)
        throw new WalletError(
          'RECOVERY_EVIDENCE_PENDING',
          'The chain does not yet show the recovered native amount leaving the intent address.',
          409
        );
      if (actual > 0n) recovered.push({ ...asset, amount: actual.toString() });
      if (actual < BigInt(asset.amount) || BigInt(remaining) > 0n) partial = true;
    }
    recovery.received = recovered;
    recovery.status = partial ? 'partial' : 'recovered';
    record.activeRecoveryId = undefined;
    record.phase = partial ? 'attention' : 'refunded';
    record.outcomeEvidence = partial ? undefined : 'chain-verified';
    record.action = partial ? 'observe' : null;
  }
}

function validateTrailsOptions(options: TrailsOptions): {
  chainsCopy: Record<number, string>;
  assetsCopy: SwapAsset[];
  environment: string;
  enabled: boolean;
} {
  if (!options || typeof options !== 'object')
    throw new WalletError('CONFIGURATION', 'Configure trails(...) options.', 503);
  if (!options.storage || typeof options.storage !== 'object')
    throw new WalletError(
      'CONFIGURATION',
      'Configure trails storage as { scope: "wallet" | "service", adapter, encryptionKey }.',
      503
    );
  const { scope, adapter, encryptionKey } = options.storage;
  if (scope !== 'wallet' && scope !== 'service')
    throw new WalletError(
      'CONFIGURATION',
      'trails storage.scope must be "wallet" or "service".',
      503
    );
  // Fails with CONFIGURATION unless the key is 32 base64-encoded bytes.
  new NamespaceCipher(encryptionKey, 'trails-swap', 'validate');
  if (
    !adapter ||
    typeof adapter !== 'object' ||
    typeof adapter.get !== 'function' ||
    typeof adapter.findIntent !== 'function' ||
    typeof adapter.save !== 'function' ||
    typeof adapter.list !== 'function'
  )
    throw new WalletError(
      'CONFIGURATION',
      'trails storage.adapter must implement get, findIntent, save, and list.',
      503
    );
  if (!options.chains || typeof options.chains !== 'object')
    throw new WalletError('CONFIGURATION', 'Configure HTTPS RPC URLs in trails chains.', 503);
  const chainsCopy: Record<number, string> = {};
  for (const [key, url] of Object.entries(options.chains)) {
    const chainId = Number(key);
    if (!Number.isInteger(chainId) || chainId <= 0 || typeof url !== 'string')
      throw new WalletError('CONFIGURATION', 'Invalid chain RPC mapping in trails options.', 503);
    chainsCopy[chainId] = url;
  }
  if (!Array.isArray(options.assets))
    throw new WalletError(
      'CONFIGURATION',
      'Configure approved assets array in trails options.',
      503
    );
  const assetsCopy: SwapAsset[] = options.assets.map((asset) => {
    if (
      !asset ||
      typeof asset !== 'object' ||
      !Number.isInteger(asset.chainId) ||
      typeof asset.asset !== 'string' ||
      !Number.isInteger(asset.decimals) ||
      asset.decimals < 0 ||
      asset.decimals > 255
    )
      throw new WalletError('CONFIGURATION', 'Invalid swap asset entry in trails options.', 503);
    return {
      chainId: asset.chainId,
      asset: asset.asset,
      decimals: asset.decimals,
      ...(asset.symbol !== undefined ? { symbol: asset.symbol } : {})
    };
  });
  const environment = options.environment ?? 'default';
  if (typeof environment !== 'string' || !environment.trim())
    throw new WalletError('CONFIGURATION', 'Configure a non-empty trails environment string.', 503);
  return {
    chainsCopy,
    assetsCopy,
    environment,
    enabled: options.enabled ?? true
  };
}

/** Package-private test seam: registers a `SwapsConfig` backed by custom gateway/chains/clock. */
export function trailsInternal<TStorage extends TrailsStorageOption>(
  options: TrailsOptions<TStorage>,
  overrides: {
    gateway?: SwapGateway;
    chains?: ChainReader;
    clock?: () => number;
    onCodec?: (codec: SwapRecordCodec) => void;
  } = {}
): SwapsConfig<TStorage['scope'], SwapsFacet> {
  const { chainsCopy, assetsCopy, environment, enabled } = validateTrailsOptions(options);
  // Validate TrailsClient configuration eagerly when using the real gateway.
  if (!overrides.gateway) {
    new TrailsClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      origin: options.origin,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs
    });
  }
  // Snapshot ALL options eagerly so mutating caller objects later cannot redirect binding.
  const apiKey = options.apiKey;
  const baseUrl = options.baseUrl;
  const configuredOrigin = options.origin;
  const configuredFetch = options.fetch;
  const timeoutMs = options.timeoutMs;
  const storeScope = options.storage.scope;
  const storeAdapter = options.storage.adapter;
  const encryptionKey = options.storage.encryptionKey;
  let boundWalletNamespace: string | undefined;

  return registerSwapsBinder<TStorage['scope'], SwapsFacet>({
    scope: storeScope,
    bind(primitives: LockedEnginePrimitives): BoundSwaps<SwapsFacet> {
      let store: SwapStore;
      if (storeScope === 'wallet') {
        if (boundWalletNamespace !== undefined && boundWalletNamespace !== primitives.namespace)
          throw new WalletError(
            'CONFIGURATION',
            'A wallet-scoped trails(...) configuration cannot be bound to a second wallet namespace.',
            503
          );
        boundWalletNamespace = primitives.namespace;
        store = storeAdapter as SwapStore;
      } else {
        store = scopeSwapStore(storeAdapter as NamespacedSwapStore, primitives.namespace);
      }

      const gateway =
        overrides.gateway ??
        new TrailsClient({
          apiKey,
          baseUrl,
          origin: configuredOrigin ?? primitives.origin,
          fetch: configuredFetch,
          timeoutMs
        });
      const chainReader =
        overrides.chains ?? new EvmChainReader(chainsCopy, configuredFetch ?? fetch);

      const codec = new SwapRecordCodec(encryptionKey, primitives.namespace);
      overrides.onCodec?.(codec);
      const coordinator = new TrailsCoordinator({
        primitives,
        trails: gateway,
        chains: chainReader,
        store,
        codec,
        assets: assetsCopy,
        enabled,
        environment,
        clock: overrides.clock ?? (() => Date.now())
      });
      return {
        gate: coordinator.gate(),
        facet: coordinator.facet()
      };
    }
  });
}

/**
 * Enable durable Trails swaps and recovery on a server wallet via
 * `createServerWallet({ ..., swaps: trails({ ..., storage: { scope: 'wallet', adapter, encryptionKey } }) })`
 * or `createServerWalletService({ ..., swaps: trails({ ..., storage: { scope: 'service', adapter, encryptionKey } }) })`.
 * Swap records are encrypted and authenticated with a key derived from `encryptionKey` per wallet.
 * Ordinary EVM debits and swaps automatically share one executor and one debit gate.
 */
export function trails(
  options: TrailsOptions<Extract<TrailsStorageOption, { readonly scope: 'wallet' }>>
): SwapsConfig<'wallet', SwapsFacet>;
export function trails(
  options: TrailsOptions<Extract<TrailsStorageOption, { readonly scope: 'service' }>>
): SwapsConfig<'service', SwapsFacet>;
export function trails(
  options: TrailsOptions
): SwapsConfig<'wallet', SwapsFacet> | SwapsConfig<'service', SwapsFacet> {
  return trailsInternal(options) as
    SwapsConfig<'wallet', SwapsFacet> | SwapsConfig<'service', SwapsFacet>;
}
