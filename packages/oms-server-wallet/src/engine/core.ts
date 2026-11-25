import { z } from 'zod';

import type { CoordinatorGate } from '../internal/swapsBridge.js';
import type { NetworkFamily, RemoteWallet } from '../protocol.js';
import type {
  OperationIndexBucket,
  State,
  StoredChainOperation,
  StoredEvmOperation,
  StoredOperationRecord
} from '../state.js';
import type { ExclusiveExecutor, StateStore } from '../storage.js';
import type { RpcTransport } from '../transport.js';
import type {
  OperationPage,
  ResolveReconciliationInput,
  SubmissionMode,
  WalletOperation,
  WalletSnapshot
} from '../types.js';

import { sha256 } from '../encoding.js';
import { UpstreamError, WalletError } from '../errors.js';
import { nextWalletNonce } from '../internal/protocol/requestSigning.js';
import { canonicalJson } from '../json.js';
import {
  authSchema,
  generateCredential,
  isWalletAddress,
  listSchema,
  NETWORK_FAMILIES,
  sameAddress,
  walletFamily,
  walletSchema
} from '../protocol.js';
import {
  OPERATION_INDEX_BUCKETS,
  OPERATION_INDEX_CHUNK_SIZE,
  parseOpenOperationIndex,
  parseOperationIndexChunk,
  parseOperationIndexMeta,
  parseStoredOperation,
  readState,
  writeState
} from '../state.js';
import { parseWaas } from '../validation.js';
import {
  isInternalEvmOperation,
  okSchema,
  credentialRejectedCodes,
  OPEN_STATUSES,
  validateIdempotencyKey
} from './inputs.js';
import { paginate } from './projection.js';

export interface WalletEngineConfig {
  readonly namespace: string;
  readonly origin?: string;
  readonly subject: string;
  readonly issuer: string;
  readonly audience: string;
  readonly getIdToken: () => Promise<{ readonly token: string; readonly expiresAt: number }>;
  readonly sessionLifetimeSeconds?: number;
  readonly store: StateStore;
  readonly executor: ExclusiveExecutor;
  readonly transport: RpcTransport;
  readonly clock?: () => number;
  /**
   * Whether a missing family wallet may be created with CreateWallet (default true). The
   * ephemeral signer sets false: it keeps no record of an uncertain create, so a lost response
   * could otherwise lead to a second wallet for the identity.
   */
  readonly createWallets?: boolean;
}

/**
 * Core internal wallet engine owning identity state, credential nonces, WaaS authentication,
 * reviewId / submissionMode enforcement, and locked primitives shared with the Trails coordinator.
 */

/**
 * Identity, credential and operation-store core shared by the EVM and Solana/Tron engines.
 * Every method assumes the caller already holds the identity executor, except the lifecycle
 * methods, which acquire it themselves.
 */
export class EngineCore {
  gate?: CoordinatorGate;

  readonly now: () => number;

  constructor(readonly config: WalletEngineConfig) {
    if (typeof config.subject !== 'string' || !config.subject || config.subject.length > 128)
      throw new WalletError(
        'INVALID_IDENTITY',
        'Wallet identifiers must contain 1–128 characters.'
      );
    this.now = config.clock ?? (() => Date.now());
  }

  inspect(): Promise<WalletSnapshot> {
    return this.config.executor.run(async () => this.snapshot(await this.load()));
  }

  /** Snapshot one family's initialized address under lock, then release before external I/O. */
  async snapshotAddress(family: NetworkFamily): Promise<string | undefined> {
    return this.config.executor.run(async () => (await this.load()).wallets[family]?.address);
  }

  async createOrRestore(families: readonly NetworkFamily[] = ['evm']): Promise<WalletSnapshot> {
    if (
      !Array.isArray(families) ||
      !families.length ||
      families.some((family) => !NETWORK_FAMILIES.includes(family))
    )
      throw new WalletError('INVALID_FAMILY', 'Request one or more of: evm, solana, tron.');
    return this.config.executor.run(async () => {
      const state = await this.load();
      await this.ensure(state, [...new Set(families)]);
      return this.snapshot(state);
    });
  }

