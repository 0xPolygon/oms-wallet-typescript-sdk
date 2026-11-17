import { expect, vi } from 'vitest';
import { type Address, type Hex, decodeFunctionData, getAddress, zeroAddress } from 'viem';

import {
  MemoryStorageManager,
  Networks,
  type FeeOptionWithBalance,
  type OMSWallet,
  type OMSWalletExtensionContext,
  type OMSWalletSessionChangeEvent,
  type SendTransactionParams,
  type SendTransactionResponse,
  type WalletAccount
} from '@polygonlabs/oms-wallet';

import type { BackendBalance, BackendWalletCall, PrivacyBackend } from '../src/backend.js';
import { erc20Abi } from '../src/guard.js';
import { privacyContracts } from '../src/networks.js';
import { createPrivacyExtension } from '../src/privacy.js';

export const WALLET: Address = '0x1111111111111111111111111111111111111111';
export const OTHER_WALLET: Address = '0x2222222222222222222222222222222222222222';
export const RECIPIENT: Address = '0x3333333333333333333333333333333333333333';
export const USDC: Address = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
export const NETWORK = Networks.polygon;
export const CONTRACTS = privacyContracts(NETWORK)!;

export interface SentTransaction {
  params: SendTransactionParams;
  txnId: string;
}

/** A wallet that records transactions and behaves like WaaS: prepare, choose fee, execute. */
export class FakeWallet {
  activeWallet: WalletAccount | undefined = account(WALLET);
  readonly sent: SentTransaction[] = [];
  feeOptions: FeeOptionWithBalance[] = [
    feeOption(USDC, 10n, 10_000_000n),
    feeOption(zeroAddress, 5n, 10n ** 18n)
  ];
  /** Overrides the outcome of the n-th transaction (0-based). */
  outcome: (index: number) => Partial<SendTransactionResponse> | Error = () => ({});
  private listeners = new Set<(event: OMSWalletSessionChangeEvent) => void>();

