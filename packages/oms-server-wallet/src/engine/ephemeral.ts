import type { NetworkFamily } from '../protocol.js';
import type { State } from '../state.js';
import type { ExclusiveExecutor } from '../storage.js';
import type { IdentityWallet, WalletSnapshot } from '../types.js';
import type { EngineCore } from './core.js';

import { WalletError } from '../errors.js';
import { NETWORK_FAMILIES } from '../protocol.js';
import { createSingleProcessExecutor } from '../storage.js';
import { validateFamilies, validateSelection } from './core.js';

const closedError = () =>
  new WalletError('WALLET_CLOSED', 'This in-memory wallet handle has been closed.', 409);

/**
 * Wallet creations in flight in this process, by identity namespace. A handle creating wallets for
 * an identity waits for any other handle in the process that is already doing so, then discovers
 * what that one created instead of creating a second wallet.
 */
const creating = new Map<string, Promise<unknown>>();

/**
 * The in-process queue of one in-memory handle. Every call of the handle runs through it, so once
 * `close()` starts, every later or queued call throws `WALLET_CLOSED`.
 */
export class ClosableExecutor implements ExclusiveExecutor {
  closed = false;
  private readonly inner = createSingleProcessExecutor();

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(closedError());
    return this.inner.run(async () => {
      if (this.closed) throw closedError();
      return task();
    });
  }

  /** Run once more after closing, for the final revoke. */
  runAfterClose<T>(task: () => Promise<T>): Promise<T> {
    return this.inner.run(task);
  }
}

/**
 * Lifecycle of an in-memory handle: bind or create wallets, rotate, close. Transactions and
 * signing run on the same engine as a durable wallet, over this handle's memory and queue.
 */
export class EphemeralLifecycle {
  constructor(
    private readonly core: EngineCore,
    private readonly executor: ClosableExecutor
  ) {}

  private snapshot(state: State): WalletSnapshot {
    return {
      wallets: { ...state.wallets },
      disabled: false,
      expiresAt: state.credential?.expiresAt,
      credentialId: state.credential?.credentialId,
      creationUncertain: state.creating.length > 0
    };
  }

  /** Whether the credential is valid for at least another minute. */
  private signedIn(state: State): boolean {
    const expiresAt = state.credential?.expiresAt;
    return !!expiresAt && Date.parse(expiresAt) > this.core.now() + 60_000;
  }

  /**
   * Bind wallets that exist; never create one. With `families`, costs nothing on a handle that
   * already holds them and a valid credential.
   */
  async restore(families?: readonly NetworkFamily[], selection?: unknown): Promise<WalletSnapshot> {
    const requested = families === undefined ? undefined : validateFamilies(families);
    const pins = validateSelection(selection);
    return this.executor.run(async () => {
      const state = await this.core.load();
      // Without `families` it always looks up which wallets exist, so only a named set can skip.
      const bound = !!requested && requested.every((family) => state.wallets[family]);
      if (!(bound && this.signedIn(state) && !Object.keys(pins).length))
        await this.core.restoreExisting(state, requested, pins);
      return this.snapshot(state);
    });
  }

  /**
   * Bind existing wallets and create the missing ones. Concurrent `create()` calls for one
   * identity within this process run one at a time; across processes the caller must ensure
   * only one creates a new identity's wallets.
   */
  async create(
    families: readonly NetworkFamily[] = ['evm'],
    selection?: unknown
  ): Promise<WalletSnapshot> {
    if (this.executor.closed) throw closedError();
    const requested = validateFamilies(families);
    const pins = validateSelection(selection);
    const key = this.core.config.namespace;
    for (let pending = creating.get(key); pending; pending = creating.get(key))
      await pending.catch(() => undefined);
    const task = this.executor.run(async () => {
      const state = await this.core.load();
      await this.core.ensure(state, requested, { create: true, pins });
      return this.snapshot(state);
    });
    creating.set(key, task);
    try {
      return await task;
    } finally {
      if (creating.get(key) === task) creating.delete(key);
    }
  }

  /** Every wallet WaaS holds for this identity, including duplicates. */
  listWallets(): Promise<readonly IdentityWallet[]> {
    if (this.executor.closed) return Promise.reject(closedError());
    return this.core.listWallets();
  }

  inspect(): Promise<WalletSnapshot> {
    return this.executor.run(async () => this.snapshot(await this.core.load()));
  }

  rotateCredential(): Promise<WalletSnapshot> {
    return this.executor.run(async () => {
      const state = await this.core.load();
      const held = NETWORK_FAMILIES.filter((family) => state.wallets[family]);
      if (!held.length)
        throw new WalletError(
          'WALLET_NOT_INITIALIZED',
          'No wallet has been restored on this handle. Call restore() first.',
          409
        );
      await this.core.revoke(state);
      await this.core.ensure(state, held);
      return this.snapshot(state);
    });
  }

  /**
   * Mark the handle closed, then revoke its credential. Idempotent: a later call revokes again if
   * an earlier revoke failed, and does nothing once the credential is gone.
   */
  async close(): Promise<void> {
    this.executor.closed = true;
    await this.executor.runAfterClose(async () => {
      const state = await this.core.load();
      if (state.credential) await this.core.revoke(state);
    });
  }
}