  rotateCredential(): Promise<WalletSnapshot> {
    return this.config.executor.run(async () => {
      const state = await this.load();
      if (state.disabled)
        throw new WalletError('WALLET_DISABLED', 'Enable the wallet before rotating.', 409);
      await this.revoke(state);
      await this.ensure(state, this.held(state));
      return this.snapshot(state);
    });
  }

  disable(): Promise<WalletSnapshot> {
    return this.config.executor.run(async () => {
      const state = await this.load();
      state.disabled = true;
      await this.save(state);
      await this.revoke(state);
      return this.snapshot(state);
    });
  }

  enable(): Promise<WalletSnapshot> {
    return this.config.executor.run(async () => {
      const state = await this.load();
      await this.revoke(state);
      state.disabled = false;
      await this.save(state);
      await this.ensure(state, this.held(state));
      return this.snapshot(state);
    });
  }

  /**
   * Mark a quoted operation whose quote has expired as `expired` (`provenUnsent`) without throwing,
   * so a refresh can report the expiry before anyone calls `execute`. Returns whether it expired.
   */
  async expireIfStale(op: StoredOperationRecord): Promise<boolean> {
    if (op.status !== 'quoted' || !op.quote || Date.parse(op.quote.expiresAt) > this.now())
      return false;
    op.status = 'expired';
    op.error = 'QUOTE_EXPIRED';
    op.preSubmitExpired = true;
    await this.writeOperation(op);
    return true;
  }

  /**
   * Cancel an operation that has not been submitted: `preparing` or `quoted` becomes terminal
   * `cancelled`, and `execute` refuses it from then on. Cancelling again is a no-op. Any other
   * status may already have been sent, so it is refused.
   */
  async cancelOperation(op: StoredOperationRecord): Promise<void> {
    if (op.status === 'cancelled') return;
    if (op.status !== 'preparing' && op.status !== 'quoted')
      throw new WalletError(
        'INVALID_STATE',
        `Only a preparing or quoted operation can be cancelled; this one is ${op.status}.`,
        409
      );
    op.status = 'cancelled';
    op.error = 'OPERATION_CANCELLED';
    await this.writeOperation(op);
  }

  /** Refuse to execute an operation that was cancelled. */
  assertNotCancelled(op: StoredOperationRecord): void {
    if (op.status === 'cancelled')
      throw new WalletError('OPERATION_CANCELLED', 'This operation was cancelled.', 409);
  }

  /**
   * Mark a still-quoted operation whose quote has expired as `expired` before anything is sent,
   * persist it, and throw `QUOTE_EXPIRED`. Returns normally while the quote is still valid.
   */
  async expireBeforeSubmit(op: StoredOperationRecord): Promise<void> {
    if (!op.quote || Date.parse(op.quote.expiresAt) > this.now()) return;
    op.status = 'expired';
    op.error = 'QUOTE_EXPIRED';
    op.preSubmitExpired = true;
    await this.writeOperation(op);
    throw new WalletError(
      'QUOTE_EXPIRED',
      'The quote expired before submission; nothing was sent. Prepare a new operation.',
      409
    );
  }

  async computeReviewId(params: Record<string, unknown>): Promise<string> {
    return sha256(canonicalJson({ v: 1, ...params }));
  }

  validateResolveInput(input: ResolveReconciliationInput): {
    idempotencyKey: string;
    txnId: string;
  } {
    if (!input || typeof input !== 'object')
      throw new WalletError(
        'INVALID_INPUT',
        'Provide idempotencyKey, txnId, and resolution: "not-broadcast".'
      );
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    if (typeof input.txnId !== 'string' || !input.txnId.trim())
      throw new WalletError('INVALID_INPUT', 'Provide the operation quote txnId to resolve.');
    if (input.resolution !== 'not-broadcast')
      throw new WalletError('INVALID_INPUT', 'Only resolution: "not-broadcast" is supported.');
    return { idempotencyKey, txnId: input.txnId };
  }

