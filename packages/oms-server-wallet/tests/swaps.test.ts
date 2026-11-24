import { describe, expect, it } from 'vitest';

import { swapView } from '../src/trails/view.js';
import {
  destinationToken,
  owner,
  recoveryCall,
  recoveryFixture,
  token
} from './fixtures/trails.js';
import { swapHarness } from './swap-harness.js';

const executes = (h: Awaited<ReturnType<typeof swapHarness>>) =>
  h.waas.remote.calls.filter((c) => c.method === 'Execute');

async function funded(h: Awaited<ReturnType<typeof swapHarness>>) {
  await h.confirm();
  await h.tick(4);
  h.waas.remote.txnStatus = 'executed';
  await h.tick();
  expect((await h.record()).fundingConfirmed).toBe(true);
}

describe('durable swap execution', () => {
  it.each([false, true])(
    'activates before exactly one sponsored deposit (native=%s), then verifies settlement',
    async (native) => {
      const h = await swapHarness(native);
      await h.confirm();
      await h.tick();
      expect(executes(h)).toHaveLength(0);
      await h.tick();
      expect(h.calls.filter((c) => c === 'activate')).toHaveLength(1);
      expect(executes(h)).toHaveLength(0);
      await h.tick(2);
      expect(executes(h)).toHaveLength(1);
      h.restart();
      await h.tick();
      expect(executes(h)).toHaveLength(1);
      h.waas.remote.txnStatus = 'executed';
      await h.tick();
      expect((await h.record()).phase).toBe('settling');
      h.receipt.status = 'SUCCEEDED';
      h.receipt.summary.destinationToAddress = owner;
      h.receipt.summary.destinationTokenAddress = destinationToken;
      h.receipt.summary.destinationTokenAmount = '9900000';
      await h.tick();
      expect((await h.record()).phase).toBe('succeeded');
      expect(executes(h)).toHaveLength(1);
      expect(h.calls).not.toContain('commit');
    }
  );

  it('keeps retry IDs stable and rejects changed confirmation/input', async () => {
    const h = await swapHarness();
    const quote = await h.quote();
    expect(await h.quote()).toEqual(quote);
    expect(h.calls.filter((c) => c === 'quote')).toHaveLength(1);
    await expect(
      h.swaps.quote({ idempotencyKey: quote.id, ...h.fixture.input, amount: '99' })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(h.swaps.confirm({ swapId: quote.id, reviewId: 'stale' })).rejects.toMatchObject({
      code: 'STALE_QUOTE'
    });
    await Promise.all([
      h.swaps.confirm({ swapId: quote.id, reviewId: quote.quote.reviewId }),
      h.swaps.confirm({ swapId: quote.id, reviewId: quote.quote.reviewId })
    ]);
    await h.tick(4);
    expect(executes(h)).toHaveLength(1);
  });

  it('reconciles a lost activation response before funding', async () => {
    const h = await swapHarness();
    h.flags.loseActivation = true;
    await h.confirm();
    await h.tick(2);
    h.restart();
    h.advance(20_000);
    await h.tick(2);
    expect(h.calls.filter((c) => c === 'activate')).toHaveLength(1);
    expect(executes(h)).toHaveLength(1);
  });

  it('never expires a stale parent snapshot after a submission crash', async () => {
    const h = await swapHarness();
    await h.confirm();
    await h.tick(3);
    h.store.fail = (r) => r.funding?.status === 'pending' || r.funding?.status === 'unknown';
    await expect(h.tick()).rejects.toThrow();
    expect(executes(h)).toHaveLength(1);
    h.store.fail = undefined;
    h.advance(1_000_000);
    h.restart();
    await h.tick();
    expect((await h.record()).action).toBe('fund');
    expect(executes(h)).toHaveLength(1);
    h.waas.remote.txnStatus = 'executed';
    await h.tick();
    expect((await h.record()).fundingConfirmed).toBe(true);
  });

  it('retains an unknown debit through expiry, disable/re-enable, and restarts', async () => {
    const h = await swapHarness();
    await h.confirm();
    h.waas.remote.failExecute = true;
    await h.tick(4);
    h.waas.remote.txnStatus = 'quoted';
    h.advance(1_000_000);
    h.restart();
    await h.tick();
    expect((await h.record()).funding?.status).toBe('unknown');
    await h.wallet.disable();
    const auth = h.waas.remote.calls.length;
    await h.tick();
    expect(h.waas.remote.calls.length).toBe(auth);
    await h.wallet.enable();
    h.waas.remote.txnStatus = 'executed';
    await h.tick();
    expect((await h.record()).fundingConfirmed).toBe(true);
    expect(executes(h)).toHaveLength(1);
  });

  it('blocks concurrent ordinary EVM debits automatically on the same wallet and rejects swp_ IDs', async () => {
    const h = await swapHarness();
    await h.confirm();
    await expect(
      h.wallet.evm.prepareTransfer({
        idempotencyKey: 'normal-transfer',
        chainId: 137,
        to: owner,
        asset: 'native',
        amount: '1'
      })
    ).rejects.toMatchObject({ code: 'DEBIT_PENDING' });
    await h.tick(4);
    await expect(
      h.wallet.evm.execute({ idempotencyKey: 'swp_fund_fake', reviewId: 'review-1234' })
    ).rejects.toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' });
  });

  it('checks fresh funds, sponsorship and approvals before any funding', async () => {
    const h = await swapHarness();
    const q = await h.quote();
    h.flags.balance = '0';
    await expect(
      h.swaps.confirm({ swapId: q.id, reviewId: q.quote.reviewId })
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE'
    });
    h.flags.balance = '10000000';
    await h.confirm();
    h.waas.remote.sponsored = false;
    await h.tick();
    expect((await h.record()).phase).toBe('failed');
    expect(executes(h)).toHaveLength(0);
    expect(h.calls).not.toContain('activate');
  });

  it('does not fund an expired quote or a mismatched/not-yet-visible deposit leg', async () => {
    const h = await swapHarness();
    await h.confirm();
    await h.tick(2);
    h.flags.missingReceipt = true;
    await h.tick();
    expect(executes(h)).toHaveLength(0);
    h.flags.missingReceipt = false;
    h.receipt.depositTransaction!.toAddress = owner;
    await h.tick();
    expect(executes(h)).toHaveLength(0);
    h.advance(1_000_000);
    await h.tick();
    expect((await h.record()).phase).toBe('expired');
  });

  it('requires a successful chain receipt and the managed destination/minimum output', async () => {
    const h = await swapHarness();
    await funded(h);
    h.receipt.status = 'SUCCEEDED';
    h.receipt.summary.destinationToAddress = owner;
    h.receipt.summary.destinationTokenAddress = destinationToken;
    h.receipt.summary.destinationTokenAmount = '1';
    await h.tick();
    expect((await h.record()).phase).toBe('attention');
  });

  it('repairs only a confirmed delayed deposit and does not send another transfer', async () => {
    const h = await swapHarness();
    await funded(h);
    h.intent.status = 'INVALID';
    h.receipt.status = 'INVALID';
    h.receipt.depositTransaction!.status = 'FAILED';
    await h.tick();
    expect(h.calls.filter((c) => c === 'repair')).toHaveLength(1);
    expect(executes(h)).toHaveLength(1);
    await h.tick(8);
    expect(h.calls.filter((c) => c === 'repair')).toHaveLength(1);
  });

  it('keeps polling automatic refunds and binds work to the original environment', async () => {
    const h = await swapHarness();
    await funded(h);
    h.restart(true, 'changed-project');
    await h.tick();
    expect((await h.record()).error).toBe('SWAP_ENVIRONMENT_CHANGED');
    h.restart();
    h.advance(20_000);
    h.receipt.status = 'REFUNDED';
    h.receipt.refundTransaction = {
      ...h.receipt.depositTransaction!,
      type: 'REFUND',
      status: 'SUCCEEDED',
      toAddress: owner
    };
    await h.tick();
    expect((await h.record()).phase).toBe('refunded');
  });

  it('pauses new funding but continues funded observation with the feature disabled', async () => {
    const h = await swapHarness();
    await funded(h);
    h.restart(false);
    h.receipt.status = 'REFUNDED';
    h.receipt.refundTransaction = {
      ...h.receipt.depositTransaction!,
      type: 'REFUND',
      status: 'SUCCEEDED',
      toAddress: owner
    };
    await h.tick();
    expect((await h.record()).phase).toBe('refunded');
    await expect(
      h.swaps.quote({ idempotencyKey: 'new-swap-0002', ...h.fixture.input })
    ).rejects.toMatchObject({
      code: 'SWAPS_DISABLED'
    });
  });

  it('backs off across provider outages without treating a hash as success', async () => {
    const h = await swapHarness();
    await h.confirm();
    await h.tick(4);
    h.waas.remote.txnStatus = 'executed';
    h.flags.chainFailure = true;
    await h.tick();
    expect((await h.record()).fundingConfirmed).toBe(false);
    expect((await h.record()).attempts).toBe(1);
    h.restart();
    h.advance(20_000);
    h.flags.chainFailure = false;
    await h.tick();
    expect((await h.record()).phase).toBe('settling');
  });
});

