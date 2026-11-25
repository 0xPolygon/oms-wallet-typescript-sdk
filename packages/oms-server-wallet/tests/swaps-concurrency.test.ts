import { describe, expect, it } from 'vitest';

import { swapHarness } from './swap-harness.js';

type Harness = Awaited<ReturnType<typeof swapHarness>>;
const executes = (h: Harness) => h.waas.remote.calls.filter((c) => c.method === 'Execute');
const transferOn = (chainId: 137 | 8453, idempotencyKey: string) => ({
  idempotencyKey,
  chainId,
  to: '0x2222222222222222222222222222222222222222',
  asset: 'native',
  amount: '1'
});

describe('swap holds live on the swap entry', () => {
  it('holds the origin chain for this and every other process of the wallet', async () => {
    const h = await swapHarness();
    await h.confirm();
    expect(h.store.entries.get('swap-test-0001')!.reservedChainId).toBe(137);
    const other = await h.worker();
    for (const wallet of [h.wallet, other])
      await expect(
        wallet.evm.prepareTransfer(transferOn(137, `held-${crypto.randomUUID()}`))
      ).rejects.toMatchObject({ code: 'DEBIT_PENDING' });
    expect((await other.evm.prepareTransfer(transferOn(8453, 'other-chain-1'))).status).toBe(
      'quoted'
    );
  });

  it('leaves no hold behind when the swap store refuses a write', async () => {
    const h = await swapHarness();
    const q = await h.quote();
    h.store.fail = (record) => record.phase === 'preparing';
    await expect(h.swaps.confirm({ swapId: q.id, reviewId: q.quote.reviewId })).rejects.toThrow(
      'Simulated storage outage'
    );
    h.store.fail = undefined;
    expect(h.store.entries.get(q.id)!.reservedChainId).toBeNull();
    expect((await h.wallet.evm.prepareTransfer(transferOn(137, 'after-outage-1'))).status).toBe(
      'quoted'
    );
  });
});