  load(): Promise<State> {
    return readState(this.config.store);
  }

  save(state: State) {
    return writeState(this.config.store, state);
  }

  private snapshot(state: State): WalletSnapshot {
    return {
      wallets: { ...state.wallets },
      disabled: state.disabled,
      expiresAt: state.credential?.expiresAt,
      credentialId: state.credential?.credentialId,
      creationUncertain: state.creating.length > 0
    };
  }

  private async call(
    state: State,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    if (!state.credential) throw new WalletError('NO_CREDENTIAL', 'Credential unavailable.');
    state.credential.nonce = nextWalletNonce(BigInt(state.credential.nonce), this.now()).toString();
    await this.save(state);
    return this.config.transport.request(method, params, state.credential);
  }

  async activeCall(
    state: State,
    method: string,
    params: Record<string, unknown>,
    families: readonly NetworkFamily[] = ['evm']
  ): Promise<unknown> {
    await this.ensure(state, families);
    try {
      return await this.call(state, method, params);
    } catch (error) {
      if (!(error instanceof UpstreamError) || !credentialRejectedCodes.has(error.upstreamCode))
        throw error;
      state.credential = undefined;
      await this.save(state);
      try {
        await this.ensure(state, families);
      } catch {
        // Preserve the original pre-claim credential rejection so settlement never treats an
        // unsent Execute as SUBMISSION_UNCERTAIN during an IdP outage.
        throw error;
      }
      return this.call(state, method, params);
    }
  }

  private held(state: State): NetworkFamily[] {
    const families = NETWORK_FAMILIES.filter((family) => state.wallets[family]);
    return families.length ? families : ['evm'];
  }

  private async signIn(state: State, discoverFamilies: readonly NetworkFamily[]): Promise<void> {
    const idToken = await this.config.getIdToken();
    if (
      !idToken ||
      typeof idToken !== 'object' ||
      typeof idToken.token !== 'string' ||
      !idToken.token.trim() ||
      typeof idToken.expiresAt !== 'number' ||
      !Number.isFinite(idToken.expiresAt)
    )
      throw new WalletError(
        'CONFIGURATION',
        'oidc.getIdToken must return { token, expiresAt }.',
        503
      );
    const { token, expiresAt } = idToken;
    state.credential = await generateCredential();
    await this.save(state);
    const handle = await sha256(token);
    const committed = parseWaas(
      z.object({ verifier: z.string() }),
      await this.call(state, 'CommitVerifier', {
        identityType: 'oidc',
        authMode: 'id-token',
        handle,
        metadata: {
          iss: this.config.issuer,
          aud: this.config.audience,
          exp: String(expiresAt)
        }
      })
    );
    const authenticated = parseWaas(
      authSchema,
      await this.call(state, 'CompleteAuth', {
        identityType: 'oidc',
        authMode: 'id-token',
        verifier: committed.verifier,
        answer: token,
        lifetime: this.config.sessionLifetimeSeconds ?? 21_600
      })
    );
    if (
      authenticated.identity.sub !== this.config.subject ||
      authenticated.identity.iss.replace(/\/$/, '') !== this.config.issuer.replace(/\/$/, '') ||
      authenticated.credential.credentialId.toLowerCase() !== state.credential.credentialId
    )
      throw new WalletError(
        'IDENTITY_MISMATCH',
        'WaaS returned a different identity or credential.',
        502
      );
    await this.discover(
      state,
      discoverFamilies,
      authenticated.wallets,
      authenticated.page?.cursor || undefined
    );
    state.credential.expiresAt = authenticated.credential.expiresAt;
    await this.save(state);
  }

  private async discoverWithRefresh(
    state: State,
    discoverFamilies: readonly NetworkFamily[]
  ): Promise<void> {
    try {
      await this.discover(state, discoverFamilies, [], '');
      await this.save(state);
    } catch (error) {
      if (!(error instanceof UpstreamError) || !credentialRejectedCodes.has(error.upstreamCode))
        throw error;
      state.credential = undefined;
      await this.save(state);
      await this.signIn(state, discoverFamilies);
    }
  }