describe('reviewed recovery', () => {
  async function ready() {
    const h = await swapHarness();
    await funded(h);
    h.intent.status = 'FAILED';
    h.receipt.status = 'FAILED';
    h.flags.intentBalance = '1000';
    return h;
  }

  it('requires a separate review, signs only validated payloads and verifies returned balances', async () => {
    const h = await ready();
    const view = await h.swaps.prepareRecovery({
      swapId: 'swap-test-0001',
      idempotencyKey: 'recovery-0001',
      source: 'origin'
    });
    expect(view.recoveries[0].assets).toEqual([
      { asset: token, amount: '1000', symbol: token, decimals: 6 }
    ]);
    expect(h.calls).not.toContain('buildRecovery');
    await h.swaps.confirmRecovery({
      swapId: view.id,
      recoveryId: 'recovery-0001',
      reviewId: view.recoveries[0].reviewId
    });
    await h.tick(3);
    expect(executes(h)).toHaveLength(2);
    h.restart();
    h.waas.remote.txnStatus = 'executed';
    h.flags.intentBalance = '0';
    h.flags.recovered = true;
    await h.tick();
    expect((await h.record()).recoveries[0].status).toBe('recovered');
    expect((await h.record()).phase).toBe('refunded');
    const publicView = JSON.stringify(swapView(await h.record()));
    expect(publicView).not.toContain('signature');
    expect(publicView).not.toContain('typedData');
    expect(publicView).not.toContain('payloadHash');
  });

  it('discloses owner deployment, waits for code and prevents duplicate deployment after restart', async () => {
    const h = await ready();
    h.flags.deployed = false;
    const v = await h.swaps.prepareRecovery({
      swapId: 'swap-test-0001',
      idempotencyKey: 'recovery-0001',
      source: 'origin'
    });
    expect(v.recoveries[0].requiresOwnerDeployment).toBe(true);
    await h.swaps.confirmRecovery({
      swapId: v.id,
      recoveryId: 'recovery-0001',
      reviewId: v.recoveries[0].reviewId
    });
    await h.tick();
    expect(executes(h)).toHaveLength(2);
    h.restart();
    await h.tick();
    expect(executes(h)).toHaveLength(2);
    expect(h.waas.remote.calls.filter((c) => c.method === 'SignTypedData')).toHaveLength(0);
    h.flags.deployed = true;
    h.waas.remote.txnStatus = 'executed';
    await h.tick(2);
    expect(h.waas.remote.calls.filter((c) => c.method === 'SignTypedData')).toHaveLength(1);
  });

  it('rejects an unknown recovery source as INVALID_RECOVERY', async () => {
    const h = await ready();
    await expect(
      h.swaps.prepareRecovery({
        swapId: 'swap-test-0001',
        idempotencyKey: 'recovery-bad-source',
        source: 'sideways' as 'origin'
      })
    ).rejects.toMatchObject({ code: 'INVALID_RECOVERY' });
  });

  it('rejects a changed recipient, side, balance, expiry or transaction target', async () => {
    const h = await ready();
    h.recovery = recoveryFixture([recoveryCall({ to: owner })]) as typeof h.recovery;
    await expect(
      h.swaps.prepareRecovery({
        swapId: 'swap-test-0001',
        idempotencyKey: 'recovery-bad1',
        source: 'origin'
      })
    ).rejects.toMatchObject({ code: 'INVALID_RECOVERY' });
    h.recovery = recoveryFixture() as typeof h.recovery;
    const v = await h.swaps.prepareRecovery({
      swapId: 'swap-test-0001',
      idempotencyKey: 'recovery-0001',
      source: 'origin'
    });
    h.flags.intentBalance = '999';
    await expect(
      h.swaps.confirmRecovery({
        swapId: v.id,
        recoveryId: 'recovery-0001',
        reviewId: v.recoveries[0].reviewId
      })
    ).rejects.toMatchObject({ code: 'RECOVERY_CHANGED' });
    h.flags.intentBalance = '1000';
    await h.swaps.confirmRecovery({
      swapId: v.id,
      recoveryId: 'recovery-0001',
      reviewId: v.recoveries[0].reviewId
    });
    h.flags.badBuild = true;
    await h.tick(2);
    expect((await h.record()).recoveries[0].status).toBe('failed');
    expect(executes(h)).toHaveLength(1);
  });

  it.each([false, true])(
    'releases a reverted recovery debit for a fresh review without resubmission (deployment=%s)',
    async (deployment) => {
      const h = await ready();
      h.flags.deployed = !deployment;
      const view = await h.swaps.prepareRecovery({
        swapId: 'swap-test-0001',
        idempotencyKey: 'recovery-revert',
        source: 'origin'
      });
      await h.swaps.confirmRecovery({
        swapId: view.id,
        recoveryId: 'recovery-revert',
        reviewId: view.recoveries[0].reviewId
      });
      await h.tick(deployment ? 1 : 3);
      expect(executes(h)).toHaveLength(2);
      h.flags.chainReverted = true;
      h.waas.remote.txnStatus = 'executed';
      h.restart();
      await h.tick();
      const record = await h.record();
      expect(record.recoveries[0].status).toBe('failed');
      expect(record.activeRecoveryId).toBeUndefined();
      expect(record.phase).toBe('attention');
      expect(executes(h)).toHaveLength(2);
      expect(
        (
          await h.swaps.prepareRecovery({
            swapId: view.id,
            idempotencyKey: 'recovery-fresh',
            source: 'origin'
          })
        ).recoveries
      ).toHaveLength(2);
    }
  );

  it('blocks recovery during normal progress, uncertain funding or another active recovery', async () => {
    const h = await swapHarness();
    await funded(h);
    await expect(
      h.swaps.prepareRecovery({
        swapId: 'swap-test-0001',
        idempotencyKey: 'recovery-0001',
        source: 'origin'
      })
    ).rejects.toMatchObject({ code: 'RECOVERY_NOT_READY' });
    h.intent.status = 'FAILED';
    h.flags.intentBalance = '1000';
    const v = await h.swaps.prepareRecovery({
      swapId: 'swap-test-0001',
      idempotencyKey: 'recovery-0001',
      source: 'origin'
    });
    await h.swaps.confirmRecovery({
      swapId: v.id,
      recoveryId: 'recovery-0001',
      reviewId: v.recoveries[0].reviewId
    });
    await expect(
      h.swaps.prepareRecovery({
        swapId: v.id,
        idempotencyKey: 'recovery-0002',
        source: 'origin'
      })
    ).rejects.toMatchObject({
      code: 'RECOVERY_PENDING'
    });
  });

  it('allows recovery when new swaps are paused, but never signs for disabled wallets', async () => {
    const h = await ready();
    h.restart(false);
    const v = await h.swaps.prepareRecovery({
      swapId: 'swap-test-0001',
      idempotencyKey: 'recovery-0001',
      source: 'origin'
    });
    await h.swaps.confirmRecovery({
      swapId: v.id,
      recoveryId: 'recovery-0001',
      reviewId: v.recoveries[0].reviewId
    });
    await h.wallet.disable();
    await h.tick();
    expect(h.waas.remote.calls.filter((c) => c.method === 'SignTypedData')).toHaveLength(0);
  });
});

