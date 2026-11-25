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
        return {
          wallet: state.wallets.evm,
          disabled: state.disabled,
          credentialId: state.credential?.credentialId
        };
      },
      markSwapsCoordinatedLocked: async () => {
        const state = await this.core.load();
        if (!state.swapsCoordinated) {
          state.swapsCoordinated = true;
          await this.core.save(state);
        }
      },
      adoptEvmOperationsLocked: async (ops) => {
        for (const op of ops) {
          const local = await this.core.readEvmOperation(op.id);
          // The swap record's copy wins only when it shows more progress, for example another
          // process journaled or executed the submission this store still holds as quoted.
          if (!local || operationProgress(op) > operationProgress(local))
            await this.core.writeOperation(op);
        }
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
        const stale: string[] = [];
        for (const id of await this.core.openOperationIds()) {
          const op = await this.core.readOperation(id);
          // A missing record is an orphan from a crash before its first write; prune it too.
          if (!op || !OPEN_STATUSES.has(op.status)) stale.push(id);
          else if (!('family' in op)) out.push(op);
        }
        await this.core.pruneOpenOperations(stale);
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

/** How far an operation has got: preparing, quoted, submitting, in flight, settled. */
function operationProgress(op: StoredEvmOperation): number {
  switch (op.status) {
    case 'preparing':
      return 0;
    case 'quoted':
      return 1;
    case 'submitting':
      return 2;
    case 'pending':
    case 'unknown':
      return 3;
    default:
      return 4;
  }
}
