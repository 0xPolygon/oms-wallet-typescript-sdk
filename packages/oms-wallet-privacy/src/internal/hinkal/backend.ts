import type { ExternalActionId, FeeStructure, Hinkal } from '@hinkal/common';
import type { Address, Hex } from 'viem';

import { getAddress, isAddressEqual, sha256, stringToHex } from 'viem';

import type {
  BackendBalance,
  BackendWalletCall,
  CreateBackend,
  PrivacyBackend
} from '../../backend.js';
import type { PrivacyContracts } from '../../networks.js';
import type { DeliveryStatus } from '../../types.js';
import type { SignerState } from './signer.js';

import { loadProvider } from './load.js';
import { createInitialProvider, createSigner } from './signer.js';

// The provider's ContractType values; its package entry does not export the enum.
const POOL_CONTRACT = 0;
const DEPOSIT_ACTION_CONTRACT = 3;
const ERC20_CONTRACT = 4;
const BASIS_POINTS = 10_000n;
/** The variable-rate argument the provider's own app passes for private sends and withdrawals. */
const PRIVATE_SEND_RATE = 25n;
const WITHDRAW_RATE = 0n;

export const createProviderBackend: CreateBackend = async (params) => {
  const { ethers, prepareFromSignature } = await loadProvider();
  const state: SignerState = { send: undefined };
  const signer = createSigner(
    ethers,
    params.address,
    state,
    createInitialProvider(ethers, params.chainIds[0]!)
  );
  // The provider's .d.ts files resolve ethers' CommonJS types while this package compiles against
  // its ESM types; at runtime they are one instance (see load.ts) and nothing checks `instanceof`.
  const hinkal: Hinkal<unknown> = await prepareFromSignature(
    signer as unknown as Parameters<typeof prepareFromSignature>[0],
    params.keySignature,
    { generateProofRemotely: true, disableCaching: true }
  );
  return new ProviderBackend(hinkal, state, params.address);
};

class ProviderBackend implements PrivacyBackend {
  readonly keyFingerprint: string;

  constructor(
    private readonly hinkal: Hinkal<unknown>,
    private readonly state: SignerState,
    readonly address: Address
  ) {
    this.keyFingerprint = sha256(stringToHex(hinkal.getShieldedPublicKey()));
  }

  /**
   * Connects the signer to the provider's own RPC for `chainId`. The provider reads chain state
   * (allowances, gas) through the signer's provider, and skips switching when it believes it is
   * already on the chain, so this always switches before an operation.
   */
  private async useChain(chainId: number): Promise<void> {
    const adapter = this.hinkal.getProviderAdapter(chainId);
    await adapter.switchNetwork({ chainId } as Parameters<typeof adapter.switchNetwork>[0]);
  }

  checkContracts(chainId: number, contracts: PrivacyContracts): void {
    const adapter = this.hinkal.getProviderAdapter(chainId);
    const pool = adapter.getContract(chainId, POOL_CONTRACT);
    const spender = adapter.getContract(chainId, DEPOSIT_ACTION_CONTRACT);
    const selector = pool.interface.getFunction('transact')?.selector;
    if (
      !isAddressEqual(String(pool.target) as Address, contracts.pool) ||
      !isAddressEqual(String(spender.target) as Address, contracts.sendSpender) ||
      selector?.toLowerCase() !== contracts.depositSelector.toLowerCase()
    ) {
      throw new Error('The provider uses contracts outside the allowlist.');
    }
  }

  async readAllowance(
    chainId: number,
    token: Address,
    owner: Address,
    spender: Address
  ): Promise<bigint> {
    const adapter = this.hinkal.getProviderAdapter(chainId);
    const contract = adapter.getContractWithFetcher(chainId, ERC20_CONTRACT, token as never);
    return BigInt(await contract.getFunction('allowance')(owner, spender));
  }

  async quoteFee(params: {
    kind: 'privateSend' | 'unshield';
    chainId: number;
    token: Address;
    amount: bigint;
  }): Promise<{ fee: bigint; data: unknown }> {
    const structure = await this.hinkal.getFeeStructure(
      params.chainId,
      params.token,
      [params.token],
      'Transact' as ExternalActionId,
      [],
      params.kind === 'privateSend' ? PRIVATE_SEND_RATE : WITHDRAW_RATE
    );
    if (!isAddressEqual(structure.feeToken as Address, params.token)) {
      throw new Error('The fee is in another token.');
    }
    return { fee: privacyFee(params.amount, structure), data: structure };
  }