it('keeps actual partial recovery amounts and permits a fresh review for residual funds', async () => {
  const h = await swapHarness();
  await funded(h);
  h.intent.status = 'FAILED';
  h.receipt.status = 'FAILED';
  h.flags.intentBalance = '1000';
  const view = await h.swaps.prepareRecovery({
    swapId: 'swap-test-0001',
    idempotencyKey: 'recovery-partial',
    source: 'origin'
  });
  await h.swaps.confirmRecovery({
    swapId: view.id,
    recoveryId: 'recovery-partial',
    reviewId: view.recoveries[0].reviewId
  });
  await h.tick(3);
  h.waas.remote.txnStatus = 'executed';
  h.flags.recovered = true;
  h.flags.recoveredAmount = '900';
  h.flags.intentBalance = '0';
  await h.tick();
  const result = await h.swaps.get(view.id);
  expect(result.recoveries[0]).toMatchObject({
    status: 'partial',
    received: [{ asset: token, amount: '900' }]
  });
  expect(result.phase).toBe('attention');
  expect(result.canRecover).toBe(true);
});

it('recovers a destination-side intermediate token without assuming the quoted output token', async () => {
  const h = await swapHarness();
  await funded(h);
  h.intent.status = 'FAILED';
  h.receipt.status = 'FAILED';
  h.flags.intentBalance = '1000';
  h.recovery = {
    ...recoveryFixture([recoveryCall()], 'destination'),
    recoveryTokens: [
      {
        contractAddress: token,
        balance: '1000',
        chainId: 8453,
        decimals: 6,
        symbol: 'INTERMEDIATE'
      }
    ]
  } as typeof h.recovery;
  const view = await h.swaps.prepareRecovery({
    swapId: 'swap-test-0001',
    idempotencyKey: 'recovery-dest-1',
    source: 'destination'
  });
  expect(view.recoveries[0]).toMatchObject({
    chainId: 8453,
    assets: [{ asset: token, symbol: 'INTERMEDIATE' }]
  });
  await h.swaps.confirmRecovery({
    swapId: view.id,
    recoveryId: 'recovery-dest-1',
    reviewId: view.recoveries[0].reviewId
  });
  await h.tick(3);
  h.waas.remote.txnStatus = 'executed';
  h.flags.recovered = true;
  h.flags.intentBalance = '0';
  await h.tick();
  expect((await h.record()).recoveries[0].status).toBe('recovered');
});

