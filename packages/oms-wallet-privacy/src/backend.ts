import type { Address, Hex } from 'viem';

import type { PrivacyContracts } from './networks.js';
import type { DeliveryStatus } from './types.js';

/** A call the backend asks the wallet to send; the chain is the one the operation runs on. */
export interface BackendWalletCall {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

export interface BackendBalance {
  readonly chainId: number;
  readonly token: Address;
  readonly amount: bigint;
}

/**
 * The privacy protocol behind `oms.privacy`, for one wallet. Only the provider adapter implements
 * it; nothing outside that folder may depend on the implementation. Implementations throw plain
 * errors; callers turn them into `OMSWalletPrivacyError` without forwarding their text.
 */
export interface PrivacyBackend {
  readonly address: Address;
  /** Identifies the derived private-balance keys without revealing them. */
  readonly keyFingerprint: string;
  /** Throws if the backend would use other contracts than `contracts` on `chainId`. */
  checkContracts(chainId: number, contracts: PrivacyContracts): void;
  readAllowance(chainId: number, token: Address, owner: Address, spender: Address): Promise<bigint>;
  /** The privacy fee for `amount`, and data `privateSend` or `unshield` needs to charge it. */
  quoteFee(params: {
    kind: 'privateSend' | 'unshield';
    chainId: number;
    token: Address;
    amount: bigint;
  }): Promise<{ fee: bigint; data: unknown }>;
  /** The unsigned deposit call for a shield. Approvals are sent by the caller. */
  buildShieldDeposit(params: {
    chainId: number;
    token: Address;
    amount: bigint;
  }): Promise<BackendWalletCall>;
  /**
   * Deposits and schedules delivery. Wallet transactions go through `send`, which returns the
   * on-chain hash or throws.
   */
  privateSend(
    params: { chainId: number; token: Address; amount: bigint; to: Address; feeData: unknown },
    send: (call: BackendWalletCall) => Promise<Hex>
  ): Promise<{ deliveryId: string }>;
  /** `beforeSubmit` throws to stop; it runs right before the withdrawal is handed to the service. */
  unshield(params: {
    chainId: number;
    token: Address;
    amount: bigint;
    to: Address;
    feeData: unknown;
    beforeSubmit: () => void;
  }): Promise<{ txnHash: Hex }>;
  /** `beforeSubmit` throws to stop; it runs right before the recovery is handed to the service. */
  recover(params: {
    chainId: number;
    token: Address;
    to: Address;
    beforeSubmit: () => void;
  }): Promise<{ txnHashes: Hex[] }>;
  balances(chainIds: ReadonlyArray<number>): Promise<BackendBalance[]>;
  recoverableBalances(chainIds: ReadonlyArray<number>): Promise<BackendBalance[]>;
  deliveryStatus(deliveryId: string): Promise<DeliveryStatus>;
  destroy(): Promise<void>;
}

export interface CreateBackendParams {
  readonly address: Address;
  /** The wallet's signature over the key message; the backend derives its keys from it. */
  readonly keySignature: string;
  readonly chainIds: ReadonlyArray<number>;
}

export type CreateBackend = (params: CreateBackendParams) => Promise<PrivacyBackend>;
