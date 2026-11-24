import type { RecoveryTransaction } from '../authorization.js';
import type { Quote } from '../protocol.js';
import type { StoredEvmOperation } from '../state.js';

import { WalletError } from '../errors.js';

declare const swapsConfigScope: unique symbol;
declare const swapsConfigFacet: unique symbol;

/** Scope of a `trails(...)` swaps configuration: `'wallet'` for `createServerWallet`, `'service'` for `createServerWalletService`. */
export type SwapsConfigScope = 'wallet' | 'service';

/**
 * Opaque swaps provider configuration returned by `trails(...)` from
 * `@polygonlabs/oms-server-wallet-sdk/trails`. Pass to `createServerWallet({ ..., swaps })`
 * or `createServerWalletService({ ..., swaps })`.
 */
export interface SwapsConfig<TScope extends SwapsConfigScope = SwapsConfigScope, TFacet = unknown> {
  readonly [swapsConfigScope]: TScope;
  readonly [swapsConfigFacet]: TFacet;
}

/** Package-private locked wallet primitives passed to the swaps coordinator. Never reacquires the executor. */
export interface LockedEnginePrimitives {
  readonly namespace: string;
  readonly origin?: string;
  runLocked<T>(task: () => Promise<T>): Promise<T>;
  inspectLocked(): Promise<{
    wallet?: { id: string; address: string };
    disabled: boolean;
  }>;
  markSwapsCoordinatedLocked(): Promise<void>;
  readSwapReservationsLocked(): Promise<Readonly<Record<string, number>>>;
  setSwapReservationLocked(swapId: string, chainId: number | null): Promise<void>;
  resolveEvmReconciliationLocked(id: string, txnId: string): Promise<StoredEvmOperation>;
  readEvmOperationsLocked(ids: readonly string[]): Promise<StoredEvmOperation[]>;
  listOpenEvmOperationsLocked(): Promise<StoredEvmOperation[]>;
  refreshEvmOperationLocked(id: string): Promise<StoredEvmOperation | null>;
  prepareEvmTransferLocked(
    id: string,
    transfer: { chainId: number; to: string; asset: string; amount: string },
    options: { allowSwapsPrefix: true; skipGate: true }
  ): Promise<StoredEvmOperation>;
  executeEvmOperationLocked(
    id: string,
    kinds: readonly ('transfer' | 'call' | 'deployment' | 'recovery')[],
    options: { skipGate: true; bypassReviewId?: true }
  ): Promise<StoredEvmOperation>;
  prepareDeploymentLocked(id: string, chainId: number): Promise<StoredEvmOperation>;
  prepareRecoveryLocked(id: string, transaction: RecoveryTransaction): Promise<StoredEvmOperation>;
  signEvmTypedDataLocked(
    id: string,
    chainId: number,
    typedData: unknown,
    options: { allowSwapsPrefix: true }
  ): Promise<StoredEvmOperation>;
}

/** Package-private debit coordination gate checked under the identity executor before EVM debits. */
export interface CoordinatorGate {
  assertChainAvailableLocked(
    chainId: number,
    options?: { readonly exceptOperationId?: string }
  ): Promise<void>;
}

export interface BoundSwaps<TFacet = unknown> {
  readonly gate: CoordinatorGate;
  readonly facet: TFacet;
}

export interface SwapsBinder<TScope extends SwapsConfigScope = SwapsConfigScope, TFacet = unknown> {
  readonly scope: TScope;
  bind(primitives: LockedEnginePrimitives): BoundSwaps<TFacet>;
}

/** Internal capability registry: only `trails(...)` in this same SDK package may register binders. */
const binders = new WeakMap<object, SwapsBinder<SwapsConfigScope, unknown>>();

export function registerSwapsBinder<TScope extends SwapsConfigScope, TFacet>(
  binder: SwapsBinder<TScope, TFacet>
): SwapsConfig<TScope, TFacet> {
  const handle = Object.freeze({}) as SwapsConfig<TScope, TFacet>;
  binders.set(handle, binder);
  return handle;
}

export function resolveSwapsBinder<TScope extends SwapsConfigScope, TFacet>(
  config: SwapsConfig<TScope, TFacet>,
  expectedScope: TScope
): SwapsBinder<TScope, TFacet> {
  if (!config || typeof config !== 'object')
    throw new WalletError(
      'CONFIGURATION',
      'Invalid swaps configuration. Pass the handle returned by trails(...) from @polygonlabs/oms-server-wallet-sdk/trails.',
      503
    );
  const binder = binders.get(config);
  if (!binder)
    throw new WalletError(
      'CONFIGURATION',
      'Unrecognized swaps configuration. Import createServerWallet and trails(...) from the same @polygonlabs/oms-server-wallet-sdk installation.',
      503
    );
  if (binder.scope !== expectedScope)
    throw new WalletError(
      'CONFIGURATION',
      expectedScope === 'wallet'
        ? 'createServerWallet requires trails({ store: { scope: "wallet", adapter } }).'
        : 'createServerWalletService requires trails({ store: { scope: "service", adapter } }).',
      503
    );
  return binder as SwapsBinder<TScope, TFacet>;
}

export type { Quote };