it('retains an uncertain recovery through expiry and a crash before the parent commit', async () => {
  const h = await swapHarness();
  await funded(h);
  h.intent.status = 'FAILED';
  h.receipt.status = 'FAILED';
  h.flags.intentBalance = '1000';
  const view = await h.swaps.prepareRecovery({
    swapId: 'swap-test-0001',
    idempotencyKey: 'recovery-crash',
    source: 'origin'
  });
  await h.swaps.confirmRecovery({
    swapId: view.id,
    recoveryId: 'recovery-crash',
    reviewId: view.recoveries[0].reviewId
  });
  await h.tick(2);
  h.store.fail = (r) => r.recoveries[0].transaction?.status === 'pending';
  await expect(h.tick()).rejects.toThrow();
  expect(executes(h)).toHaveLength(2);
  h.store.fail = undefined;
  h.advance(400_000);
  h.restart();
  await h.wallet.disable();
  await h.tick();
  expect((await h.record()).activeRecoveryId).toBe('recovery-crash');
  await h.wallet.enable();
  h.waas.remote.txnStatus = 'executed';
  h.flags.recovered = true;
  h.flags.intentBalance = '0';
  await h.tick();
  expect(executes(h)).toHaveLength(2);
  expect((await h.record()).recoveries[0].status).toBe('recovered');
});

