import { describe, expect, it } from 'vitest';

import { describeOperation } from '@polygonlabs/oms-server-wallet-sdk';

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
  it('records a refusal WaaS returns before claiming as failed (provenUnsent), without polling forever', async () => {
    const h = sdkHarness();
    const prepared = await h.client.evm.prepareTransfer({
      idempotencyKey: 'refused-1',
      ...transfer
    });
    h.remote.evmExecuteRefusal = 7306;
    const failed = await h.client.evm.execute({
      idempotencyKey: 'refused-1',
      reviewId: prepared.reviewId!
    });
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'EXECUTE_REFUSED',
      provenUnsent: true
    });
    expect(describeOperation(failed).action).toBe('safe-to-reprepare');
    expect(await h.client.evm.getOperation('refused-1')).toMatchObject({ status: 'failed' });
    expect(h.remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(1);
    expect((await h.client.evm.listOperations({ status: 'open' })).items).toEqual([]);
  });

  it.each([
    [7201, 'invalid signature'],
    [7205, 'usage limit'],
    [7206, 'nonce replay']
  ])(
    'records a credential refusal (%i, %s) as failed: WaaS rejected it before Execute ran',
    async (code) => {
      const h = sdkHarness();
      const prepared = await h.client.evm.prepareTransfer({
        idempotencyKey: `credential-refused-${code}`,
        ...transfer
      });
      h.remote.evmExecuteRefusal = code;
      expect(
        await h.client.evm.execute({
          idempotencyKey: `credential-refused-${code}`,
          reviewId: prepared.reviewId!
        })
      ).toMatchObject({
        status: 'failed',
        error: 'EXECUTE_REFUSED',
        provenUnsent: true
      });
    }
  );

  it('keeps an ambiguous refusal open and escalates to RECONCILIATION_REQUIRED past grace without falsely expiring it', async () => {
    const h = sdkHarness();
    const prepared = await h.client.evm.prepareTransfer({
      idempotencyKey: 'ambiguous-1',
      ...transfer
    });
    h.remote.evmExecuteRefusal = 7309;
    expect(
      await h.client.evm.execute({
        idempotencyKey: 'ambiguous-1',
        reviewId: prepared.reviewId!
      })
    ).toMatchObject({
      status: 'unknown',
      error: 'SUBMISSION_UNCERTAIN',
      provenUnsent: false
    });
    h.remote.evmStatusError = 7309;
    // Within grace period: still raises 7309 while staying open.
    await expect(h.client.evm.refreshOperation('ambiguous-1')).rejects.toMatchObject({
      upstreamCode: 7309
    });
    await editStored(h.store, 'ambiguous-1', (op) => {
      op.quote.expiresAt = new Date(Date.now() - 121_000).toISOString();
    });
    // Past grace: stays open (`unknown`) with RECONCILIATION_REQUIRED — never silently terminal `expired`!
    const escalated = await h.client.evm.refreshOperation('ambiguous-1');
    expect(escalated).toMatchObject({
      status: 'unknown',
      error: 'RECONCILIATION_REQUIRED',
      provenUnsent: false
    });
    expect(describeOperation(escalated!).action).toBe('reconcile-original');
    expect((await h.client.evm.listOperations({ status: 'open' })).items.map((o) => o.id)).toEqual([
      'ambiguous-1'
    ]);
    // Because it stays open, a later positive WaaS read still settles it cleanly!
    h.remote.evmStatusError = undefined;
    h.remote.txnStatus = 'executed';
    const settled = await h.create().evm.refreshOperation('ambiguous-1');
    expect(settled).toMatchObject({ status: 'executed', txnHash: `0x${'ab'.repeat(32)}` });
    expect((await h.client.evm.listOperations({ status: 'open' })).items).toEqual([]);
    expect(h.remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(1);
  });

  it('keeps a known claim when a later status read is stale', async () => {
    const h = sdkHarness();
    const prepared = await h.client.evm.prepareTransfer({
      idempotencyKey: 'claimed-1',
      ...transfer
    });
    expect(
      (await h.client.evm.execute({ idempotencyKey: 'claimed-1', reviewId: prepared.reviewId! }))
        .status
    ).toBe('pending');
    h.remote.txnStatus = 'quoted';
    expect((await h.client.evm.refreshOperation('claimed-1'))?.status).toBe('pending');
    h.remote.evmStatusError = 7309;
    await editStored(h.store, 'claimed-1', (op) => {
      op.quote.expiresAt = new Date(Date.now() - 600_000).toISOString();
    });
    expect((await h.client.evm.refreshOperation('claimed-1'))?.status).toBe('pending');
    expect((await h.client.evm.listOperations({ status: 'open' })).items).toHaveLength(1);
  });

  it('records a quote that expired locally before submission as terminal expired (provenUnsent)', async () => {
    const h = sdkHarness();
    const prepared = await h.client.evm.prepareTransfer({
      idempotencyKey: 'expired-1',
      ...transfer
    });
    await editStored(h.store, 'expired-1', (op) => {
      op.quote.expiresAt = new Date(0).toISOString();
    });
    await expect(
      h.client.evm.execute({ idempotencyKey: 'expired-1', reviewId: prepared.reviewId! })
    ).rejects.toMatchObject({
      code: 'QUOTE_EXPIRED'
    });
    const op = await h.client.evm.getOperation('expired-1');
    expect(op).toMatchObject({ status: 'expired', error: 'QUOTE_EXPIRED', provenUnsent: true });
    expect(describeOperation(op!).action).toBe('safe-to-reprepare');
    expect(h.remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(0);
  });
});

