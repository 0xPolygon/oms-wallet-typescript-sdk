import { describe, expect, it } from 'vitest';

import { SerialExecutor } from '@polygonlabs/oms-server-wallet-sdk';
import { WalletSwaps } from '@polygonlabs/oms-server-wallet-sdk/trails';
import type { WalletSwapsOptions } from '@polygonlabs/oms-server-wallet-sdk/trails';

import { sdkHarness } from './helpers.js';

const transfer = {
  chainId: 137,
  to: '0x2222222222222222222222222222222222222222',
  asset: 'native',
  amount: '1000'
};

async function editStored(
  store: ReturnType<typeof sdkHarness>['store'],
  id: string,
  edit: (op: Record<string, any>) => void
) {
  const op = JSON.parse((await store.read(`operation:${id}`))!);
  edit(op);
  await store.write(`operation:${id}`, JSON.stringify(op));
}

describe('EVM execution settlement', () => {
  it('records a refusal WaaS returns before claiming as failed, without polling forever', async () => {
    const h = sdkHarness();
    await h.client.prepareTransfer('refused-1', transfer);
    h.remote.evmExecuteRefusal = 7306;
    expect(await h.client.executeTransfer('refused-1')).toMatchObject({
      status: 'failed',
      error: 'EXECUTE_REFUSED'
    });
    expect(await h.client.getOperation('refused-1')).toMatchObject({ status: 'failed' });
    expect(h.remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(1);
    expect(await h.client.listOpenOperations()).toEqual([]);
  });

  it.each([
    [7201, 'invalid signature'],
    [7205, 'usage limit'],
    [7206, 'nonce replay']
  ])(
    'records a credential refusal (%i, %s) as failed: WaaS rejected it before Execute ran',
    async (code) => {
      const h = sdkHarness();
      await h.client.prepareTransfer(`credential-refused-${code}`, transfer);
      h.remote.evmExecuteRefusal = code;
      expect(await h.client.executeTransfer(`credential-refused-${code}`)).toMatchObject({
        status: 'failed',
        error: 'EXECUTE_REFUSED'
      });
    }
  );

  it('keeps an ambiguous refusal unknown, then expires it once no claim can still land', async () => {
    const h = sdkHarness();
    await h.client.prepareTransfer('ambiguous-1', transfer);
    h.remote.evmExecuteRefusal = 7309;
    expect(await h.client.executeTransfer('ambiguous-1')).toMatchObject({
      status: 'unknown',
      error: 'SUBMISSION_UNCERTAIN'
    });
    h.remote.evmStatusError = 7309;
    // Within the grace period after the quote's expiry, an Execute that started in time may still
    // claim it, so polling keeps failing rather than settling.
    await expect(h.client.getOperation('ambiguous-1')).rejects.toMatchObject({
      upstreamCode: 7309
    });
    await editStored(h.store, 'ambiguous-1', (op) => {
      op.quote.expiresAt = new Date(Date.now() - 121_000).toISOString();
    });
    expect(await h.client.getOperation('ambiguous-1')).toMatchObject({
      status: 'expired',
      error: 'TRANSACTION_EXPIRED'
    });
    expect(h.remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(1);
  });

  it('records a quote that expired before submission', async () => {
    const h = sdkHarness();
    await h.client.prepareTransfer('expired-1', transfer);
    await editStored(h.store, 'expired-1', (op) => {
      op.quote.expiresAt = new Date(0).toISOString();
    });
    await expect(h.client.executeTransfer('expired-1')).rejects.toMatchObject({
      code: 'QUOTE_EXPIRED'
    });
    expect(await h.client.getOperation('expired-1')).toMatchObject({ status: 'expired' });
    expect(h.remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(0);
  });
});

describe('EVM operation records', () => {
  it('quotes again under the same ID when a preparation was interrupted', async () => {
    const h = sdkHarness();
    await h.client.prepareTransfer('interrupted-1', transfer);
    await editStored(h.store, 'interrupted-1', (op) => {
      op.status = 'preparing';
      delete op.quote;
    });
    expect(await h.create().prepareTransfer('interrupted-1', transfer)).toMatchObject({
      status: 'quoted'
    });
    expect(h.remote.calls.filter((c) => c.method === 'PrepareEthereumTransaction')).toHaveLength(2);
  });

  it('records a signature that fails verification, and never signs it again', async () => {
    const h = sdkHarness();
    h.remote.signaturesValid = false;
    await expect(h.client.signMessage('sign-invalid', 137, 'hello')).rejects.toMatchObject({
      code: 'SIGNATURE_INVALID'
    });
    expect(await h.create().signMessage('sign-invalid', 137, 'hello')).toMatchObject({
      status: 'failed',
      error: 'SIGNATURE_INVALID'
    });
    expect(h.remote.calls.filter((c) => c.method === 'SignMessage')).toHaveLength(1);
  });

  it('lists only open operations, building the index from existing records once', async () => {
    const h = sdkHarness();
    await h.client.prepareTransfer('open-op-1', transfer);
    await h.client.signMessage('closed-op-1', 137, 'hello');
    // Records written before the open index existed.
    h.store.values.delete('openOperationIndex');
    expect((await h.client.listOpenOperations()).map((op) => op.id)).toEqual(['open-op-1']);
    expect(JSON.parse((await h.store.read('openOperationIndex'))!)).toEqual(['open-op-1']);
    await h.client.executeTransfer('open-op-1');
    h.remote.txnStatus = 'executed';
    await h.client.getOperation('open-op-1');
    expect(await h.client.listOpenOperations()).toEqual([]);
    expect(
      (await h.client.readOperations(['closed-op-1', 'missing-op-1'])).map((op) => op.id)
    ).toEqual(['closed-op-1']);
  });
});

describe('open operation index', () => {
  it('lists a new operation as open before its record is written', async () => {
    const h = sdkHarness();
    await h.client.prepareTransfer('open-op-a1', transfer);
    expect(await h.client.listOpenOperations()).toHaveLength(1);
    const write = h.store.write.bind(h.store);
    h.store.write = async (key, value) => {
      if (key === 'operation:open-op-b2') throw new Error('Store unavailable');
      return write(key, value);
    };
    await expect(h.client.prepareTransfer('open-op-b2', transfer)).rejects.toThrow();
    // A crash here must not leave the operation missing from the index; readers check records.
    expect(JSON.parse((await h.store.read('openOperationIndex'))!)).toEqual([
      'open-op-a1',
      'open-op-b2'
    ]);
    h.store.write = write;
    expect((await h.client.listOpenOperations()).map((op) => op.id)).toEqual(['open-op-a1']);
  });
});

describe('WalletSwaps', () => {
  it("refuses the wallet's own executor, which would wait on itself", () => {
    const h = sdkHarness();
    const executor = (h.client as unknown as { options: { executor: SerialExecutor } }).options
      .executor;
    expect(
      () => new WalletSwaps({ wallet: h.client, executor } as unknown as WalletSwapsOptions)
    ).toThrow(/own executor/);
    expect(
      () =>
        new WalletSwaps({
          wallet: h.client,
          executor: new SerialExecutor()
        } as unknown as WalletSwapsOptions)
    ).not.toThrow();
  });
});