it('never funds the same upstream intent under a second local swap ID', async () => {
  const h = await swapHarness();
  await h.quote();
  await expect(
    h.swaps.quote({ idempotencyKey: 'second-local-id', ...h.fixture.input })
  ).rejects.toMatchObject({
    code: 'INTENT_ALREADY_TRACKED'
  });
});

it('blocks an already prepared ordinary transfer when a swap subsequently reserves its chain', async () => {
  const h = await swapHarness();
  const prepared = await h.wallet.evm.prepareTransfer({
    idempotencyKey: 'prepared-normal-1',
    chainId: 137,
    to: owner,
    asset: 'native',
    amount: '1'
  });
  await h.confirm();
  await expect(
    h.wallet.evm.execute({ idempotencyKey: 'prepared-normal-1', reviewId: prepared.reviewId! })
  ).rejects.toMatchObject({
    code: 'DEBIT_PENDING'
  });
  expect(executes(h)).toHaveLength(0);
});

it('uses fresh recovery state and expires reviews before deploying or signing', async () => {
  const h = await swapHarness();
  await funded(h);
  h.intent.status = 'FAILED';
  h.receipt.status = 'FAILED';
  h.flags.intentBalance = '1000';
  h.flags.deployed = false;
  const view = await h.swaps.prepareRecovery({
    swapId: 'swap-test-0001',
    idempotencyKey: 'recovery-expiry',
    source: 'origin'
  });
  await h.swaps.confirmRecovery({
    swapId: view.id,
    recoveryId: 'recovery-expiry',
    reviewId: view.recoveries[0].reviewId
  });
  h.advance(310_000);
  await h.tick();
  expect((await h.record()).recoveries[0].status).toBe('failed');
  expect(executes(h)).toHaveLength(1);
  expect(h.waas.remote.calls.filter((c) => c.method === 'SignTypedData')).toHaveLength(0);
});

