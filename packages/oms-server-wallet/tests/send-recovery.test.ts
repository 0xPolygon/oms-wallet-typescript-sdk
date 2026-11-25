import { describe, expect, it } from 'vitest';

import { UpstreamError } from '@polygonlabs/oms-server-wallet-sdk';

import { createServerWalletInternal } from '../src/wallet.js';
import { TEST_PUBLISHABLE_KEY, sdkHarness } from './helpers.js';

const transfer = {
  chainId: 137 as const,
  to: '0x2222222222222222222222222222222222222222',
  asset: 'native',
  amount: '1000'
};
const executes = (h: ReturnType<typeof sdkHarness>) =>
  h.remote.calls.filter((call) => call.method === 'Execute');

describe('onPrepared on send*', () => {
  it('runs with the quoted operation before Execute, so the txnId can be saved first', async () => {
    const h = sdkHarness();
    const seen: { status: string; txnId?: string; executesBefore: number }[] = [];
    const sent = await h.client.evm.sendTransfer({
      idempotencyKey: 'hooked-send-1',
      ...transfer,
      onPrepared: (operation) => {
        seen.push({
          status: operation.status,
          txnId: operation.quote.txnId,
          executesBefore: executes(h).length
        });
      }
    });
    expect(seen).toEqual([{ status: 'quoted', txnId: sent.quote!.txnId, executesBefore: 0 }]);
    expect(sent.status).toBe('pending');
  });

  it('sends nothing when it throws, and runs again on a retry with the same key', async () => {
    const h = sdkHarness();
    let calls = 0;
    const send = (fail: boolean) =>
      h.client.solana.sendTransfer({
        idempotencyKey: 'hooked-send-2',
        network: 'solana:devnet',
        to: '11111111111111111111111111111111',
        asset: 'native',
        amount: '1000',
        onPrepared: async () => {
          calls++;
          if (fail) throw new Error('database down');
        }
      });
    await expect(send(true)).rejects.toThrow('database down');
    expect(executes(h)).toHaveLength(0);
    expect((await h.client.solana.getOperation('hooked-send-2'))?.status).toBe('quoted');
    expect((await send(false)).status).not.toBe('quoted');
    expect(calls).toBe(2);
    expect(executes(h)).toHaveLength(1);
  });

  it('rejects a non-function onPrepared before contacting WaaS', async () => {
    const h = sdkHarness();
    await expect(
      h.client.tron.sendTransfer({
        idempotencyKey: 'hooked-send-3',
        network: 'tron:nile',
        to: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
        asset: 'native',
        amount: '1',
        onPrepared: 'save' as never
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(h.remote.calls).toHaveLength(0);
  });
});

describe('waitForTransaction', () => {
  it('waits by txnId from a handle with no record of the operation', async () => {
    const h = sdkHarness();
    const sent = await h.client.evm.sendTransfer({ idempotencyKey: 'wait-txn-1', ...transfer });
    // A fresh in-memory handle that never restored: the read binds existing wallets first.
    const other = createServerWalletInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc: {
          subject: 'customer-1',
          issuer: 'https://issuer.example',
          audience: 'oms-server-wallet',
          getIdToken: async () => ({
            token: `fixture-${crypto.randomUUID()}`,
            expiresAt: Math.floor(Date.now() / 1000) + 300
          })
        },
        storage: 'memory'
      },
      { transport: h.remote }
    );
    const waited = other.evm.waitForTransaction(
      { txnId: sent.quote!.txnId, expiresAt: sent.quote!.expiresAt },
      { timeoutMs: 2000, pollIntervalMs: 10 }
    );
    setTimeout(() => (h.remote.txnStatus = 'executed'), 30);
    expect(await waited).toMatchObject({ outcome: 'executed', status: { status: 'executed' } });
  });

  it('ends with reconciliation-required when WaaS shows no claim past the grace window', async () => {
    let now = Date.now();
    const h = sdkHarness({ clock: () => now });
    const prepared = await h.client.evm.prepareTransfer({
      idempotencyKey: 'wait-txn-2',
      ...transfer
    });
    h.remote.txnStatus = 'quoted';
    now = Date.parse(prepared.quote!.expiresAt) + 121_000;
    expect(
      await h.client.evm.waitForTransaction(
        { txnId: prepared.quote!.txnId, expiresAt: prepared.quote!.expiresAt },
        { timeoutMs: 1000 }
      )
    ).toMatchObject({ outcome: 'reconciliation-required', status: { status: 'quoted' } });
  });

  it('reports an inconclusive TransactionFailed read as unknown and keeps waiting', async () => {
    const h = sdkHarness();
    const sent = await h.client.evm.sendTransfer({ idempotencyKey: 'wait-txn-3', ...transfer });
    h.remote.evmStatusError = 7306;
    expect(await h.client.evm.getTransactionStatus(sent.quote!.txnId)).toEqual({
      txnId: sent.quote!.txnId,
      status: 'unknown'
    });
    const waited = h.client.evm.waitForTransaction(
      { txnId: sent.quote!.txnId, expiresAt: sent.quote!.expiresAt },
      { timeoutMs: 2000, pollIntervalMs: 10 }
    );
    setTimeout(() => {
      h.remote.evmStatusError = undefined;
      h.remote.txnStatus = 'executed';
    }, 30);
    expect((await waited).outcome).toBe('executed');
    expect(UpstreamError).toBeDefined();
  });

  it('bounds slow reads by timeoutMs and signal', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore();
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) => {
      if (method === 'TransactionStatus') {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { status: 'pending' };
      }
      return request(method, body, credential);
    };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 25);
    const started = Date.now();
    const aborted = await h.client.evm.waitForTransaction(
      { txnId: 'tx-slow-1', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      { timeoutMs: 2000, signal: ac.signal }
    );
    expect(aborted.outcome).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('keeps waiting after observing pending even if a later read past grace is inconclusive', async () => {
    let now = Date.parse('2026-06-01T00:00:00.000Z');
    const expiresAt = new Date(now + 10_000).toISOString();
    const h = sdkHarness({ clock: () => now });
    await h.client.createOrRestore();
    let polls = 0;
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) => {
      if (method === 'TransactionStatus') {
        polls++;
        if (polls === 1) {
          now += 150_000;
          return { status: 'pending' };
        }
        if (polls === 2) throw new UpstreamError(7306, 'TransactionStatus');
        return { status: 'executed', txnHash: `0x${'a'.repeat(64)}` };
      }
      return request(method, body, credential);
    };
    const res = await h.client.evm.waitForTransaction(
      { txnId: 'tx-monotonic-1', expiresAt },
      { timeoutMs: 300_000, pollIntervalMs: 250 }
    );
    expect(res.outcome).toBe('executed');
    expect(polls).toBe(3);
  });

  it('throws TransactionNotFound before quote expiry instead of swallowing it until timeout', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore();
    h.remote.evmStatusError = 7308;
    await expect(
      h.client.evm.waitForTransaction(
        { txnId: 'tx-missing-1', expiresAt: new Date(Date.now() + 600_000).toISOString() },
        { timeoutMs: 2000, pollIntervalMs: 250 }
      )
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', upstreamCode: 7308 });
  });
});
