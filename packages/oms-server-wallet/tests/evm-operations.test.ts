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

  it('keeps a known claim when a later status read is stale', async () => {
    const h = sdkHarness();
    await h.client.prepareTransfer('claimed-1', transfer);
    expect((await h.client.executeTransfer('claimed-1')).status).toBe('pending');
    // A read still showing the row from before the claim: quoted, then TransactionExpired.
    h.remote.txnStatus = 'quoted';
    expect((await h.client.getOperation('claimed-1'))?.status).toBe('pending');
    h.remote.evmStatusError = 7309;
    await editStored(h.store, 'claimed-1', (op) => {
      op.quote.expiresAt = new Date(Date.now() - 600_000).toISOString();
    });
    expect((await h.client.getOperation('claimed-1'))?.status).toBe('pending');
    expect(await h.client.listOpenOperations()).toHaveLength(1);
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
    expect(JSON.parse((await h.store.read('openOperationIndex'))!).ids).toEqual(['open-op-1']);
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
    expect(JSON.parse((await h.store.read('openOperationIndex'))!).ids).toEqual([
      'open-op-a1',
      'open-op-b2'
    ]);
    h.store.write = write;
    expect((await h.client.listOpenOperations()).map((op) => op.id)).toEqual(['open-op-a1']);
  });
});

describe('open operation index with an older SDK writing', () => {
  it('finds an operation an older version appended without updating the open index', async () => {
    const h = sdkHarness();
    await h.client.prepareTransfer('new-writer-1', transfer);
    expect((await h.client.listOpenOperations()).map((op) => op.id)).toEqual(['new-writer-1']);
    // An older SDK version, sharing the store and executor, submits a transfer: it appends to the
    // full index and writes the record, but knows nothing of the open index.
    const legacy = JSON.parse((await h.store.read('operation:new-writer-1'))!);
    const ids = JSON.parse((await h.store.read('operationIndex'))!);
    await h.store.write('operationIndex', JSON.stringify([...ids, 'old-writer-1']));
    await h.store.write(
      'operation:old-writer-1',
      JSON.stringify({ ...legacy, id: 'old-writer-1', status: 'pending' })
    );
    expect((await h.client.listOpenOperations()).map((op) => op.id).sort()).toEqual([
      'new-writer-1',
      'old-writer-1'
    ]);
    // A new operation written after the older one does not hide it either.
    await h.client.prepareTransfer('new-writer-2', transfer);
    expect((await h.client.listOpenOperations()).map((op) => op.id).sort()).toEqual([
      'new-writer-1',
      'new-writer-2',
      'old-writer-1'
    ]);
  });

  it('scans entries an older version appended even when a newer write came after them', async () => {
    const h = sdkHarness();
    await h.client.prepareTransfer('first-new-1', transfer);
    await h.client.listOpenOperations();
    const record = JSON.parse((await h.store.read('operation:first-new-1'))!);
    const ids = JSON.parse((await h.store.read('operationIndex'))!);
    await h.store.write('operationIndex', JSON.stringify([...ids, 'old-between-1']));
    await h.store.write(
      'operation:old-between-1',
      JSON.stringify({ ...record, id: 'old-between-1', status: 'unknown' })
    );
    await h.client.prepareTransfer('second-new-1', transfer);
    expect((await h.client.listOpenOperations()).map((op) => op.id).sort()).toEqual([
      'first-new-1',
      'old-between-1',
      'second-new-1'
    ]);
  });
});

describe('open operation index after an interrupted older writer', () => {
  it('keeps an appended ID whose record was not written yet, and finds the record later', async () => {
    const h = sdkHarness();
    await h.client.prepareTransfer('before-crash-1', transfer);
    await h.client.listOpenOperations();
    const record = JSON.parse((await h.store.read('operation:before-crash-1'))!);
    // An older SDK version appends an ID, then crashes before writing the record.
    const ids = JSON.parse((await h.store.read('operationIndex'))!);
    await h.store.write('operationIndex', JSON.stringify([...ids, 'crashed-old-1']));
    // The index is scanned between the append and the record write.
    expect((await h.client.listOpenOperations()).map((op) => op.id)).toEqual(['before-crash-1']);
    // The older version retries: it writes the record without appending the ID again.
    await h.store.write(
      'operation:crashed-old-1',
      JSON.stringify({ ...record, id: 'crashed-old-1', status: 'pending' })
    );
    expect((await h.client.listOpenOperations()).map((op) => op.id).sort()).toEqual([
      'before-crash-1',
      'crashed-old-1'
    ]);
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