it('coordinates EVM calls with swap debits in both directions on the same wallet', async () => {
  const h = await swapHarness();
  const call = { chainId: 137, to: token, data: '0xd0e30db0' as const };
  const prepared = await h.wallet.evm.prepareCall({ idempotencyKey: 'prepared-call-1', ...call });
  await h.confirm();
  await expect(
    h.wallet.evm.execute({ idempotencyKey: 'prepared-call-1', reviewId: prepared.reviewId! })
  ).rejects.toMatchObject({
    code: 'DEBIT_PENDING'
  });
  await expect(
    h.wallet.evm.sendCall({ idempotencyKey: 'prepared-call-2', ...call })
  ).rejects.toMatchObject({
    code: 'DEBIT_PENDING'
  });
  expect(executes(h)).toHaveLength(0);

  // Retrying an existing review prepare returns it without submitting; immediate send refuses review mode.
  expect(
    (await h.wallet.evm.prepareCall({ idempotencyKey: 'prepared-call-1', ...call })).status
  ).toBe('quoted');
  await expect(
    h.wallet.evm.sendCall({ idempotencyKey: 'prepared-call-1', ...call })
  ).rejects.toMatchObject({
    code: 'APPROVAL_REQUIRED'
  });
  expect(executes(h)).toHaveLength(0);

  const other = await swapHarness();
  await other.wallet.evm.sendCall({ idempotencyKey: 'pending-call-1', ...call });
  const quote = await other.quote();
  await expect(
    other.swaps.confirm({ swapId: quote.id, reviewId: quote.quote.reviewId })
  ).rejects.toMatchObject({
    code: 'DEBIT_PENDING'
  });
});

it('keeps an uncertain EVM debit blocking while its status read is stale inside the grace window', async () => {
  const h = await swapHarness();
  const call = { chainId: 137, to: token, data: '0xd0e30db0' as const };
  h.waas.remote.failExecute = true;
  await h.wallet.evm.sendCall({ idempotencyKey: 'stale-call-1', ...call });
  h.waas.remote.failExecute = false;
  h.waas.remote.evmStatusError = 7309;
  const stored = JSON.parse((await h.waas.store.read('operation:stale-call-1'))!);
  stored.quote.expiresAt = new Date(Date.now() - 10_000).toISOString();
  await h.waas.store.write('operation:stale-call-1', JSON.stringify(stored));
  await expect(
    h.wallet.evm.sendCall({ idempotencyKey: 'stale-call-2', ...call })
  ).rejects.toMatchObject({ code: 'DEBIT_PENDING' });
  const quote = await h.quote();
  await expect(
    h.swaps.confirm({ swapId: quote.id, reviewId: quote.quote.reviewId })
  ).rejects.toMatchObject({ code: 'DEBIT_PENDING' });
});

it('returns a finished EVM call while a swap holds its chain', async () => {
  const h = await swapHarness();
  const call = { chainId: 137, to: token, data: '0xd0e30db0' as const };
  await h.wallet.evm.sendCall({ idempotencyKey: 'finished-call-1', ...call });
  h.waas.remote.txnStatus = 'executed';
  expect((await h.wallet.evm.sendCall({ idempotencyKey: 'finished-call-1', ...call })).status).toBe(
    'executed'
  );
  await h.confirm();
  expect((await h.wallet.evm.sendCall({ idempotencyKey: 'finished-call-1', ...call })).status).toBe(
    'executed'
  );
  expect(executes(h)).toHaveLength(1);
});

it('coordinates on the chain fixed when the EVM call is requested', async () => {
  const h = await swapHarness();
  await h.confirm();
  const input = {
    idempotencyKey: 'moved-call-1',
    chainId: 8453,
    to: token,
    data: '0xd0e30db0' as const
  };
  const pending = h.wallet.evm.prepareCall(input);
  input.chainId = 137;
  const op = await pending;
  expect(op.chainId).toBe(8453);
  const body = h.waas.remote.calls
    .filter((c) => c.method === 'PrepareEthereumTransaction')
    .at(-1)!.body;
  expect(body).toMatchObject({ network: '8453' });
});