describe('several processes advancing one swap', () => {
  it('funds a swap exactly once when two processes tick it at the same time', async () => {
    const h = await swapHarness();
    await h.confirm();
    const other = await h.worker();
    for (let i = 0; i < 6; i++) {
      h.advance(5001);
      await Promise.all([h.swaps.tick(), other.swaps.tick()]);
    }
    expect(executes(h)).toHaveLength(1);
    h.waas.remote.txnStatus = 'executed';
    h.advance(5001);
    await other.swaps.tick();
    expect((await h.record()).fundingConfirmed).toBe(true);
    expect(executes(h)).toHaveLength(1);
  });

  it('returns the same swap to two processes quoting one swap ID at once', async () => {
    const h = await swapHarness();
    const other = await h.worker();
    const [a, b] = await Promise.all([
      h.swaps.quote({ idempotencyKey: 'swap-test-0001', ...h.fixture.input }),
      other.swaps.quote({ idempotencyKey: 'swap-test-0001', ...h.fixture.input })
    ]);
    expect(a.id).toBe(b.id);
    expect(a.quote.reviewId).toBe(b.quote.reviewId);
  });

  it('lets the store refuse a second swap for one intent', async () => {
    const h = await swapHarness();
    await h.quote('swap-test-0001');
    // A store whose intent lookup misses the existing swap still refuses the duplicate insert.
    h.store.findIntent = async () => null;
    await expect(h.quote('swap-test-0002')).rejects.toMatchObject({
      code: 'INTENT_ALREADY_TRACKED'
    });
  });

  it('polls a journaled funding submission on takeover instead of funding again', async () => {
    const h = await swapHarness();
    await h.confirm();
    await h.tick(3);
    expect((await h.record()).action).toBe('fund');
    // The process dies after Execute: its later writes to the swap store never land.
    h.store.fail = (record) =>
      record.funding?.status !== undefined && record.funding.status !== 'submitting';
    await expect(h.tick()).rejects.toThrow('Simulated storage outage');
    h.store.fail = undefined;
    expect((await h.record()).funding?.status).toBe('submitting');
    expect(executes(h)).toHaveLength(1);
    // Another process, with its own wallet state and credential, takes over.
    const other = await h.worker();
    h.advance(5001);
    await other.swaps.tick();
    h.waas.remote.txnStatus = 'executed';
    h.advance(5001);
    await other.swaps.tick();
    expect((await h.record()).fundingConfirmed).toBe(true);
    expect(executes(h)).toHaveLength(1);
  });

  it('prepares the funding again when its preparing credential is gone, sending nothing twice', async () => {
    const h = await swapHarness();
    await h.confirm();
    await h.tick(3);
    const prepared = await h.record();
    expect(prepared.action).toBe('fund');
    await h.wallet.rotateCredential();
    // A funding prepared under another credential is first left to that credential's process.
    await h.tick();
    expect((await h.record()).fundingId).toBe(prepared.fundingId);
    h.advance(60_000);
    await h.tick();
    const retried = await h.record();
    expect(retried.fundingId).toBe(`${prepared.fundingId}_r1`);
    expect(retried.action).toBe('prepare-funding');
    expect(executes(h)).toHaveLength(0);
    await h.tick(4);
    expect(executes(h)).toHaveLength(1);
    h.waas.remote.txnStatus = 'executed';
    await h.tick();
    expect((await h.record()).fundingConfirmed).toBe(true);
  });

  it('never journals a bogus submitting status when taking over a foreign-credential quote', async () => {
    const h = await swapHarness();
    await h.confirm();
    await h.tick(3);
    const prepared = await h.record();
    await h.wallet.rotateCredential();
    h.advance(60_000);
    const seenFundingStatuses: (string | undefined)[] = [];
    const origSave = h.store.save.bind(h.store);
    h.store.save = async (entry, opts) => {
      const decoded = await h.store.codec!.decode(entry);
      seenFundingStatuses.push(decoded.funding?.status);
      return origSave(entry, opts);
    };
    await h.tick();
    expect(seenFundingStatuses).not.toContain('submitting');
    expect((await h.record()).fundingId).toBe(`${prepared.fundingId}_r1`);
    expect((await h.record()).action).toBe('prepare-funding');
    expect(executes(h)).toHaveLength(0);
  });

  it('adopts a swap record in pending over a local wallet-store copy stuck in unknown', async () => {
    const h = await swapHarness();
    await h.confirm();
    await h.tick(3);
    h.waas.remote.failExecute = true;
    await h.tick();
    const rec = await h.record();
    expect(JSON.parse((await h.waas.store.read(`operation:${rec.fundingId}`))!).status).toBe(
      'unknown'
    );
    const other = await h.worker();
    h.waas.remote.failExecute = false;
    h.waas.remote.txnStatus = 'pending';
    h.advance(10_000);
    await other.swaps.tick();
    // Even when disabled (no remote refresh), adopting updates local wallet store from unknown -> pending.
    await h.wallet.disable();
    h.advance(10_000);
    await h.tick();
    expect(JSON.parse((await h.waas.store.read(`operation:${rec.fundingId}`))!).status).toBe(
      'pending'
    );
  });

  it('rejects an idempotent quote hit when the configured Trails environment changed', async () => {
    const h = await swapHarness();
    const q = await h.quote('swap-env-0001');
    const rec = await h.store.getRecord(q.id);
    rec!.environment = 'other-env';
    await h.store.putRecord(rec!, null);
    await expect(h.quote('swap-env-0001')).rejects.toMatchObject({
      code: 'SWAP_ENVIRONMENT_CHANGED'
    });
  });
});

describe('swaps on in-memory handles', () => {
  it('runs a swap from in-memory handles that share only the swap store, funding it once', async () => {
    const h = await swapHarness();
    const [a, b] = [await h.ephemeralWorker(), await h.ephemeralWorker()];
    const q = await a.swaps.quote({ idempotencyKey: 'swap-test-0001', ...h.fixture.input });
    await b.swaps.confirm({ swapId: q.id, reviewId: q.quote.reviewId });
    // The hold is visible to the durable wallet and to every in-memory handle.
    await expect(
      h.wallet.evm.prepareTransfer({
        idempotencyKey: 'blocked-by-ephemeral-swap',
        chainId: 137,
        to: '0x2222222222222222222222222222222222222222',
        asset: 'native',
        amount: '1'
      })
    ).rejects.toMatchObject({ code: 'DEBIT_PENDING' });
    for (let i = 0; i < 8; i++) {
      h.advance(5001);
      await Promise.all([a.swaps.tick(), b.swaps.tick()]);
    }
    expect(executes(h)).toHaveLength(1);
    h.waas.remote.txnStatus = 'executed';
    h.advance(61_000);
    await Promise.all([a.swaps.tick(), b.swaps.tick()]);
    expect((await h.record()).fundingConfirmed).toBe(true);
    expect(executes(h)).toHaveLength(1);
    await Promise.all([a.close(), b.close()]);
  });
});
