import { encodeFunctionData, erc20Abi } from 'viem';
import { describe, expect, it } from 'vitest';

import type { EvmCallInput } from '@polygonlabs/oms-server-wallet-sdk';

import { sdkHarness } from './helpers.js';

const usdc = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const recipient = '0x2222222222222222222222222222222222222222';
const transferCall = {
  chainId: 137 as const,
  to: usdc,
  abi: erc20Abi,
  functionName: 'transfer',
  args: [recipient, 2_500_000n]
} as const;

describe('EVM contract calls', () => {
  it('encodes an ABI call and submits it as one sponsored transaction', async () => {
    const h = sdkHarness();
    const op = await h.client.evm.sendCall({ idempotencyKey: 'payment-1', ...transferCall });
    const body = h.remote.calls.find((c) => c.method === 'PrepareEthereumTransaction')!.body;
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [recipient, 2_500_000n]
    });
    expect(body).toMatchObject({ network: '137', to: usdc, value: '0', data, mode: 'relayer' });
    expect(op).toMatchObject({
      family: 'evm',
      kind: 'call',
      status: 'pending',
      transaction: { to: usdc, value: '0', data }
    });
    expect(h.remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(1);
  });

  it('accepts pre-encoded calldata and a native value', async () => {
    const h = sdkHarness();
    const op = await h.client.evm.prepareCall({
      idempotencyKey: 'payable-1',
      chainId: 8453 as const,
      to: recipient,
      value: '1000',
      data: '0xd0E30DB0'
    });
    expect(op.status).toBe('quoted');
    expect(op.reviewId).toBeTruthy();
    expect(op.transaction).toEqual({ to: recipient, value: '1000', data: '0xd0e30db0' });
    expect(h.remote.calls.some((c) => c.method === 'Execute')).toBe(false);
    expect(
      (await h.client.evm.execute({ idempotencyKey: 'payable-1', reviewId: op.reviewId! })).status
    ).toBe('pending');
  });

  it('never submits a call twice and rejects changed input under the same ID', async () => {
    const h = sdkHarness();
    h.remote.failExecute = true;
    expect(
      (await h.client.evm.sendCall({ idempotencyKey: 'payment-2', ...transferCall })).status
    ).toBe('unknown');
    expect(
      (await h.create().evm.sendCall({ idempotencyKey: 'payment-2', ...transferCall })).status
    ).toBe('pending');
    h.remote.txnStatus = 'executed';
    expect(
      (await h.client.evm.sendCall({ idempotencyKey: 'payment-2', ...transferCall })).txnHash
    ).toBe(`0x${'ab'.repeat(32)}`);
    await expect(
      h.client.evm.sendCall({
        idempotencyKey: 'payment-2',
        chainId: 137 as const,
        to: usdc,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [recipient, 1n]
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(h.remote.calls.filter((c) => c.method === 'PrepareEthereumTransaction')).toHaveLength(1);
    expect(h.remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(1);
  });

  it('rejects unsponsored calls without executing them', async () => {
    const h = sdkHarness();
    h.remote.sponsored = false;
    await expect(
      h.client.evm.sendCall({ idempotencyKey: 'payment-3', ...transferCall })
    ).rejects.toMatchObject({
      code: 'SPONSORSHIP_REQUIRED'
    });
    expect((await h.client.evm.getOperation('payment-3'))?.status).toBe('failed');
    expect(h.remote.calls.some((c) => c.method === 'Execute')).toBe(false);
  });

  it('rejects self-calls and invalid calls before preparing them', async () => {
    const h = sdkHarness();
    const cases: [unknown, string][] = [
      [{ idempotencyKey: 'invalid-1', ...transferCall, value: null }, 'INVALID_AMOUNT'],
      [{ idempotencyKey: 'invalid-1', ...transferCall, chainId: 999_999 }, 'UNSUPPORTED_CHAIN'],
      [{ idempotencyKey: 'invalid-1', ...transferCall, to: 'usdc' }, 'INVALID_ADDRESS'],
      [{ idempotencyKey: 'invalid-1', ...transferCall, value: '-1' }, 'INVALID_AMOUNT'],
      [{ idempotencyKey: 'invalid-1', ...transferCall, value: '0.5' }, 'INVALID_AMOUNT'],
      [{ idempotencyKey: 'invalid-1', ...transferCall, functionName: 'mint' }, 'INVALID_CALL'],
      [{ idempotencyKey: 'invalid-1', ...transferCall, args: [recipient] }, 'INVALID_CALL'],
      [
        { idempotencyKey: 'invalid-1', chainId: 137 as const, to: usdc, data: '0x123' },
        'INVALID_CALL'
      ],
      [
        { idempotencyKey: 'invalid-1', chainId: 137 as const, to: usdc, data: 'transfer' },
        'INVALID_CALL'
      ]
    ];
    for (const [input, code] of cases)
      await expect(h.client.evm.prepareCall(input as EvmCallInput)).rejects.toMatchObject({ code });
    await h.client.createOrRestore();
    const self = (await h.client.inspect()).wallets.evm!.address;
    await expect(
      h.client.evm.prepareCall({
        idempotencyKey: 'self-call',
        chainId: 137 as const,
        to: self,
        data: '0x'
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
      {
        idempotencyKey: 'abi-check-1',
        chainId: 137 as const,
        to: usdc,
        abi: twoFunctions,
        args: [recipient, 1n]
      },
      { idempotencyKey: 'abi-check-1', ...transferCall, functionName: '0x123' },
      { idempotencyKey: 'abi-check-1', ...transferCall, functionName: '0xgarbage' },
      { idempotencyKey: 'abi-check-1', ...transferCall, functionName: '0xa9059cbb' },
      { idempotencyKey: 'abi-check-1', ...transferCall, functionName: 'mint' }
    ];
    for (const call of invalid)
      await expect(h.client.evm.prepareCall(call as unknown as EvmCallInput)).rejects.toMatchObject(
        { code: 'INVALID_CALL' }
      );
    expect(h.remote.calls).toHaveLength(0);
  });
});