describe('EVM operation records', () => {
  it('quotes again under the same ID when a preparation was interrupted', async () => {
    const h = sdkHarness();
    await h.client.evm.prepareTransfer({ idempotencyKey: 'interrupted-1', ...transfer });
    await editStored(h.store, 'interrupted-1', (op) => {
      op.status = 'preparing';
      delete op.quote;
      delete op.reviewId;
    });
    expect(
      await h.create().evm.prepareTransfer({ idempotencyKey: 'interrupted-1', ...transfer })
    ).toMatchObject({
      status: 'quoted'
    });
    expect(h.remote.calls.filter((c) => c.method === 'PrepareEthereumTransaction')).toHaveLength(2);
  });

  it('records a signature that fails verification, and never signs it again', async () => {
    const h = sdkHarness();
    h.remote.signaturesValid = false;
    await expect(
      h.client.evm.signMessage({ idempotencyKey: 'sign-invalid', chainId: 137, message: 'hello' })
    ).rejects.toMatchObject({
      code: 'SIGNATURE_INVALID'
    });
    expect(
      await h
        .create()
        .evm.signMessage({ idempotencyKey: 'sign-invalid', chainId: 137, message: 'hello' })
    ).toMatchObject({
      status: 'failed',
      error: 'SIGNATURE_INVALID'
    });
    expect(h.remote.calls.filter((c) => c.method === 'SignMessage')).toHaveLength(1);
  });

  it('lists only open operations with pagination, building the index from existing records once', async () => {
    const h = sdkHarness();
    const prepared = await h.client.evm.prepareTransfer({
      idempotencyKey: 'open-op-1',
      ...transfer
    });
    await h.client.evm.signMessage({
      idempotencyKey: 'closed-op-1',
      chainId: 137,
      message: 'hello'
    });
    h.store.values.delete('openOperationIndex');
    expect(
      (await h.client.evm.listOperations({ status: 'open' })).items.map((op) => op.id)
    ).toEqual(['open-op-1']);
    expect(JSON.parse((await h.store.read('openOperationIndex'))!).ids).toEqual(['open-op-1']);
    await h.client.evm.execute({ idempotencyKey: 'open-op-1', reviewId: prepared.reviewId! });
    h.remote.txnStatus = 'executed';
    await h.client.evm.refreshOperation('open-op-1');
    expect((await h.client.evm.listOperations({ status: 'open' })).items).toEqual([]);
    const page1 = await h.client.evm.listOperations({ limit: 1 });
    expect(page1.items.map((o) => o.id)).toEqual(['open-op-1']);
    expect(page1.nextCursor).toBe('1');
    const page2 = await h.client.evm.listOperations({ limit: 1, cursor: page1.nextCursor });
    expect(page2.items.map((o) => o.id)).toEqual(['closed-op-1']);
    expect(page2.nextCursor).toBeUndefined();
  });
});

