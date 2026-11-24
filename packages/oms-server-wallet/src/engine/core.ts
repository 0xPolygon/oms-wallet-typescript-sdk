import { z } from 'zod';

import type { CoordinatorGate } from '../internal/swapsBridge.js';
import type { NetworkFamily, RemoteWallet } from '../protocol.js';
import type {
  State,
  StoredChainOperation,
  StoredEvmOperation,
  StoredOperationRecord
} from '../state.js';
import type { ExclusiveExecutor, StateStore } from '../storage.js';
import type { RpcTransport } from '../transport.js';
import type { ResolveReconciliationInput, SubmissionMode, WalletSnapshot } from '../types.js';

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
  parseOpenOperationIndex,
  parseOperationIndex,
  parseStoredOperation,
  readState,
  writeState
} from '../state.js';
import {
  okSchema,
  credentialRejectedCodes,
  OPEN_STATUSES,
  validateIdempotencyKey
} from './inputs.js';

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
    if (!config.subject || config.subject.length > 128)
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
      wallet: state.wallets.evm,
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
    state.credential.nonce = nextWalletNonce(BigInt(state.credential.nonce)).toString();
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

  async ensure(state: State, families: readonly NetworkFamily[]): Promise<void> {
    if (state.disabled) throw new WalletError('WALLET_DISABLED', 'This wallet is disabled.', 409);
    let discovered = false;
    if (
      !state.credential?.expiresAt ||
      Date.parse(state.credential.expiresAt) <= this.now() + 60_000 ||
      state.creating.some((family) => !state.wallets[family])
    ) {
      state.credential = await generateCredential();
      await this.save(state);
      const { token, expiresAt } = await this.config.getIdToken();
      const handle = await sha256(token);
      const committed = z.object({ verifier: z.string() }).parse(
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
      const authenticated = authSchema.parse(
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
        families,
        authenticated.wallets,
        authenticated.page?.cursor || undefined
      );
      discovered = true;
      state.credential.expiresAt = authenticated.credential.expiresAt;
      await this.save(state);
    }
    for (const family of families) {
      if (state.wallets[family]) continue;
      if (!discovered) {
        await this.discover(state, families, [], '');
        discovered = true;
        await this.save(state);
        if (state.wallets[family]) continue;
      }
      if (state.creating.includes(family))
        throw new WalletError(
          'CREATION_UNCERTAIN',
          'A previous create request has an unknown outcome. Restore again after upstream recovery; no duplicate wallet will be created.',
          409
        );
      state.creating.push(family);
      await this.save(state);
      try {
        const { wallet } = z.object({ wallet: walletSchema }).parse(
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
      const page = listSchema.parse(
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
      const bound = walletSchema.parse(
        z
          .object({ wallet: walletSchema })
          .parse(await this.call(state, 'UseWallet', { walletId: found[0].id })).wallet
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

  private async revoke(state: State): Promise<void> {
    if (state.credential?.expiresAt && Date.parse(state.credential.expiresAt) > this.now()) {
      try {
        okSchema.parse(
          await this.call(state, 'RevokeCredential', {
            credentialId: state.credential.credentialId
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

  private async readOperation(id: string): Promise<StoredOperationRecord | null> {
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

  async writeOperation(op: StoredOperationRecord) {
    const ids = parseOperationIndex(await this.config.store.read('operationIndex'));
    const added = !ids.includes(op.id);
    if (added) await this.config.store.write('operationIndex', JSON.stringify([...ids, op.id]));
    const open = parseOpenOperationIndex(await this.config.store.read('openOperationIndex'));
    const isOpen = OPEN_STATUSES.has(op.status);
    const next = open && {
      synced: added && open.synced === ids.length ? ids.length + 1 : open.synced,
      ids: isOpen
        ? open.ids.includes(op.id)
          ? open.ids
          : [...open.ids, op.id]
        : open.ids.filter((entry) => entry !== op.id)
    };
    const changed =
      !!open && !!next && (next.synced !== open.synced || next.ids.length !== open.ids.length);
    if (changed && isOpen) await this.writeOpenIndex(next);
    await this.config.store.write(`operation:${op.id}`, JSON.stringify(op));
    if (changed && !isOpen) await this.writeOpenIndex(next);
  }

  private writeOpenIndex(index: { synced: number; ids: string[] }) {
    return this.config.store.write('openOperationIndex', JSON.stringify(index));
  }

  async openOperationIds(): Promise<string[]> {
    const all = parseOperationIndex(await this.config.store.read('operationIndex'));
    const stored = parseOpenOperationIndex(await this.config.store.read('openOperationIndex'));
    const open =
      stored && stored.synced <= all.length ? stored : { synced: 0, ids: [] as string[] };
    if (open.synced === all.length && stored === open) return open.ids;
    const ids = [...open.ids];
    for (const id of all.slice(open.synced)) {
      const op = await this.readOperation(id);
      if ((!op || OPEN_STATUSES.has(op.status)) && !ids.includes(id)) ids.push(id);
    }
    await this.writeOpenIndex({ synced: all.length, ids });
    return ids;
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
