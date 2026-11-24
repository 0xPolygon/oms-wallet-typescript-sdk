import type { WalletEngineConfig } from './engine/core.js';
import type { CoordinatorGate, LockedEnginePrimitives } from './internal/swapsBridge.js';
import type { StoredEvmOperation } from './state.js';

import { requireRecoveryPermit } from './authorization.js';
import { ChainEngine } from './engine/chain.js';
import { EngineCore } from './engine/core.js';
import { EvmEngine } from './engine/evm.js';
import { OPEN_STATUSES } from './engine/inputs.js';
import { WalletError } from './errors.js';

export { parseAmount } from './engine/inputs.js';

/**
 * Internal wallet engine: one `EngineCore` (identity state, credential, operation store) shared by
 * the EVM and Solana/Tron engines, plus the locked primitives given to the Trails coordinator.
 */
export class WalletEngine {
  readonly core: EngineCore;
  readonly evm: EvmEngine;
  readonly chain: ChainEngine;

  constructor(config: WalletEngineConfig) {
    this.core = new EngineCore(config);
    this.evm = new EvmEngine(this.core);
    this.chain = new ChainEngine(this.core);
  }

  /** Attach the swaps debit gate once, before exposing any public wallet facade. */
  attachGate(gate: CoordinatorGate): void {
    if (this.core.gate)
      throw new WalletError('CONFIGURATION', 'Swaps coordinator is already attached.', 503);
    this.core.gate = gate;
  }

  /** Package-private locked primitives given solely to the bound swaps coordinator. */
  lockedPrimitives(): LockedEnginePrimitives {
    return {
      namespace: this.core.config.namespace,
      origin: this.core.config.origin,
      runLocked: (task) => this.core.config.executor.run(task),
      inspectLocked: async () => {
        const state = await this.core.load();
        return { wallet: state.wallets.evm, disabled: state.disabled };
      },
      markSwapsCoordinatedLocked: async () => {
        const state = await this.core.load();
        if (!state.swapsCoordinated) {
          state.swapsCoordinated = true;
          await this.core.save(state);
        }
      },
      readSwapReservationsLocked: async () => {
        const state = await this.core.load();
        return { ...(state.swapReservations ?? {}) };
      },
      setSwapReservationLocked: async (swapId, chainId) => {
        const state = await this.core.load();
        const next: Record<string, number> = { ...(state.swapReservations ?? {}) };
        if (chainId === null) {
          if (!(swapId in next)) return;
          delete next[swapId];
        } else {
          if (next[swapId] === chainId) return;
          next[swapId] = chainId;
        }
        state.swapReservations = Object.keys(next).length > 0 ? next : undefined;
        await this.core.save(state);
      },
      resolveEvmReconciliationLocked: (id, txnId) =>
        this.evm.resolveEvmReconciliationInternal(id, txnId, { allowInternal: true }),
      readEvmOperationsLocked: async (ids) => {
        const out: StoredEvmOperation[] = [];
        for (const id of new Set(ids)) {
          const op = await this.core.readEvmOperation(id);
          if (op) out.push(op);
        }
        return out;
      },
      listOpenEvmOperationsLocked: async () => {
        const out: StoredEvmOperation[] = [];
        const settled: string[] = [];
        for (const id of await this.core.openOperationIds()) {
          const op = await this.core.readEvmOperation(id);
          if (!op) continue;
          if (OPEN_STATUSES.has(op.status)) out.push(op);
          else settled.push(id);
        }
        await this.core.pruneOpenOperations(settled);
        return out;
      },
      refreshEvmOperationLocked: async (id) => {
        const op = await this.core.readEvmOperation(id);
        return op ? this.evm.refreshEvm(op) : null;
      },
      prepareEvmTransferLocked: (id, transfer, options) =>
        this.evm.prepareEvmTransferInternal(id, transfer, 'immediate', options),
      executeEvmOperationLocked: (id, kinds, options) =>
        this.evm.executeEvmInternal(id, kinds, undefined, options),
      prepareDeploymentLocked: (id, chainId) =>
        this.evm.prepareInternalEvm(id, chainId, 'deployment'),
      prepareRecoveryLocked: (id, transaction) => {
        requireRecoveryPermit(transaction);
        return this.evm.prepareInternalEvm(id, transaction.chainId, 'recovery', transaction);
      },
      signEvmTypedDataLocked: (id, chainId, typedData, options) =>
        this.evm.signEvmTypedDataInternal(id, chainId, typedData, options)
    };
  }
}
