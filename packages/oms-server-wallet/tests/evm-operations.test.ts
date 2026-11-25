import { describe, expect, it } from 'vitest';

import { describeOperation } from '@polygonlabs/oms-server-wallet-sdk';

import { sdkHarness } from './helpers.js';

const transfer = {
  chainId: 137 as const,
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
      h.client.evm.signMessage({
        idempotencyKey: 'sign-invalid',
        chainId: 137 as const,
        message: 'hello'
      })
    ).rejects.toMatchObject({
      code: 'SIGNATURE_INVALID'
    });
    expect(
      await h.create().evm.signMessage({
        idempotencyKey: 'sign-invalid',
        chainId: 137 as const,
        message: 'hello'
      })
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
      chainId: 137 as const,
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

describe('chunked operation index and crash recovery', () => {
  it('rolls over across 256-entry chunks, pages in O(limit) reads, and skips internal/other-family ops', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore({ families: ['evm', 'solana', 'tron'] });
    await h.client.solana.signMessage({ idempotencyKey: 'sol-op-0001', message: 'hi' });
    await h.client.solana.prepareTransfer({
      idempotencyKey: 'sol-open-0001',
      network: 'solana:devnet',
      to: '11111111111111111111111111111111',
      asset: 'native',
      amount: '100'
    });
    await h.client.tron.prepareTransaction({
      idempotencyKey: 'tron-open-0001',
      network: 'tron:nile',
      to: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
      value: '100'
    });
    expect(
      (await h.client.solana.listOperations({ status: 'open' })).items.map((op) => op.id)
    ).toEqual(['sol-open-0001']);
    expect(
      (await h.client.tron.listOperations({ status: 'open' })).items.map((op) => op.id)
    ).toEqual(['tron-open-0001']);

    const total = 262;
    for (let i = 0; i < total; i++) {
      const id = `evm-op-${String(i).padStart(4, '0')}`;
      await h.client.evm.signMessage({
        idempotencyKey: id,
        chainId: 137 as const,
        message: `msg-${i}`
      });
    }
    const meta = JSON.parse((await h.store.read('operationIndex:evm:meta'))!);
    expect(meta).toEqual({ v: 1, chunks: 2, total });
    expect(JSON.parse((await h.store.read('operationIndex:evm:0'))!)).toHaveLength(256);
    expect(JSON.parse((await h.store.read('operationIndex:evm:1'))!)).toHaveLength(6);

    // Count reads for a page crossing the 256 boundary: must be O(limit), not O(total).
    let reads = 0;
    const origRead = h.store.read.bind(h.store);
    h.store.read = async (key) => {
      reads++;
      return origRead(key);
    };
    const cross = await h.client.evm.listOperations({ limit: 5, cursor: '253' });
    expect(cross.items.map((op) => op.id)).toEqual([
      'evm-op-0253',
      'evm-op-0254',
      'evm-op-0255',
      'evm-op-0256',
      'evm-op-0257'
    ]);
    expect(cross.nextCursor).toBe('258');
    // 1 meta + 2 chunks + 6 op reads (limit + 1 lookahead) = 9 reads (vs 264+ in monolithic scan).
    expect(reads).toBeLessThanOrEqual(12);

    const tail = await h.client.evm.listOperations({ limit: 10, cursor: cross.nextCursor });
    expect(tail.items.map((op) => op.id)).toEqual([
      'evm-op-0258',
      'evm-op-0259',
      'evm-op-0260',
      'evm-op-0261'
    ]);
    expect(tail.nextCursor).toBeUndefined();
    h.store.read = origRead;

    // Resuming an interrupted 'preparing' op from chunk 0 after >256 intervening ops never duplicates it.
    const preparingOp = JSON.parse((await h.store.read('operation:evm-op-0000'))!);
    await h.store.write(
      'operation:evm-op-0000',
      JSON.stringify({ ...preparingOp, status: 'preparing' })
    );
    await h.client.evm.signMessage({
      idempotencyKey: 'evm-op-0000',
      chainId: 137 as const,
      message: 'msg-0'
    });
    const metaAfterResume = JSON.parse((await h.store.read('operationIndex:evm:meta'))!);
    expect(metaAfterResume).toEqual({ v: 1, chunks: 2, total });
  });

  it('self-heals after a crash between chunk write and meta update, and handles orphaned crash entries cleanly', async () => {
    const h = sdkHarness();
    await h.client.evm.signMessage({
      idempotencyKey: 'heal-op-1',
      chainId: 137 as const,
      message: 'one'
    });

    // Crash after writing chunk 0 with heal-op-2, before bumping meta.
    const write = h.store.write.bind(h.store);
    h.store.write = async (key, value) => {
      if (key === 'operationIndex:evm:meta') throw new Error('meta write failed');
      return write(key, value);
    };
    await expect(
      h.client.evm.signMessage({
        idempotencyKey: 'heal-op-2',
        chainId: 137 as const,
        message: 'two'
      })
    ).rejects.toThrow('meta write failed');
    h.store.write = write;

    // Next write slices to committed meta.total and cleanly overwrites the uncommitted tail entry.
    await h.client.evm.signMessage({
      idempotencyKey: 'heal-op-3',
      chainId: 137 as const,
      message: 'three'
    });
    expect(JSON.parse((await h.store.read('operationIndex:evm:meta'))!)).toEqual({
      v: 1,
      chunks: 1,
      total: 2
    });
    expect(JSON.parse((await h.store.read('operationIndex:evm:0'))!)).toEqual([
      'heal-op-1',
      'heal-op-3'
    ]);

    // Crash after bumping meta, before writing operation:heal-op-4:
    // listOperations skips the orphan without returning a bogus trailing nextCursor,
    // and immediate retry deduplicates against the committed tail.
    h.store.write = async (key, value) => {
      if (key === 'operation:heal-op-4') throw new Error('record write failed');
      return write(key, value);
    };
    await expect(
      h.client.evm.signMessage({
        idempotencyKey: 'heal-op-4',
        chainId: 137 as const,
        message: 'four'
      })
    ).rejects.toThrow('record write failed');
    h.store.write = write;

    const beforeRetry = await h.client.evm.listOperations({ limit: 2 });
    expect(beforeRetry.items.map((op) => op.id)).toEqual(['heal-op-1', 'heal-op-3']);
    expect(beforeRetry.nextCursor).toBeUndefined();

    await h.client.evm.signMessage({
      idempotencyKey: 'heal-op-4',
      chainId: 137 as const,
      message: 'four'
    });
    expect(JSON.parse((await h.store.read('operationIndex:evm:meta'))!)).toEqual({
      v: 1,
      chunks: 1,
      total: 3
    });
    const afterRetry = await h.client.evm.listOperations({ limit: 10 });
    expect(afterRetry.items.map((op) => op.id)).toEqual(['heal-op-1', 'heal-op-3', 'heal-op-4']);
  });

  it('prunes settled IDs left in openOperationIndex after an interrupted terminal write and rejects corrupted index chunks', async () => {
    const h = sdkHarness();
    await h.client.evm.signMessage({
      idempotencyKey: 'prune-op-1',
      chainId: 137 as const,
      message: 'done'
    });
    await h.client.evm.prepareTransfer({ idempotencyKey: 'prune-op-2', ...transfer });
    // Simulate a crash after operation:prune-op-1 became signed, before removeOpenOperation ran.
    await h.store.write(
      'openOperationIndex',
      JSON.stringify({ v: 1, ids: ['prune-op-1', 'prune-op-2'] })
    );
    expect(
      (await h.client.evm.listOperations({ status: 'open' })).items.map((op) => op.id)
    ).toEqual(['prune-op-2']);
    expect(JSON.parse((await h.store.read('openOperationIndex'))!).ids).toEqual(['prune-op-2']);

    // Truncated chunk fails closed with INVALID_STATE.
    await h.store.write('operationIndex:evm:0', JSON.stringify(['prune-op-1']));
    await expect(h.client.evm.listOperations()).rejects.toMatchObject({
      code: 'INVALID_STATE',
      status: 500
    });
  });
});
