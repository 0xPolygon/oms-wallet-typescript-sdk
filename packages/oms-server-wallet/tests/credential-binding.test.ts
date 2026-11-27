import { describe, expect, it } from 'vitest';

import { describeOperation } from '@polygonlabs/oms-server-wallet-sdk';

import { sdkHarness } from './helpers.js';

const transfer = {
  chainId: 137 as const,
  to: '0x2222222222222222222222222222222222222222',
  asset: 'native',
  amount: '1000'
};
const calls = (h: ReturnType<typeof sdkHarness>, method: string) =>
  h.remote.calls.filter((call) => call.method === method);

describe('Execute uses the credential that prepared the transaction', () => {
  it('renews before preparing when the credential would expire before the quote', async () => {
    const h = sdkHarness();
    await h.client.createOrRestore();
    const signIns = calls(h, 'CompleteAuth').length;
    // 10 minutes left: a 15-minute quote would outlive it, so preparing signs in first.
    const state = JSON.parse((await h.store.read('wallet'))!);
    state.credential.expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await h.store.write('wallet', JSON.stringify(state));
    const prepared = await h.client.evm.prepareTransfer({
      idempotencyKey: 'renew-cred-1',
      ...transfer
    });
    expect(calls(h, 'CompleteAuth')).toHaveLength(signIns + 1);
    expect(
      (await h.client.evm.execute({ idempotencyKey: 'renew-cred-1', reviewId: prepared.reviewId! }))
        .status
    ).toBe('pending');
  });

  it('fails with nothing sent when the credential was rotated between prepare and execute', async () => {
    const h = sdkHarness();
    const prepared = await h.client.evm.prepareTransfer({
      idempotencyKey: 'rotated-1',
      ...transfer
    });
    await h.client.rotateCredential();
    await expect(
      h.client.evm.execute({ idempotencyKey: 'rotated-1', reviewId: prepared.reviewId! })
    ).rejects.toMatchObject({ code: 'CREDENTIAL_CHANGED' });
    const op = await h.client.evm.getOperation('rotated-1');
    expect(op).toMatchObject({ status: 'failed', error: 'CREDENTIAL_CHANGED', provenUnsent: true });
    expect(describeOperation(op!).action).toBe('safe-to-reprepare');
    expect(calls(h, 'Execute')).toHaveLength(0);
  });

  it('never re-signs in and retries when Execute is refused as Unauthorized', async () => {
    const h = sdkHarness();
    const prepared = await h.client.evm.prepareTransfer({
      idempotencyKey: 'unauth-1',
      ...transfer
    });
    const signIns = calls(h, 'CompleteAuth').length;
    h.remote.evmExecuteRefusal = 7207;
    const op = await h.client.evm.execute({
      idempotencyKey: 'unauth-1',
      reviewId: prepared.reviewId!
    });
    expect(op).toMatchObject({ status: 'failed', error: 'EXECUTE_REFUSED', provenUnsent: true });
    expect(calls(h, 'Execute')).toHaveLength(1);
    expect(calls(h, 'CompleteAuth')).toHaveLength(signIns);
  });
});

describe('an uncertain submission WaaS keeps reporting as quoted', () => {
  it('escalates to RECONCILIATION_REQUIRED after the grace window and can then be resolved', async () => {
    let now = Date.parse('2026-06-01T00:00:00.000Z');
    const h = sdkHarness({ clock: () => now });
    const prepared = await h.client.evm.prepareTransfer({
      idempotencyKey: 'stuck-quoted-1',
      ...transfer
    });
    h.remote.failExecute = true;
    const sent = await h.client.evm.execute({
      idempotencyKey: 'stuck-quoted-1',
      reviewId: prepared.reviewId!
    });
    expect(sent).toMatchObject({ status: 'unknown', error: 'SUBMISSION_UNCERTAIN' });
    h.remote.txnStatus = 'quoted';
    expect(await h.client.evm.refreshOperation('stuck-quoted-1')).toMatchObject({
      status: 'unknown',
      error: 'SUBMISSION_UNCERTAIN'
    });
    now = Date.parse(prepared.quote!.expiresAt) + 121_000;
    const escalated = await h.client.evm.refreshOperation('stuck-quoted-1');
    expect(escalated).toMatchObject({ status: 'unknown', error: 'RECONCILIATION_REQUIRED' });
    expect(
      await h.client.evm.resolveReconciliation({
        idempotencyKey: 'stuck-quoted-1',
        txnId: prepared.quote!.txnId,
        resolution: 'not-broadcast'
      })
    ).toMatchObject({ status: 'expired', operatorResolved: true });
  });
});