  async ensure(
    state: State,
    families: readonly NetworkFamily[],
    options: { readonly bindAllExisting?: boolean } = {}
  ): Promise<void> {
    if (state.disabled) throw new WalletError('WALLET_DISABLED', 'This wallet is disabled.', 409);
    const discoverFamilies = options.bindAllExisting ? NETWORK_FAMILIES : families;
    let discovered = false;
    if (
      !state.credential?.expiresAt ||
      Date.parse(state.credential.expiresAt) <= this.now() + 60_000 ||
      state.creating.some((family) => !state.wallets[family])
    ) {
      await this.signIn(state, discoverFamilies);
      discovered = true;
    }
    if (options.bindAllExisting && !discovered) {
      await this.discoverWithRefresh(state, discoverFamilies);
      discovered = true;
    }
    for (const family of families) {
      if (state.wallets[family]) continue;
      if (!discovered) {
        await this.discoverWithRefresh(state, discoverFamilies);
        discovered = true;
        if (state.wallets[family]) continue;
      }
      if (this.config.createWallets === false)
        throw new WalletError(
          'WALLET_NOT_INITIALIZED',
          `No ${family} wallet exists for this identity yet. Create it with a durable wallet first.`,
          409
        );
      if (state.creating.includes(family))
        throw new WalletError(
          'CREATION_UNCERTAIN',
          'A previous create request has an unknown outcome. Restore again after upstream recovery; no duplicate wallet will be created.',
          409
        );
      state.creating.push(family);
      await this.save(state);
      try {
        const { wallet } = parseWaas(
          z.object({ wallet: walletSchema }),
          await this.call(state, 'CreateWallet', {
            networkFamily: family,
            reference: this.config.subject
          })
        );
        if (walletFamily(wallet) !== family || !isWalletAddress(family, wallet.address))
          throw new WalletError(
            'INVALID_RESPONSE',
            'WaaS created a different kind of wallet.',
            502
          );
        state.wallets[family] = wallet;
        state.creating = state.creating.filter((entry) => entry !== family);
        await this.save(state);
      } catch (error) {
        state.credential!.expiresAt = undefined;
        await this.save(state);
        throw error;
      }
    }
  }

  private async discover(
    state: State,
    families: readonly NetworkFamily[],
    wallets: RemoteWallet[],
    from: string | undefined
  ): Promise<void> {
    const all = [...wallets];
    const seen = new Set<string>();
    let cursor = from;
    while (cursor !== undefined) {
      if (seen.has(cursor) || seen.size >= 100)
        throw new WalletError('INVALID_RESPONSE', 'Wallet pagination did not terminate.', 502);
      seen.add(cursor);
      const page = parseWaas(
        listSchema,
        await this.call(state, 'ListWallets', {
          page: cursor ? { cursor, limit: 100 } : { limit: 100 }
        })
      );
      all.push(...page.wallets);
      cursor = page.page?.cursor || undefined;
    }
    for (const family of NETWORK_FAMILIES) {
      const stored = state.wallets[family];
      if (!stored && !families.includes(family) && !state.creating.includes(family)) continue;
      const found = all.filter((wallet) => walletFamily(wallet) === family);
      if (
        found.length > 1 ||
        (stored &&
          !found.some(
            (wallet) =>
              wallet.id === stored.id && sameAddress(family, wallet.address, stored.address)
          ))
      )
        throw new WalletError(
          'WALLET_MISMATCH',
          'Identity does not map to the expected single wallet.',
          409
        );
      if (found.length !== 1) continue;
      const bound = parseWaas(
        walletSchema,
        parseWaas(
          z.object({ wallet: walletSchema }),
          await this.call(state, 'UseWallet', { walletId: found[0].id })
        ).wallet
      );
      if (
        bound.id !== found[0].id ||
        !sameAddress(family, bound.address, found[0].address) ||
        !isWalletAddress(family, bound.address)
      )
        throw new WalletError(
          'WALLET_MISMATCH',
          'Wallet binding returned a different wallet.',
          502
        );
      state.wallets[family] = bound;
      state.creating = state.creating.filter((entry) => entry !== family);
    }
  }

