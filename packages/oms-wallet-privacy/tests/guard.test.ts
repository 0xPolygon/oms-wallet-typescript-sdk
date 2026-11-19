import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';

import { PolicyViolation, createDepositGuard } from '../src/guard.js';
import { privacyFee } from '../src/internal/hinkal/backend.js';
import { CONTRACTS, NETWORK, RECIPIENT, USDC, approve } from './fixtures.js';

const deposit = { to: CONTRACTS.pool, data: `${CONTRACTS.depositSelector}00` as const, value: 0n };
const policy = {
  chainId: NETWORK.id,
  token: USDC,
  total: 107n,
  spender: CONTRACTS.sendSpender,
  pool: CONTRACTS.pool,
  depositSelector: CONTRACTS.depositSelector
};
const on = <T extends object>(call: T) => ({ ...call, chainId: NETWORK.id });

describe('deposit guard', () => {
  it('allows reset, approve and deposit in order, each once', () => {
    const guard = createDepositGuard(policy);
    for (const [call, step] of [
      [approve(USDC, CONTRACTS.sendSpender, 0n), 'reset-approval'],
      [approve(USDC, CONTRACTS.sendSpender, 107n), 'approve'],
      [deposit, 'deposit']
    ] as const) {
      expect(guard.authorize(on(call))).toBe(step);
      guard.record(step);
    }
    expect(() => guard.authorize(on(deposit))).toThrow(PolicyViolation);
  });

  it('allows skipping steps but not going back', () => {
    const guard = createDepositGuard(policy);
    guard.record(guard.authorize(on(deposit)));
    expect(() => guard.authorize(on(approve(USDC, CONTRACTS.sendSpender, 107n)))).toThrow(
      'out of order'
    );
  });

  it('refuses other spenders, amounts, targets, networks and values', () => {
    const guard = createDepositGuard(policy);
    expect(() => guard.authorize(on(approve(USDC, RECIPIENT, 107n)))).toThrow('spender');
    expect(() => guard.authorize(on(approve(USDC, CONTRACTS.sendSpender, 108n)))).toThrow('amount');
    expect(() => guard.authorize(on({ to: RECIPIENT, data: '0x', value: 0n }))).toThrow('target');
    expect(() => guard.authorize({ ...deposit, chainId: 1 })).toThrow('network');
    expect(() => guard.authorize(on({ ...deposit, value: 1n }))).toThrow('value');
    expect(() => guard.authorize(on({ ...deposit, data: '0xdeadbeef' }))).toThrow('not a deposit');
    expect(() => guard.authorize(on({ to: USDC, data: '0xa9059cbb', value: 0n }))).toThrow(
      'not an approval'
    );
  });

  it('requires the total as value for native deposits and refuses approvals', () => {
    const guard = createDepositGuard({ ...policy, token: zeroAddress });
    expect(() => guard.authorize(on(deposit))).toThrow('value');
    expect(guard.authorize(on({ ...deposit, value: 107n }))).toBe('deposit');
  });
});

describe('privacy fee', () => {
  it('adds the flat fee and the variable rate on top, rounded up', () => {
    expect(privacyFee(1_000_000n, { flatFee: 10n, variableRate: 0n })).toBe(10n);
    // 1_000_000 * 25 / 9_975 = 2506.26… → 2507
    expect(privacyFee(1_000_000n, { flatFee: 10n, variableRate: 25n })).toBe(2_517n);
    expect(() => privacyFee(1n, { flatFee: 0n, variableRate: 10_000n })).toThrow();
  });
});