describe('settled funding and recovery operations', () => {
  async function editOperation(
    h: Awaited<ReturnType<typeof swapHarness>>,
    id: string,
    edit: (op: Record<string, any>) => void
  ) {
    const op = JSON.parse((await h.waas.store.read(`operation:${id}`))!);
    edit(op);
    await h.waas.store.write(`operation:${id}`, JSON.stringify(op));
  }

  it('releases the origin chain once its own funding is refused before sending', async () => {
    const h = await swapHarness();
    await h.confirm();
    h.waas.remote.evmExecuteRefusal = 7306;
    await h.tick(4);
    const record = await h.record();
    expect(record.funding).toMatchObject({ status: 'failed', error: 'EXECUTE_REFUSED' });
    expect(record).toMatchObject({ phase: 'attention', error: 'FUNDING_FAILED' });
    await expect(
      h.wallet.evm.prepareTransfer({
        idempotencyKey: 'after-refused-funding',
        chainId: 137,
        to: owner,
        asset: 'native',
        amount: '1'
      })
    ).resolves.toMatchObject({ status: 'quoted' });
  });

  it('expires the swap and releases reservation when the wallet funding quote expired locally before sending', async () => {
    const h = await swapHarness();
    await h.confirm();
    await h.tick(3);
    const { fundingId } = await h.record();
    // Quote expires locally before Execute is called.
    await editOperation(h, fundingId, (op) => {
      op.quote.expiresAt = new Date(Date.now() - 1_000).toISOString();
    });
    // Also advance swap quote slightly below the 30s check? No, leave swap quote valid so we hit fund().
    // Move clock back enough to pass sponsored() (which checks > now + 30_000) — simulate clock tick between check and execute:
    // Actually directly mark preSubmitExpired = true via wallet quote expiry path:
    await editOperation(h, fundingId, (op) => {
      op.status = 'expired';
      op.error = 'QUOTE_EXPIRED';
      op.preSubmitExpired = true;
    });
    await h.tick();
    expect(await h.record()).toMatchObject({
      phase: 'expired',
      action: null,
      error: 'QUOTE_EXPIRED',
      funding: { id: fundingId, status: 'expired' }
    });
    expect(executes(h)).toHaveLength(0);
    // Reservation is released so a new ordinary transfer on chain 137 is allowed!
    await expect(
      h.wallet.evm.prepareTransfer({
        idempotencyKey: 'after-presubmit-expiry',
        chainId: 137,
        to: owner,
        asset: 'native',
        amount: '1'
      })
    ).resolves.toMatchObject({ status: 'quoted' });
  });

  it('keeps an ambiguous funding submission open (RECONCILIATION_REQUIRED) and retains origin debit reservation past grace', async () => {
    const h = await swapHarness();
    await h.confirm();
    h.waas.remote.failExecute = true;
    await h.tick(4);
    const { fundingId, funding } = await h.record();
    expect(funding?.status).toBe('unknown');
    h.waas.remote.evmStatusError = 7309;
    await editOperation(h, fundingId, (op) => {
      op.quote.expiresAt = new Date(Date.now() - 121_000).toISOString();
    });
    await h.tick();
    // Must stay open in attention/fund with RECONCILIATION_REQUIRED — NEVER silently terminal expired!
    expect(await h.record()).toMatchObject({
      phase: 'attention',
      action: 'fund',
      error: 'RECONCILIATION_REQUIRED',
      funding: { status: 'unknown', error: 'RECONCILIATION_REQUIRED' }
    });
    // Competing debit on chain 137 MUST stay blocked!
    await expect(
      h.wallet.evm.prepareTransfer({
        idempotencyKey: 'blocked-during-reconcile',
        chainId: 137,
        to: owner,
        asset: 'native',
        amount: '1'
      })
    ).rejects.toMatchObject({ code: 'DEBIT_PENDING' });
    // Later positive WaaS read still settles the swap cleanly!
    h.waas.remote.evmStatusError = undefined;
    h.waas.remote.txnStatus = 'executed';
    h.advance(35_000);
    await h.tick();
    expect((await h.record()).fundingConfirmed).toBe(true);
    expect(executes(h)).toHaveLength(1);
  });

  it('keeps an ambiguous recovery transaction open past grace instead of silently starting a second recovery', async () => {
    const h = await swapHarness();
    await funded(h);
    h.intent.status = 'FAILED';
    h.receipt.status = 'FAILED';
    h.flags.intentBalance = '1000';
    const view = await h.swaps.prepareRecovery({
      swapId: 'swap-test-0001',
      idempotencyKey: 'recovery-ambig',
      source: 'origin'
    });
    await h.swaps.confirmRecovery({
      swapId: view.id,
      recoveryId: 'recovery-ambig',
      reviewId: view.recoveries[0].reviewId
    });
    h.waas.remote.failExecute = true;
    await h.tick(3);
    const recovery = (await h.record()).recoveries[0];
    expect(recovery.transaction?.status).toBe('unknown');
    h.waas.remote.evmStatusError = 7309;
    await editOperation(h, recovery.transactionId, (op) => {
      op.quote.expiresAt = new Date(Date.now() - 121_000).toISOString();
    });
    await h.tick();
    const record = await h.record();
    expect(record.activeRecoveryId).toBe('recovery-ambig');
    expect(record.recoveries[0].transaction).toMatchObject({
      status: 'unknown',
      error: 'RECONCILIATION_REQUIRED'
    });
    // Public SwapView / RecoveryView also surfaces the diagnostic and original WaaS txnId!
    const publicView = await h.swaps.get('swap-test-0001');
    expect(publicView.phase).toBe('attention');
    expect(publicView.error).toBe('RECONCILIATION_REQUIRED');
    expect(publicView.recoveries[0]).toMatchObject({
      error: 'RECONCILIATION_REQUIRED',
      transaction: {
        status: 'unknown',
        txnId: recovery.transaction?.quote?.txnId,
        error: 'RECONCILIATION_REQUIRED'
      }
    });
  });

  it('escalates and resolves an ambiguous recovery owner deployment past grace, releasing the chain', async () => {
    const h = await swapHarness();
    await funded(h);
    h.intent.status = 'FAILED';
    h.receipt.status = 'FAILED';
    h.flags.intentBalance = '1000';
    h.flags.deployed = false;
    const view = await h.swaps.prepareRecovery({
      swapId: 'swap-test-0001',
      idempotencyKey: 'recovery-deploy-ambig',
      source: 'origin'
    });
    await h.swaps.confirmRecovery({
      swapId: view.id,
      recoveryId: 'recovery-deploy-ambig',
      reviewId: view.recoveries[0].reviewId
    });
    h.waas.remote.failExecute = true;
    await h.tick();
    const recovery = (await h.record()).recoveries[0];
    expect(recovery.deployment?.status).toBe('unknown');

    // Age past grace and return TransactionExpired -> escalates to RECONCILIATION_REQUIRED
    h.waas.remote.evmStatusError = 7309;
    await editOperation(h, recovery.deploymentId, (op) => {
      op.quote.expiresAt = new Date(Date.now() - 121_000).toISOString();
    });
    await h.tick();
    const stuckView = await h.swaps.get('swap-test-0001');
    expect(stuckView.phase).toBe('attention');
    expect(stuckView.error).toBe('RECONCILIATION_REQUIRED');
    expect(stuckView.recoveries[0]).toMatchObject({
      error: 'RECONCILIATION_REQUIRED',
      deployment: {
        status: 'unknown',
        txnId: recovery.deployment?.quote?.txnId,
        error: 'RECONCILIATION_REQUIRED'
      }
    });
    // Chain 137 is blocked until resolved.
    await expect(
      h.wallet.evm.prepareTransfer({
        idempotencyKey: 'blocked-by-deploy-recon',
        chainId: 137,
        to: '0x2222222222222222222222222222222222222222',
        asset: 'native',
        amount: '1'
      })
    ).rejects.toMatchObject({ code: 'DEBIT_PENDING' });

    // Operator resolves deployment as not-broadcast -> clears activeRecoveryId & frees chain 137.
    const resolved = await h.swaps.resolveReconciliation({
      swapId: 'swap-test-0001',
      txnId: recovery.deployment!.quote!.txnId,
      resolution: 'not-broadcast'
    });
    expect(resolved.phase).toBe('attention');
    expect(resolved.error).toBe('RECOVERY_EXPIRED');
    expect(resolved.canRecover).toBe(true);
    expect(resolved.recoveries[0]).toMatchObject({
      status: 'expired',
      error: 'RECOVERY_EXPIRED'
    });
    await expect(
      h.wallet.evm.prepareTransfer({
        idempotencyKey: 'unblocked-after-deploy-recon',
        chainId: 137,
        to: '0x2222222222222222222222222222222222222222',
        asset: 'native',
        amount: '1'
      })
    ).resolves.toMatchObject({ status: 'quoted' });
  });
});