  /**
   * Revoke the current credential unless it has already expired, then forget it. A credential
   * without `expiresAt` (sign-in or wallet creation failed part way) is revoked too, since WaaS may
   * have registered it; a credential WaaS rejects counts as revoked.
   */
  async revoke(state: State): Promise<void> {
    const credential = state.credential;
    if (credential && (!credential.expiresAt || Date.parse(credential.expiresAt) > this.now())) {
      try {
        parseWaas(
          okSchema,
          await this.call(state, 'RevokeCredential', {
            credentialId: credential.credentialId
          })
        );
      } catch (error) {
        if (!(error instanceof UpstreamError) || !credentialRejectedCodes.has(error.upstreamCode))
          throw error;
      }
    }
    state.credential = undefined;
    await this.save(state);
  }

  /**
   * Sign in if needed and bind wallets that already exist on WaaS, without creating any. With
   * `families`, each must exist; without, every existing family is bound and at least one must
   * exist. Throws `WALLET_NOT_INITIALIZED` otherwise.
   */
  async restoreExisting(state: State, families?: readonly NetworkFamily[]): Promise<void> {
    await this.ensure(state, families ?? [], { bindAllExisting: !families });
    if (!NETWORK_FAMILIES.some((family) => state.wallets[family]))
      throw new WalletError(
        'WALLET_NOT_INITIALIZED',
        'No wallet exists for this identity yet. Create it with a durable wallet first.',
        409
      );
  }

  async readOperation(id: string): Promise<StoredOperationRecord | null> {
    const value = await this.config.store.read(`operation:${id}`);
    return value === null ? null : parseStoredOperation(value);
  }

  async readEvmOperation(id: string): Promise<StoredEvmOperation | null> {
    const op = await this.readOperation(id);
    return op && !('family' in op) ? op : null;
  }

  async readChainOperation(
    id: string,
    family: 'solana' | 'tron'
  ): Promise<StoredChainOperation | null> {
    const op = await this.readOperation(id);
    return op && 'family' in op && op.family === family ? op : null;
  }

  private indexMetaKey(bucket: OperationIndexBucket): string {
    return `operationIndex:${bucket}:meta`;
  }

  private indexChunkKey(bucket: OperationIndexBucket, chunkIndex: number): string {
    return `operationIndex:${bucket}:${chunkIndex}`;
  }

  private bucketFor(op: StoredOperationRecord): OperationIndexBucket {
    if ('family' in op) return op.family;
    return isInternalEvmOperation(op) ? 'internal' : 'evm';
  }

  private async appendToIndex(bucket: OperationIndexBucket, id: string): Promise<void> {
    const metaKey = this.indexMetaKey(bucket);
    const meta = parseOperationIndexMeta(await this.config.store.read(metaKey));
    if (meta.chunks > 0) {
      const lastIdx = meta.chunks - 1;
      const tailKey = this.indexChunkKey(bucket, lastIdx);
      const tail = parseOperationIndexChunk(await this.config.store.read(tailKey));
      const committedLen = meta.total - lastIdx * OPERATION_INDEX_CHUNK_SIZE;
      if (tail.length < committedLen)
        throw new WalletError('INVALID_STATE', 'Stored operation index chunk is truncated.', 500);
      // Slice to meta.total so a crash after writing a chunk and before bumping meta self-heals.
      const committedTail = tail.slice(0, committedLen);
      if (committedTail.includes(id)) return;
      if (committedTail.length < OPERATION_INDEX_CHUNK_SIZE) {
        await this.config.store.write(tailKey, JSON.stringify([...committedTail, id]));
        await this.config.store.write(
          metaKey,
          JSON.stringify({ v: 1, chunks: meta.chunks, total: meta.total + 1 })
        );
        return;
      }
    }
    const nextIdx = meta.chunks;
    await this.config.store.write(this.indexChunkKey(bucket, nextIdx), JSON.stringify([id]));
    await this.config.store.write(
      metaKey,
      JSON.stringify({ v: 1, chunks: meta.chunks + 1, total: meta.total + 1 })
    );
  }