  async buildShieldDeposit(params: {
    chainId: number;
    token: Address;
    amount: bigint;
  }): Promise<BackendWalletCall> {
    await this.useChain(params.chainId);
    const tx = await this.hinkal.deposit(
      params.chainId,
      [params.token],
      [params.amount],
      false,
      true
    );
    if (
      typeof tx !== 'object' ||
      tx === null ||
      !('to' in tx) ||
      typeof tx.to !== 'string' ||
      typeof tx.data !== 'string'
    ) {
      throw new Error('The deposit call is malformed.');
    }
    return {
      to: getAddress(tx.to),
      data: tx.data as Hex,
      value: 'value' in tx && tx.value != null ? BigInt(tx.value as bigint | string) : 0n
    };
  }

  async privateSend(
    params: { chainId: number; token: Address; amount: bigint; to: Address; feeData: unknown },
    send: (call: BackendWalletCall) => Promise<Hex>
  ): Promise<{ deliveryId: string }> {
    await this.useChain(params.chainId);
    this.state.send = send;
    try {
      const result = await this.hinkal.depositAndWithdraw(
        params.chainId,
        params.token,
        [params.amount],
        [params.to],
        undefined,
        params.feeData as FeeStructure,
        false
      );
      if (!result.scheduleId) throw new Error('No delivery was scheduled.');
      return { deliveryId: result.scheduleId };
    } finally {
      this.state.send = undefined;
    }
  }

  async unshield(params: {
    chainId: number;
    token: Address;
    amount: bigint;
    to: Address;
    feeData: unknown;
  }): Promise<{ txnHash: Hex }> {
    await this.useChain(params.chainId);
    const result = await this.hinkal.withdraw(
      params.chainId,
      [params.token],
      [-params.amount],
      params.to,
      false,
      params.token,
      params.feeData as FeeStructure
    );
    const hash = typeof result === 'string' ? result : result.hash;
    return { txnHash: hash as Hex };
  }

  async recover(params: {
    chainId: number;
    token: Address;
    to: Address;
  }): Promise<{ txnHashes: Hex[] }> {
    await this.useChain(params.chainId);
    const hashes = await this.hinkal.withdrawStuckUtxos(params.chainId, params.token, params.to);
    return { txnHashes: hashes as Hex[] };
  }

  async balances(chainIds: ReadonlyArray<number>): Promise<BackendBalance[]> {
    return flatten(await this.hinkal.getTotalBalances([...chainIds], true));
  }

  async recoverableBalances(chainIds: ReadonlyArray<number>): Promise<BackendBalance[]> {
    return flatten(await this.hinkal.getStuckShieldedBalances([...chainIds]));
  }

  async deliveryStatus(deliveryId: string): Promise<DeliveryStatus> {
    const { transactions } = await this.hinkal.checkSendTransactionStatus(deliveryId);
    if (transactions.some((tx) => tx.status === 'failed' || tx.status === 'deposit_failed')) {
      return { status: 'failed' };
    }
    if (transactions.length > 0 && transactions.every((tx) => tx.status === 'completed')) {
      const txnHash = [...transactions].reverse().find((tx) => tx.txHash)?.txHash;
      return txnHash ? { status: 'delivered', txnHash: txnHash as Hex } : { status: 'delivered' };
    }
    return { status: 'pending' };
  }

  async destroy(): Promise<void> {
    this.state.send = undefined;
    await this.hinkal.destroy();
  }
}

/** The fee on top of `amount` so that `amount` arrives: flat fee plus the variable rate, rounded up. */
export function privacyFee(
  amount: bigint,
  structure: Pick<FeeStructure, 'flatFee' | 'variableRate'>
): bigint {
  if (structure.variableRate < 0n || structure.variableRate >= BASIS_POINTS) {
    throw new Error('Invalid fee rate.');
  }
  const numerator = amount * structure.variableRate;
  const denominator = BASIS_POINTS - structure.variableRate;
  const variable =
    structure.variableRate === 0n ? 0n : (numerator + denominator - 1n) / denominator;
  return structure.flatFee + variable;
}

function flatten(
  byChain: Map<number, Array<{ erc20Address: string; balance: bigint }>>
): BackendBalance[] {
  const balances: BackendBalance[] = [];
  for (const [chainId, tokens] of byChain) {
    for (const token of tokens) {
      if (token.balance > 0n)
        balances.push({ chainId, token: getAddress(token.erc20Address), amount: token.balance });
    }
  }
  return balances;
}