describe('open operation index', () => {
  it('lists a new operation as open before its record is written', async () => {
    const h = sdkHarness();
    await h.client.evm.prepareTransfer({ idempotencyKey: 'open-op-a1', ...transfer });
    expect((await h.client.evm.listOperations({ status: 'open' })).items).toHaveLength(1);
    const write = h.store.write.bind(h.store);
    h.store.write = async (key, value) => {
      if (key === 'operation:open-op-b2') throw new Error('Store unavailable');
      return write(key, value);
    };
    await expect(
      h.client.evm.prepareTransfer({ idempotencyKey: 'open-op-b2', ...transfer })
    ).rejects.toThrow();
    expect(JSON.parse((await h.store.read('openOperationIndex'))!).ids).toEqual([
      'open-op-a1',
      'open-op-b2'
    ]);
    h.store.write = write;
    expect(
      (await h.client.evm.listOperations({ status: 'open' })).items.map((op) => op.id)
    ).toEqual(['open-op-a1']);
  });
});

describe('open operation index with an older SDK writing', () => {
  it('finds an operation an older version appended without updating the open index', async () => {
    const h = sdkHarness();
    await h.client.evm.prepareTransfer({ idempotencyKey: 'new-writer-1', ...transfer });
    expect(
      (await h.client.evm.listOperations({ status: 'open' })).items.map((op) => op.id)
    ).toEqual(['new-writer-1']);
    const legacy = JSON.parse((await h.store.read('operation:new-writer-1'))!);
    const ids = JSON.parse((await h.store.read('operationIndex'))!);
    await h.store.write('operationIndex', JSON.stringify([...ids, 'old-writer-1']));
    await h.store.write(
      'operation:old-writer-1',
      JSON.stringify({ ...legacy, id: 'old-writer-1', status: 'pending' })
    );
    expect(
      (await h.client.evm.listOperations({ status: 'open' })).items.map((op) => op.id).sort()
    ).toEqual(['new-writer-1', 'old-writer-1']);
    await h.client.evm.prepareTransfer({ idempotencyKey: 'new-writer-2', ...transfer });
    expect(
      (await h.client.evm.listOperations({ status: 'open' })).items.map((op) => op.id).sort()
    ).toEqual(['new-writer-1', 'new-writer-2', 'old-writer-1']);
  });

  it('scans entries an older version appended even when a newer write came after them', async () => {
    const h = sdkHarness();
    await h.client.evm.prepareTransfer({ idempotencyKey: 'first-new-1', ...transfer });
    await h.client.evm.listOperations({ status: 'open' });
    const record = JSON.parse((await h.store.read('operation:first-new-1'))!);
    const ids = JSON.parse((await h.store.read('operationIndex'))!);
    await h.store.write('operationIndex', JSON.stringify([...ids, 'old-between-1']));
    await h.store.write(
      'operation:old-between-1',
      JSON.stringify({ ...record, id: 'old-between-1', status: 'unknown' })
    );
    await h.client.evm.prepareTransfer({ idempotencyKey: 'second-new-1', ...transfer });
    expect(
      (await h.client.evm.listOperations({ status: 'open' })).items.map((op) => op.id).sort()
    ).toEqual(['first-new-1', 'old-between-1', 'second-new-1']);
  });
});

describe('open operation index after an interrupted older writer', () => {
  it('keeps an appended ID whose record was not written yet, and finds the record later', async () => {
    const h = sdkHarness();
    await h.client.evm.prepareTransfer({ idempotencyKey: 'before-crash-1', ...transfer });
    await h.client.evm.listOperations({ status: 'open' });
    const record = JSON.parse((await h.store.read('operation:before-crash-1'))!);
    const ids = JSON.parse((await h.store.read('operationIndex'))!);
    await h.store.write('operationIndex', JSON.stringify([...ids, 'crashed-old-1']));
    expect(
      (await h.client.evm.listOperations({ status: 'open' })).items.map((op) => op.id)
    ).toEqual(['before-crash-1']);
    await h.store.write(
      'operation:crashed-old-1',
      JSON.stringify({ ...record, id: 'crashed-old-1', status: 'pending' })
    );
    expect(
      (await h.client.evm.listOperations({ status: 'open' })).items.map((op) => op.id).sort()
    ).toEqual(['before-crash-1', 'crashed-old-1']);
  });
});