  async writeOperation(op: StoredOperationRecord) {
    const isOpen = OPEN_STATUSES.has(op.status);
    if (isOpen) await this.addOpenOperation(op.id);
    if (op.indexed !== true) {
      const existing = await this.readOperation(op.id);
      if (existing?.indexed === true) {
        op.indexed = true;
      } else {
        await this.appendToIndex(this.bucketFor(op), op.id);
        op.indexed = true;
      }
    }
    await this.config.store.write(`operation:${op.id}`, JSON.stringify(op));
    if (!isOpen) await this.removeOpenOperation(op.id);
  }

  private writeOpenIndex(ids: string[]) {
    return this.config.store.write('openOperationIndex', JSON.stringify({ v: 1, ids }));
  }

  private async addOpenOperation(id: string): Promise<void> {
    const stored = parseOpenOperationIndex(await this.config.store.read('openOperationIndex'));
    const ids = stored ? stored.ids : await this.rebuildOpenIds();
    if (!ids.includes(id)) await this.writeOpenIndex([...ids, id]);
    else if (!stored) await this.writeOpenIndex(ids);
  }

  private async removeOpenOperation(id: string): Promise<void> {
    const stored = parseOpenOperationIndex(await this.config.store.read('openOperationIndex'));
    if (!stored || !stored.ids.includes(id)) return;
    await this.writeOpenIndex(stored.ids.filter((entry) => entry !== id));
  }

  async pruneOpenOperations(settledIds: readonly string[]): Promise<void> {
    if (!settledIds.length) return;
    const stored = parseOpenOperationIndex(await this.config.store.read('openOperationIndex'));
    if (!stored) return;
    const drop = new Set(settledIds);
    const next = stored.ids.filter((id) => !drop.has(id));
    if (next.length !== stored.ids.length) await this.writeOpenIndex(next);
  }

