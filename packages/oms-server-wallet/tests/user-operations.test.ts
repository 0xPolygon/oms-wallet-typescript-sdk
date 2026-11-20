import { encodeFunctionData, erc20Abi } from 'viem';
import { describe, expect, it } from 'vitest';

import type { UserOperation } from '@polygonlabs/oms-server-wallet-sdk';

import { sdkHarness } from './helpers.js';

const usdc = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const recipient = '0x2222222222222222222222222222222222222222';
const transferCall = {
  to: usdc,
  abi: erc20Abi,
  functionName: 'transfer',
  args: [recipient, 2_500_000n]
} as const;
const payment: UserOperation = { chainId: 137, calls: [transferCall] };

describe('user operations', () => {
  it('encodes an ABI call and submits it as one sponsored transaction', async () => {
    const h = sdkHarness();
    const op = await h.client.sendUserOperation('payment-1', payment);
    const body = h.remote.calls.find((c) => c.method === 'PrepareEthereumTransaction')!.body;
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [recipient, 2_500_000n]
    });
    expect(body).toMatchObject({ network: '137', to: usdc, value: '0', data, mode: 'relayer' });
    expect(op).toMatchObject({
      kind: 'userOperation',
      status: 'pending',
      transaction: { to: usdc, value: '0', data }
    });
    expect(h.remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(1);
  });
  it('accepts pre-encoded calldata and a native value', async () => {
    const h = sdkHarness();
    const op = await h.client.prepareUserOperation('payable-1', {
      chainId: 8453,
      calls: [{ to: recipient, value: '1000', data: '0xd0E30DB0' }]
    });
    expect(op.status).toBe('quoted');
    expect(op.transaction).toEqual({ to: recipient, value: '1000', data: '0xd0e30db0' });
    expect(h.remote.calls.some((c) => c.method === 'Execute')).toBe(false);
    expect((await h.client.executeUserOperation('payable-1')).status).toBe('pending');
  });
  it('never submits a call twice and rejects changed input under the same ID', async () => {
    const h = sdkHarness();
    h.remote.failExecute = true;
    expect((await h.client.sendUserOperation('payment-2', payment)).status).toBe('unknown');
    expect((await h.create().sendUserOperation('payment-2', payment)).status).toBe('pending');
    h.remote.txnStatus = 'executed';
    expect((await h.client.sendUserOperation('payment-2', payment)).txnHash).toBe(
      `0x${'ab'.repeat(32)}`
    );
    await expect(
      h.client.sendUserOperation('payment-2', {
        chainId: 137,
        calls: [{ to: usdc, abi: erc20Abi, functionName: 'transfer', args: [recipient, 1n] }]
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(h.remote.calls.filter((c) => c.method === 'PrepareEthereumTransaction')).toHaveLength(1);
    expect(h.remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(1);
  });
  it('rejects unsponsored calls without executing them', async () => {
    const h = sdkHarness();
    h.remote.sponsored = false;
    await expect(h.client.sendUserOperation('payment-3', payment)).rejects.toMatchObject({
      code: 'SPONSORSHIP_REQUIRED'
    });
    expect((await h.client.executeUserOperation('payment-3')).status).toBe('failed');
    expect(h.remote.calls.some((c) => c.method === 'Execute')).toBe(false);
  });
  it('rejects batches, self-calls and invalid calls before preparing them', async () => {
    const h = sdkHarness();
    const call = transferCall;
    const cases: [UserOperation, string][] = [
      [{ chainId: 137, calls: [] }, 'UNSUPPORTED_BATCH'],
      [{ chainId: 137, calls: [{ ...call, value: null as unknown as string }] }, 'INVALID_AMOUNT'],
      [{ chainId: 137, calls: [call, call] }, 'UNSUPPORTED_BATCH'],
      [{ chainId: 10, calls: [call] }, 'UNSUPPORTED_CHAIN'],
      [{ chainId: 137, calls: [{ ...call, to: 'usdc' }] }, 'INVALID_ADDRESS'],
      [{ chainId: 137, calls: [{ ...call, value: '-1' }] }, 'INVALID_AMOUNT'],
      [{ chainId: 137, calls: [{ ...call, value: '0.5' }] }, 'INVALID_AMOUNT'],
      [{ chainId: 137, calls: [{ ...call, functionName: 'mint' }] }, 'INVALID_CALL'],
      [{ chainId: 137, calls: [{ ...call, args: [recipient] }] }, 'INVALID_CALL'],
      [{ chainId: 137, calls: [{ to: usdc, data: '0x123' }] }, 'INVALID_CALL'],
      [{ chainId: 137, calls: [{ to: usdc, data: 'transfer' as `0x${string}` }] }, 'INVALID_CALL']
    ];
    for (const [input, code] of cases)
      await expect(h.client.prepareUserOperation('invalid-1', input)).rejects.toMatchObject({
        code
      });
    await h.client.createOrRestore();
    const self = (await h.client.inspect()).wallet!.address;
    await expect(
      h.client.prepareUserOperation('self-call', {
        chainId: 137,
        calls: [{ to: self, data: '0x' }]
      })
    ).rejects.toMatchObject({ code: 'INVALID_CALL' });
    expect(h.remote.calls.some((c) => c.method === 'PrepareEthereumTransaction')).toBe(false);
  });
  it('requires the function name to resolve to a function in the ABI', async () => {
    const h = sdkHarness();
    const twoFunctions = erc20Abi.filter(
      (item) => item.type === 'function' && ['approve', 'transfer'].includes(item.name)
    );
    expect(twoFunctions.map((item) => item.name)).toEqual(['approve', 'transfer']);
    const invalid = [
      { to: usdc, abi: twoFunctions, args: [recipient, 1n] },
      { ...transferCall, functionName: '0x123' },
      { ...transferCall, functionName: '0xgarbage' },
      // transfer(address,uint256): a real selector, but not a function name.
      { ...transferCall, functionName: '0xa9059cbb' },
      { ...transferCall, functionName: 'mint' }
    ];
    for (const call of invalid)
      await expect(
        h.client.prepareUserOperation('abi-check-1', {
          chainId: 137,
          calls: [call]
        } as unknown as UserOperation)
      ).rejects.toMatchObject({ code: 'INVALID_CALL' });
    expect(h.remote.calls.some((c) => c.method === 'PrepareEthereumTransaction')).toBe(false);
  });
  it('rejects mixed, unexpected and malformed call fields with distinct messages', async () => {
    const h = sdkHarness();
    const cases: [unknown, RegExp][] = [
      [{ to: usdc, data: '0x', functionName: 'transfer', args: [] }, /not both/],
      [{ to: usdc, data: '0x', gas: '1' }, /Unexpected call field "gas"/],
      [{ ...transferCall, calldata: '0x' }, /Unexpected call field "calldata"/],
      [{ to: usdc, data: '0x123' }, /even-length hex/],
      [{ to: usdc, data: '0xzz' }, /even-length hex/]
    ];
    for (const [call, message] of cases)
      await expect(
        h.client.prepareUserOperation('fields-1', {
          chainId: 137,
          calls: [call]
        } as unknown as UserOperation)
      ).rejects.toMatchObject({ code: 'INVALID_CALL', message: expect.stringMatching(message) });
  });
  it('treats the same calldata in any letter case as the same call', async () => {
    const h = sdkHarness();
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [recipient, 2_500_000n]
    });
    const upper = `0x${data.slice(2).toUpperCase()}` as const;
    const first = await h.client.prepareUserOperation('same-case-1', {
      chainId: 137,
      calls: [{ to: usdc, data: upper }]
    });
    expect(first.transaction?.data).toBe(data);
    const again = await h.client.prepareUserOperation('same-case-1', {
      chainId: 137,
      calls: [{ to: usdc, data }]
    });
    expect(again.inputHash).toBe(first.inputHash);
    // The ABI form of the same call is the same operation too.
    expect((await h.client.prepareUserOperation('same-case-1', payment)).id).toBe('same-case-1');
    expect(h.remote.calls.filter((c) => c.method === 'PrepareEthereumTransaction')).toHaveLength(1);
  });
  it('fixes the chain and call when the operation is requested', async () => {
    const h = sdkHarness();
    const call = { ...transferCall, args: [recipient, 2_500_000n] as const };
    const input = { chainId: 137, calls: [call] };
    const pending = h.client.prepareUserOperation('snapshot-1', input);
    input.chainId = 8453;
    (call as { args: readonly unknown[] }).args = [recipient, 1n];
    const op = await pending;
    const body = h.remote.calls.find((c) => c.method === 'PrepareEthereumTransaction')!.body;
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [recipient, 2_500_000n]
    });
    expect(op).toMatchObject({ chainId: 137, transaction: { data } });
    expect(body).toMatchObject({ network: '137', data });
    // The original request is the one recorded under this ID.
    expect((await h.client.prepareUserOperation('snapshot-1', payment)).inputHash).toBe(
      op.inputHash
    );
  });
});