  onSessionChange(listener: (event: OMSWalletSessionChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  switchTo(address: Address | undefined): void {
    this.activeWallet = address ? account(address) : undefined;
    for (const listener of this.listeners) {
      listener(
        (address
          ? { reason: 'walletChanged', activeWallet: this.activeWallet, session: {} }
          : {
              reason: 'signedOut',
              activeWallet: undefined,
              session: undefined
            }) as OMSWalletSessionChangeEvent
      );
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  sendTransaction = vi.fn(
    async (params: SendTransactionParams): Promise<SendTransactionResponse> => {
      const index = this.sent.length;
      const txnId = `txn-${index + 1}`;
      if (params.expectedWallet && this.activeWallet?.address !== params.expectedWallet) {
        throw new Error('The active wallet is not the expected wallet');
      }
      this.sent.push({ params, txnId });
      await params.onPrepared?.(txnId);
      await params.selectFeeOption?.(this.feeOptions);
      const outcome = this.outcome(index);
      if (outcome instanceof Error) throw outcome;
      return {
        txnId,
        status: 'executed',
        txnHash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
        statusResolution: 'resolved',
        ...outcome
      };
    }
  );
}

export function account(address: Address): WalletAccount {
  return { id: `id-${address}`, type: 'ethereum', address, keyOrigin: 'enclave' };
}

export function feeOption(token: Address, value: bigint, available: bigint): FeeOptionWithBalance {
  const native = token === zeroAddress;
  return {
    feeOption: {
      token: {
        network: '137',
        name: native ? 'POL' : 'USDC',
        symbol: native ? 'POL' : 'USDC',
        type: native ? 'native' : 'erc20',
        ...(native ? {} : { contractAddress: token })
      },
      value: value.toString(),
      displayValue: value.toString()
    },
    selection: { token: native ? 'POL' : token },
    availableRaw: available.toString()
  };
}

/** A privacy backend whose answers each test can change. */
export class FakeBackend implements PrivacyBackend {
  readonly address: Address;
  keyFingerprint = 'fingerprint-1';
  allowance = 0n;
  fee = 7n;
  balanceList: BackendBalance[] = [];
  recoverableList: BackendBalance[] = [];
  deliveryStatuses: Array<'pending' | 'delivered' | 'failed'> = ['delivered'];
  /** Calls the backend makes through `send` during a private send. */
  privateSendCalls: (amount: bigint) => BackendWalletCall[] = (total) => [
    approve(USDC, CONTRACTS.sendSpender, total),
    { to: CONTRACTS.pool, data: `${CONTRACTS.depositSelector}00`, value: 0n }
  ];
  depositCall: (token: Address, amount: bigint) => BackendWalletCall = (token, amount) => ({
    to: CONTRACTS.pool,
    data: `${CONTRACTS.depositSelector}00`,
    value: token === zeroAddress ? amount : 0n
  });
  failWith: Partial<Record<keyof PrivacyBackend, Error>> = {};
  destroyed = false;
  readonly calls: string[] = [];

  constructor(address: Address = WALLET) {
    this.address = address;
  }

  private check(name: keyof PrivacyBackend): void {
    this.calls.push(name);
    const error = this.failWith[name];
    if (error) throw error;
  }

  checkContracts(): void {
    this.check('checkContracts');
  }
  async readAllowance(): Promise<bigint> {
    this.check('readAllowance');
    return this.allowance;
  }
  async quoteFee(): Promise<{ fee: bigint; data: unknown }> {
    this.check('quoteFee');
    return { fee: this.fee, data: { feeTerms: true } };
  }
  async buildShieldDeposit(params: { token: Address; amount: bigint }): Promise<BackendWalletCall> {
    this.check('buildShieldDeposit');
    return this.depositCall(params.token, params.amount);
  }
  async privateSend(
    params: { amount: bigint; feeData: unknown },
    send: (call: BackendWalletCall) => Promise<Hex>
  ): Promise<{ deliveryId: string }> {
    this.check('privateSend');
    try {
      for (const call of this.privateSendCalls(params.amount + this.fee)) await send(call);
    } catch {
      // The real provider wraps or replaces errors from the signer.
      throw new Error('provider internal failure: secret detail');
    }
    if (this.failWith.deliveryStatus) throw new Error('provider scheduling failure');
    return { deliveryId: 'delivery-1' };
  }
  async unshield(): Promise<{ txnHash: Hex }> {
    this.check('unshield');
    return { txnHash: `0x${'ab'.repeat(32)}` };
  }
  async recover(params: { to: Address }): Promise<{ txnHashes: Hex[] }> {
    this.check('recover');
    this.recoveredTo = params.to;
    return { txnHashes: [`0x${'cd'.repeat(32)}`] };
  }
  recoveredTo: Address | undefined;
  async balances(): Promise<BackendBalance[]> {
    this.check('balances');
    return this.balanceList;
  }
  async recoverableBalances(): Promise<BackendBalance[]> {
    this.check('recoverableBalances');
    return this.recoverableList;
  }
  async deliveryStatus() {
    this.calls.push('deliveryStatus');
    const status =
      this.deliveryStatuses.length > 1 ? this.deliveryStatuses.shift()! : this.deliveryStatuses[0]!;
    return status === 'delivered' ? { status, txnHash: `0x${'ef'.repeat(32)}` as Hex } : { status };
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

export function approve(token: Address, spender: Address, amount: bigint): BackendWalletCall {
  return {
    to: token,
    data: encodeApprove(spender, amount),
    value: 0n
  };
}

function encodeApprove(spender: Address, amount: bigint): Hex {
  // approve(address,uint256)
  return `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`;
}

export function decodeApproval(data: Hex): { spender: Address; amount: bigint } {
  const decoded = decodeFunctionData({ abi: erc20Abi, data });
  const [spender, amount] = decoded.args as [Address, bigint];
  return { spender: getAddress(spender), amount };
}

/** Builds `oms.privacy` over a fake wallet and backend factory. */
export function setup(
  options: { backends?: FakeBackend[]; storage?: MemoryStorageManager; deployed?: boolean[] } = {}
) {
  const wallet = new FakeWallet();
  const backends = options.backends ?? [new FakeBackend()];
  const created: FakeBackend[] = [];
  const createBackend = vi.fn(async (params: { address: Address; keySignature: string }) => {
    const backend = backends[Math.min(created.length, backends.length - 1)]!;
    created.push(backend);
    expect(params.keySignature).toBe(`signature:${params.address}`);
    return backend;
  });
  const signReservedMessage = vi.fn(
    async (params: { message: string; expectedWallet?: Address }) => {
      return `signature:${params.expectedWallet}`;
    }
  );
  const context: OMSWalletExtensionContext = { signReservedMessage };
  const oms = { wallet } as unknown as OMSWallet;
  const storage = options.storage ?? new MemoryStorageManager();
  // Answers in order, then repeats the last answer; deployed unless a test says otherwise.
  const deployedAnswers = [...(options.deployed ?? [true])];
  const isDeployed = vi.fn(async () =>
    deployedAnswers.length > 1 ? deployedAnswers.shift()! : deployedAnswers[0]!
  );
  const { privacy } = createPrivacyExtension(
    createBackend,
    { storage },
    { isDeployed }
  )(oms, context);
  return {
    privacy,
    wallet,
    backend: backends[0]!,
    backends,
    created,
    createBackend,
    signReservedMessage,
    storage,
    isDeployed
  };
}
