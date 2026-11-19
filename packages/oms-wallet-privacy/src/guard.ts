import type { Address, Hex } from 'viem';

import { decodeFunctionData, isAddressEqual, parseAbi, zeroAddress } from 'viem';

import type { PrivacyTransactionStep } from './types.js';

export const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)'
]);

/** What one deposit may send from the wallet. */
export interface DepositPolicy {
  readonly chainId: number;
  /** `zeroAddress` for the native token. */
  readonly token: Address;
  /** `amount + fee`: the most the deposit may move. */
  readonly total: bigint;
  /** The only approval spender allowed. */
  readonly spender: Address;
  /** The only contract the deposit may call. */
  readonly pool: Address;
  readonly depositSelector: Hex;
}

export interface WalletCall {
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/** Thrown for a call the policy does not allow; the caller maps it to a public error. */
export class PolicyViolation extends Error {
  override readonly name = 'PolicyViolation';
}

const ORDER: Record<PrivacyTransactionStep, number> = {
  'reset-approval': 0,
  approve: 1,
  deposit: 2
};

/**
 * Allows, in this order and at most once each: `approve(spender, 0)`, `approve(spender, total)` and
 * one deposit call to `pool` carrying `total` as value for the native token (none otherwise). With
 * the allowance left at exactly `total` before the deposit, the deposit can move at most `total`.
 * Beyond that cap the privacy backend is trusted to build the intended deposit.
 */
export function createDepositGuard(policy: DepositPolicy): {
  authorize(call: WalletCall): PrivacyTransactionStep;
  record(step: PrivacyTransactionStep): void;
} {
  const sent = new Set<PrivacyTransactionStep>();
  let last = -1;
  const native = isAddressEqual(policy.token, zeroAddress);

  function classify(call: WalletCall): PrivacyTransactionStep {
    if (call.chainId !== policy.chainId)
      throw new PolicyViolation('The call is for another network.');

    if (!native && isAddressEqual(call.to, policy.token)) {
      if (call.value !== 0n) throw new PolicyViolation('The token call carries value.');
      let spender: Address;
      let amount: bigint;
      try {
        const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
        if (decoded.functionName !== 'approve') throw new Error('not an approval');
        [spender, amount] = decoded.args;
      } catch {
        throw new PolicyViolation('The token call is not an approval.');
      }
      if (!isAddressEqual(spender, policy.spender)) {
        throw new PolicyViolation('The approval spender is not allowed.');
      }
      if (amount === 0n) return 'reset-approval';
      if (amount === policy.total) return 'approve';
      throw new PolicyViolation('The approval amount does not match the quote.');
    }

    if (isAddressEqual(call.to, policy.pool)) {
      if (!call.data.toLowerCase().startsWith(policy.depositSelector.toLowerCase())) {
        throw new PolicyViolation('The call is not a deposit.');
      }
      if (call.value !== (native ? policy.total : 0n)) {
        throw new PolicyViolation('The deposit value does not match the quote.');
      }
      return 'deposit';
    }

    throw new PolicyViolation('The call target is not allowed.');
  }

  return {
    authorize(call) {
      const step = classify(call);
      if (sent.has(step)) throw new PolicyViolation(`The ${step} step was already sent.`);
      if (ORDER[step] < last) throw new PolicyViolation(`The ${step} step is out of order.`);
      return step;
    },
    record(step) {
      sent.add(step);
      last = Math.max(last, ORDER[step]);
    }
  };
}