  private async rebuildOpenIds(): Promise<string[]> {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const bucket of OPERATION_INDEX_BUCKETS) {
      const meta = parseOperationIndexMeta(await this.config.store.read(this.indexMetaKey(bucket)));
      for (let chunkIdx = 0; chunkIdx < meta.chunks; chunkIdx++) {
        const rawChunk = parseOperationIndexChunk(
          await this.config.store.read(this.indexChunkKey(bucket, chunkIdx))
        );
        const expectedLen = Math.min(
          OPERATION_INDEX_CHUNK_SIZE,
          meta.total - chunkIdx * OPERATION_INDEX_CHUNK_SIZE
        );
        if (rawChunk.length < expectedLen)
          throw new WalletError('INVALID_STATE', 'Stored operation index chunk is truncated.', 500);
        for (const id of rawChunk.slice(0, expectedLen)) {
          if (seen.has(id)) continue;
          seen.add(id);
          const op = await this.readOperation(id);
          if (!op || OPEN_STATUSES.has(op.status)) ids.push(id);
        }
      }
    }
    return ids;
  }

  async openOperationIds(): Promise<string[]> {
    const stored = parseOpenOperationIndex(await this.config.store.read('openOperationIndex'));
    if (stored) return stored.ids;
    const ids = await this.rebuildOpenIds();
    await this.writeOpenIndex(ids);
    return ids;
  }

  /** Page through a family's chunked history index in O(limit) store reads. */
  async listIndexedOperations<T extends WalletOperation>(
    bucket: 'evm' | 'solana' | 'tron',
    offset: number,
    limit: number,
    readAndProject: (id: string) => Promise<T | null>
  ): Promise<OperationPage<T>> {
    const meta = parseOperationIndexMeta(await this.config.store.read(this.indexMetaKey(bucket)));
    if (offset >= meta.total) return { items: [] };
    const items: T[] = [];
    let pos = offset;
    let nextCursor: string | undefined;
    let loadedChunkIdx = -1;
    let loadedChunk: string[] = [];

    while (pos < meta.total) {
      const chunkIdx = Math.floor(pos / OPERATION_INDEX_CHUNK_SIZE);
      if (chunkIdx !== loadedChunkIdx) {
        const rawChunk = parseOperationIndexChunk(
          await this.config.store.read(this.indexChunkKey(bucket, chunkIdx))
        );
        const expectedLen = Math.min(
          OPERATION_INDEX_CHUNK_SIZE,
          meta.total - chunkIdx * OPERATION_INDEX_CHUNK_SIZE
        );
        if (rawChunk.length < expectedLen)
          throw new WalletError('INVALID_STATE', 'Stored operation index chunk is truncated.', 500);
        loadedChunk = rawChunk.slice(0, expectedLen);
        loadedChunkIdx = chunkIdx;
      }
      const id = loadedChunk[pos % OPERATION_INDEX_CHUNK_SIZE];
      const op = await readAndProject(id);
      if (op) {
        if (items.length < limit) {
          items.push(op);
        } else {
          nextCursor = String(pos);
          break;
        }
      }
      pos++;
    }
    return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  }

  /** Page through open operations for one family, lazily pruning settled IDs left by a crash. */
  /**
   * Page through open operations. `project` returns the public view of a record, or null for a
   * record another family or an internal flow owns. Runs under the identity lock, so a missing
   * record (a crash before its first write) and a settled one are both pruned from the open index.
   */
  async listOpenOperations<T extends WalletOperation>(
    offset: number,
    limit: number,
    project: (op: StoredOperationRecord) => T | null
  ): Promise<OperationPage<T>> {
    const ids = await this.openOperationIds();
    const operations: T[] = [];
    const stale: string[] = [];
    for (const id of ids) {
      const op = await this.readOperation(id);
      if (!op || !OPEN_STATUSES.has(op.status)) {
        stale.push(id);
        continue;
      }
      const view = project(op);
      if (view) operations.push(view);
    }
    await this.pruneOpenOperations(stale);
    return paginate(operations, offset, limit);
  }

  async existingEvm(
    id: string,
    kind: StoredEvmOperation['kind'],
    input: unknown,
    submissionMode: SubmissionMode = 'review',
    allowSwapsPrefix = false,
    acceptedKinds?: readonly StoredEvmOperation['kind'][]
  ): Promise<{ operation: StoredEvmOperation | null; hash: string }> {
    return this.existingAny(
      id,
      kind,
      input,
      'evm',
      submissionMode,
      allowSwapsPrefix,
      acceptedKinds
    ) as Promise<{ operation: StoredEvmOperation | null; hash: string }>;
  }

  async existingAny(
    id: string,
    kind: string,
    input: unknown,
    family: NetworkFamily,
    submissionMode: SubmissionMode,
    allowSwapsPrefix = false,
    acceptedKinds?: readonly string[]
  ): Promise<{ operation: StoredOperationRecord | null; hash: string }> {
    validateIdempotencyKey(id, allowSwapsPrefix);
    const hash = await sha256(JSON.stringify(input));
    const stored = await this.readOperation(id);
    if (stored) {
      const storedFamily: NetworkFamily = 'family' in stored ? stored.family : 'evm';
      const kindMatches = acceptedKinds
        ? acceptedKinds.includes(stored.kind)
        : stored.kind === kind;
      if (stored.inputHash !== hash || !kindMatches || storedFamily !== family)
        throw new WalletError(
          'IDEMPOTENCY_CONFLICT',
          'This operation ID was already used with different input.',
          409
        );
      // Compare the persisted submission mode before resuming an interrupted prepare or reusing a quote.
      if (stored.submissionMode !== submissionMode) {
        if (submissionMode === 'immediate')
          throw new WalletError(
            'APPROVAL_REQUIRED',
            'This operation was prepared for manual review and cannot be executed via immediate send.',
            409
          );
        throw new WalletError(
          'IDEMPOTENCY_CONFLICT',
          'This operation ID was already created in immediate mode.',
          409
        );
      }
      if (stored.status === 'preparing') return { operation: null, hash };
      return { operation: stored, hash };
    }
    return { operation: null, hash };
  }
}
