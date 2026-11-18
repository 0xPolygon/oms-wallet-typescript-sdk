import { afterEach, describe, expect, it, vi } from 'vitest';
import { zeroAddress, type Hex } from 'viem';

import { MemoryStorageManager, Networks, OMSWalletTransactionError } from '@polygonlabs/oms-wallet';

import { OMSWalletPrivacyError, type PrivacyProgressEvent } from '../src/index.js';
import { IDLE_TIMEOUT_MS, KEY_MESSAGE, READ_TIMEOUT_MS } from '../src/session.js';
import {
  CONTRACTS,
  FakeBackend,
  NETWORK,
  OTHER_WALLET,
  RECIPIENT,
  USDC,
  WALLET,
  approve,
  signAs,
  decodeApproval,
  feeOption,
  setup
} from './fixtures.js';

afterEach(() => {
  vi.useRealTimers();
});

async function rejection(promise: Promise<unknown>): Promise<OMSWalletPrivacyError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(OMSWalletPrivacyError);
  return error as OMSWalletPrivacyError;
}

describe('setup', () => {
  it('derives keys from the reserved message, bound to the active wallet, once per wallet', async () => {
    const { privacy, signReservedMessage, createBackend } = setup();

    await privacy.getBalances();
    await privacy.getBalances();

    expect(KEY_MESSAGE.startsWith('OMS Wallet reserved message:')).toBe(true);
    expect(signReservedMessage).toHaveBeenCalledTimes(1);
    expect(signReservedMessage).toHaveBeenCalledWith({
      network: Networks.polygon,
      message: KEY_MESSAGE
    });
    expect(createBackend).toHaveBeenCalledTimes(1);
  });

  it('stops when the derived keys differ from the ones seen before', async () => {
    const storage = new MemoryStorageManager();
    await setup({ storage }).privacy.getBalances();

    const changed = new FakeBackend();
    changed.keyFingerprint = 'fingerprint-2';
    const { privacy } = setup({ storage, backends: [changed] });

    const error = await rejection(privacy.getBalances());
    expect(error.code).toBe('OMS_PRIVACY_KEY_MISMATCH');
    expect(changed.destroyed).toBe(true);
    expect(changed.calls).not.toContain('balances');
  });

  it('reports a failed setup to every operation queued behind it', async () => {
    const storage = new MemoryStorageManager();
    await setup({ storage }).privacy.getBalances();
    const changed = new FakeBackend();
    changed.keyFingerprint = 'fingerprint-2';
    const { privacy } = setup({ storage, backends: [changed] });

    const errors = await Promise.all([
      rejection(privacy.getBalances()),
      rejection(privacy.getBalances())
    ]);

    expect(errors.map((error) => error.code)).toEqual([
      'OMS_PRIVACY_KEY_MISMATCH',
      'OMS_PRIVACY_KEY_MISMATCH'
    ]);
  });

  it('derives keys only from a wallet signature WaaS confirms', async () => {
    const { privacy, wallet, createBackend } = setup();
    wallet.signatureValid = false;

    const error = await rejection(privacy.getBalances());

    expect(error.code).toBe('OMS_PRIVACY_KEY_MISMATCH');
    expect(createBackend).not.toHaveBeenCalled();
  });

  it("derives no keys from another wallet's signature", async () => {
    const { privacy, signReservedMessage, createBackend } = setup();
    signReservedMessage.mockImplementationOnce(async (params) =>
      signAs(OTHER_WALLET, params.message)
    );

    const error = await rejection(privacy.getBalances());

    expect(error.code).toBe('OMS_PRIVACY_KEY_MISMATCH');
    expect(createBackend).not.toHaveBeenCalled();
  });

  it('signs nothing when the wallet changes before the operation runs', async () => {
    const { privacy, wallet, createBackend, signReservedMessage } = setup({
      backends: [new FakeBackend(), new FakeBackend(OTHER_WALLET)]
    });
    const pending = privacy.getBalances();
    wallet.activeWallet = { ...wallet.activeWallet!, address: OTHER_WALLET };

    const error = await rejection(pending);

    expect(error.code).toBe('OMS_PRIVACY_WALLET_CHANGED');
    expect(signReservedMessage).not.toHaveBeenCalled();
    expect(createBackend).not.toHaveBeenCalled();
  });

  it('requires an active Ethereum wallet', async () => {
    const { privacy, wallet } = setup();
    wallet.activeWallet = undefined;

    expect((await rejection(privacy.getBalances())).code).toBe('OMS_PRIVACY_NO_WALLET');
  });

  it('tears the backend down when the wallet changes, and sets up again for the new one', async () => {
    const first = new FakeBackend();
    const second = new FakeBackend(OTHER_WALLET);
    const { privacy, wallet, createBackend } = setup({ backends: [first, second] });

    await privacy.getBalances();
    wallet.switchTo(OTHER_WALLET);
    await vi.waitFor(() => expect(first.destroyed).toBe(true));
    expect(wallet.listenerCount).toBe(0);

    await privacy.getBalances();
    expect(createBackend).toHaveBeenCalledTimes(2);
    expect(second.calls).toContain('balances');
  });

  it('tears the backend down after being idle', async () => {
    vi.useFakeTimers();
    const { privacy, backend } = setup();

    await privacy.getBalances();
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(backend.destroyed).toBe(false);
    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(backend.destroyed).toBe(true));
  });

  it('runs operations of one wallet one at a time', async () => {
    const { privacy, backend } = setup();
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    backend.balances = async () => {
      order.push('balances:start');
      await blocked;
      order.push('balances:end');
      return [];
    };
    backend.quoteFee = async () => {
      order.push('quoteFee');
      return { fee: 1n, data: {} };
    };

    const balances = privacy.getBalances();
    const quote = privacy.quoteUnshield({ network: NETWORK, token: USDC, amount: 1n });
    await vi.waitFor(() => expect(order).toEqual(['balances:start']));
    release();
    await Promise.all([balances, quote]);

    expect(order).toEqual(['balances:start', 'balances:end', 'quoteFee']);
  });
});

describe('quotes', () => {
  it('rejects unsupported networks and invalid input', async () => {
    const { privacy } = setup();

    expect(
      (
        await rejection(
          privacy.quoteShield({ network: Networks.optimism, token: USDC, amount: 1n })
        )
      ).code
    ).toBe('OMS_PRIVACY_UNSUPPORTED_NETWORK');
    expect(
      (await rejection(privacy.quoteShield({ network: NETWORK, token: USDC, amount: 0n }))).code
    ).toBe('OMS_PRIVACY_INVALID_PARAMS');
    expect(
      (
        await rejection(
          privacy.quotePrivateSend({
            network: NETWORK,
            token: USDC,
            amount: 1n,
            to: '0x12' as never
          })
        )
      ).code
    ).toBe('OMS_PRIVACY_INVALID_PARAMS');
  });

  it('returns frozen quotes with the fee and total, defaulting unshield to the own wallet', async () => {
    const { privacy } = setup();

    const quote = await privacy.quoteUnshield({ network: NETWORK, token: USDC, amount: 100n });

    expect(quote).toMatchObject({
      kind: 'unshield',
      amount: 100n,
      fee: 7n,
      total: 107n,
      to: WALLET
    });
    expect(Object.isFrozen(quote)).toBe(true);
    expect(Date.parse(quote.expiresAt)).toBeGreaterThan(Date.now());
    expect(Object.keys(quote).sort()).toEqual([
      'amount',
      'expiresAt',
      'fee',
      'kind',
      'network',
      'to',
      'token',
      'total'
    ]);
  });

  it('accepts a quote once, only before it expires, and only for its wallet', async () => {
    const { privacy, wallet } = setup({
      backends: [new FakeBackend(), new FakeBackend(OTHER_WALLET)]
    });
    const quote = await privacy.quoteShield({ network: NETWORK, token: USDC, amount: 100n });

    await privacy.shield(quote);
    expect((await rejection(privacy.shield(quote))).code).toBe('OMS_PRIVACY_QUOTE_INVALID');

    vi.useFakeTimers({ toFake: ['Date'] });
    const expiring = await privacy.quoteShield({ network: NETWORK, token: USDC, amount: 100n });
    vi.setSystemTime(Date.parse(expiring.expiresAt));
    expect((await rejection(privacy.shield(expiring))).code).toBe('OMS_PRIVACY_QUOTE_INVALID');
    vi.useRealTimers();

    const forFirst = await privacy.quoteShield({ network: NETWORK, token: USDC, amount: 100n });
    wallet.activeWallet = { ...wallet.activeWallet!, address: OTHER_WALLET };
    expect((await rejection(privacy.shield(forFirst))).code).toBe('OMS_PRIVACY_QUOTE_INVALID');
  });

  it('rejects objects that are not quotes from this package', async () => {
    const { privacy } = setup();
    const quote = await privacy.quoteShield({ network: NETWORK, token: USDC, amount: 1n });

    expect((await rejection(privacy.shield({ ...quote }))).code).toBe('OMS_PRIVACY_INVALID_PARAMS');
  });
});

describe('shield', () => {
  it('resets a larger allowance, approves exactly the total, then deposits', async () => {
    const { privacy, wallet, backend } = setup();
    backend.allowance = 1_000n;
    const events: PrivacyProgressEvent[] = [];
    const quote = await privacy.quoteShield({ network: NETWORK, token: USDC, amount: 100n });

    const result = await privacy.shield(quote, { onProgress: (event) => events.push(event) });

    const calls = wallet.sent.map(({ params }) => params);
    expect(calls).toHaveLength(3);
    expect(decodeApproval(calls[0]!.data as `0x${string}`)).toEqual({
      spender: CONTRACTS.pool,
      amount: 0n
    });
    expect(decodeApproval(calls[1]!.data as `0x${string}`)).toEqual({
      spender: CONTRACTS.pool,
      amount: 100n
    });
    expect(calls[2]).toMatchObject({ to: CONTRACTS.pool, value: 0n });
    for (const call of calls) expect(call).toMatchObject({ network: NETWORK });
    expect(wallet.sent.map(({ from }) => from)).toEqual([WALLET, WALLET, WALLET]);

    expect(result.transactions.map((transaction) => transaction.step)).toEqual([
      'reset-approval',
      'approve',
      'deposit'
    ]);
    expect(result.transactions[2]!.networkFee).toEqual({ token: USDC, amount: 10n });
    expect(events.map((event) => `${event.step}:${event.state}`)).toEqual([
      'reset-approval:prepared',
      'reset-approval:confirmed',
      'approve:prepared',
      'approve:confirmed',
      'deposit:prepared',
      'deposit:confirmed'
    ]);
  });

  it('skips approvals when the allowance is already the total', async () => {
    const { privacy, wallet, backend } = setup();
    backend.allowance = 100n;

    await privacy.shield(
      await privacy.quoteShield({ network: NETWORK, token: USDC, amount: 100n })
    );

    expect(wallet.sent).toHaveLength(1);
  });

  it('deposits the native token as value without approvals', async () => {
    const { privacy, wallet } = setup();
    wallet.feeOptions = [feeOption(zeroAddress, 5n, 10n ** 18n)];

    await privacy.shield(
      await privacy.quoteShield({ network: NETWORK, token: zeroAddress, amount: 100n })
    );

    expect(wallet.sent.map(({ params }) => params)).toEqual([
      expect.objectContaining({ to: CONTRACTS.pool, value: 100n })
    ]);
  });

  it('refuses a deposit call outside the allowlist and reports what was already sent', async () => {
    const { privacy, wallet, backend } = setup();
    backend.depositCall = () => ({ to: RECIPIENT, data: '0x', value: 0n });

    const error = await rejection(
      privacy.shield(await privacy.quoteShield({ network: NETWORK, token: USDC, amount: 100n }))
    );

    expect(error.code).toBe('OMS_PRIVACY_UNAUTHORIZED_TRANSACTION');
    expect(error.txnIds).toEqual(['txn-1']);
    expect(wallet.sent).toHaveLength(1);
  });

  it('pays the network fee in the moved token by default and stops when it cannot', async () => {
    const { privacy, wallet, backend } = setup();
    backend.allowance = 100n;
    wallet.feeOptions = [feeOption(USDC, 10n, 105n), feeOption(zeroAddress, 5n, 10n ** 18n)];

    const error = await rejection(
      privacy.shield(await privacy.quoteShield({ network: NETWORK, token: USDC, amount: 100n }))
    );

    expect(error.code).toBe('OMS_PRIVACY_NETWORK_FEE');
    expect(error.stage).toBe('deposit');
  });

  it('enforces maxNetworkFee and accepts a custom fee selector', async () => {
    const { privacy, wallet, backend } = setup();
    backend.allowance = 100n;

    const tooHigh = await rejection(
      privacy.shield(await privacy.quoteShield({ network: NETWORK, token: USDC, amount: 100n }), {
        maxNetworkFee: 9n
      })
    );
    expect(tooHigh.code).toBe('OMS_PRIVACY_NETWORK_FEE');

    const result = await privacy.shield(
      await privacy.quoteShield({ network: NETWORK, token: USDC, amount: 100n }),
      {
        maxNetworkFee: 9n,
        selectFeeOption: (options) => options[1]!.selection
      }
    );
    expect(result.transactions[0]!.networkFee).toEqual({ token: zeroAddress, amount: 5n });
    expect(wallet.sent).toHaveLength(2);
  });

  it('reports a failed deposit with every transaction ID', async () => {
    const { privacy, wallet, backend } = setup();
    backend.allowance = 0n;
    wallet.outcome = (index) => (index === 1 ? { status: 'failed', txnHash: undefined } : {});

    const error = await rejection(
      privacy.shield(await privacy.quoteShield({ network: NETWORK, token: USDC, amount: 100n }))
    );

    expect(error).toMatchObject({
      code: 'OMS_PRIVACY_TRANSACTION_FAILED',
      stage: 'deposit',
      txnIds: ['txn-1', 'txn-2']
    });
  });

  it('keeps a wallet error as cause when the outcome is unknown', async () => {
    const { privacy, wallet, backend } = setup();
    backend.allowance = 100n;
    const walletError = new OMSWalletTransactionError({
      code: 'OMS_TRANSACTION_EXECUTION_UNCONFIRMED',
      message: 'unconfirmed',
      txnId: 'txn-1'
    });
    wallet.outcome = () => walletError;

    const error = await rejection(
      privacy.shield(await privacy.quoteShield({ network: NETWORK, token: USDC, amount: 100n }))
    );

    expect(error).toMatchObject({ code: 'OMS_PRIVACY_TRANSACTION_FAILED', txnIds: ['txn-1'] });
    expect(error.cause).toBe(walletError);
  });

  it('reports a wallet change before anything was prepared', async () => {
    const { privacy, wallet, backend } = setup();
    backend.allowance = 100n;
    const quote = await privacy.quoteShield({ network: NETWORK, token: USDC, amount: 100n });
    backend.buildShieldDeposit = async () => {
      wallet.activeWallet = { ...wallet.activeWallet!, address: OTHER_WALLET };
      return { to: CONTRACTS.pool, data: `${CONTRACTS.depositSelector}00`, value: 0n };
    };

    const error = await rejection(privacy.shield(quote));

    expect(error).toMatchObject({ code: 'OMS_PRIVACY_WALLET_CHANGED', txnIds: [] });
  });
});

describe('privateSend', () => {
  it('sends the approval and deposit through the guard and returns the delivery', async () => {
    const { privacy, wallet } = setup();
    const events: PrivacyProgressEvent[] = [];
    const quote = await privacy.quotePrivateSend({
      network: NETWORK,
      token: USDC,
      amount: 100n,
      to: RECIPIENT
    });

    const result = await privacy.privateSend(quote, {
      waitForDelivery: true,
      onProgress: (e) => events.push(e)
    });

    expect(result.deliveryId).toBe('delivery-1');
    expect(result.delivery?.status).toBe('delivered');
    expect(result.transactions.map((transaction) => transaction.step)).toEqual([
      'approve',
      'deposit'
    ]);
    expect(decodeApproval(wallet.sent[0]!.params.data as `0x${string}`)).toEqual({
      spender: CONTRACTS.sendSpender,
      amount: 107n
    });
    expect(events.slice(-2).map((event) => `${event.step}:${event.state}`)).toEqual([
      'delivery:pending',
      'delivery:delivered'
    ]);
  });

  it('resets an allowance above the total before the backend runs', async () => {
    const { privacy, wallet, backend } = setup();
    backend.allowance = 10_000n;
    backend.privateSendCalls = () => [
      { to: CONTRACTS.pool, data: `${CONTRACTS.depositSelector}00`, value: 0n }
    ];

    await privacy.privateSend(
      await privacy.quotePrivateSend({ network: NETWORK, token: USDC, amount: 100n, to: RECIPIENT })
    );

    expect(decodeApproval(wallet.sent[0]!.params.data as `0x${string}`)).toEqual({
      spender: CONTRACTS.sendSpender,
      amount: 0n
    });
    expect(wallet.sent).toHaveLength(2);
  });

  it('refuses an approval above the quoted total even when the backend hides the error', async () => {
    const { privacy, wallet, backend } = setup();
    backend.privateSendCalls = (total) => [approve(USDC, CONTRACTS.sendSpender, total + 1n)];

    const error = await rejection(
      privacy.privateSend(
        await privacy.quotePrivateSend({
          network: NETWORK,
          token: USDC,
          amount: 100n,
          to: RECIPIENT
        })
      )
    );

    expect(error.code).toBe('OMS_PRIVACY_UNAUTHORIZED_TRANSACTION');
    expect(wallet.sent).toHaveLength(0);
  });

  it('refuses transactions outside an operation', async () => {
    const { privacy, wallet, backend } = setup();
    backend.privateSendCalls = (total) => [
      approve(USDC, CONTRACTS.sendSpender, total),
      approve(USDC, CONTRACTS.sendSpender, total)
    ];

    const error = await rejection(
      privacy.privateSend(
        await privacy.quotePrivateSend({
          network: NETWORK,
          token: USDC,
          amount: 100n,
          to: RECIPIENT
        })
      )
    );

    expect(error).toMatchObject({
      code: 'OMS_PRIVACY_UNAUTHORIZED_TRANSACTION',
      txnIds: ['txn-1']
    });
    expect(wallet.sent).toHaveLength(1);
  });

  it('says the delivery may still happen when scheduling is unconfirmed after the deposit, without backend text', async () => {
    const { privacy, backend } = setup();
    backend.failWith.deliveryStatus = new Error('x');

    const error = await rejection(
      privacy.privateSend(
        await privacy.quotePrivateSend({
          network: NETWORK,
          token: USDC,
          amount: 100n,
          to: RECIPIENT
        })
      )
    );

    expect(error).toMatchObject({
      code: 'OMS_PRIVACY_SERVICE_ERROR',
      stage: 'delivery',
      txnIds: ['txn-1', 'txn-2']
    });
    expect(error.message).toContain('may still happen. Do not send it again.');
    expect(error.message).toContain('recover()');
    expect(error.deliveryId).toBeUndefined();
    expect(error.message).not.toContain('provider');
    expect(error.cause).toBeUndefined();
  });

  it('reports a failed delivery with its ID', async () => {
    const { privacy, backend } = setup();
    backend.deliveryStatuses = ['pending', 'failed'];

    const error = await rejection(
      privacy.privateSend(
        await privacy.quotePrivateSend({
          network: NETWORK,
          token: USDC,
          amount: 100n,
          to: RECIPIENT
        }),
        {
          waitForDelivery: true,
          deliveryPolling: { intervalMs: 1 }
        }
      )
    );

    expect(error).toMatchObject({ code: 'OMS_PRIVACY_DELIVERY_FAILED', deliveryId: 'delivery-1' });
  });

  it('times out waiting for delivery without failing the send itself', async () => {
    const { privacy, backend } = setup();
    backend.deliveryStatuses = ['pending'];

    const error = await rejection(
      privacy.privateSend(
        await privacy.quotePrivateSend({
          network: NETWORK,
          token: USDC,
          amount: 100n,
          to: RECIPIENT
        }),
        {
          waitForDelivery: true,
          deliveryPolling: { intervalMs: 1, timeoutMs: 5 }
        }
      )
    );

    expect(error).toMatchObject({ code: 'OMS_PRIVACY_DELIVERY_TIMEOUT', deliveryId: 'delivery-1' });
  });
});

describe('unshield, recover, balances', () => {
  it('checks the private balance before withdrawing', async () => {
    const { privacy, backend } = setup();
    backend.balanceList = [{ chainId: NETWORK.id, token: USDC, amount: 106n }];

    const quote = await privacy.quoteUnshield({
      network: NETWORK,
      token: USDC,
      amount: 100n,
      to: RECIPIENT
    });
    expect((await rejection(privacy.unshield(quote))).code).toBe(
      'OMS_PRIVACY_INSUFFICIENT_BALANCE'
    );

    backend.balanceList = [{ chainId: NETWORK.id, token: USDC, amount: 107n }];
    const next = await privacy.quoteUnshield({
      network: NETWORK,
      token: USDC,
      amount: 100n,
      to: RECIPIENT
    });
    await expect(privacy.unshield(next)).resolves.toEqual({ txnHash: `0x${'ab'.repeat(32)}` });
  });

  it('does not forward backend error text', async () => {
    const { privacy, backend } = setup();
    backend.balanceList = [{ chainId: NETWORK.id, token: USDC, amount: 1_000n }];
    backend.failWith.unshield = new Error('provider relayer 500: internal detail');

    const error = await rejection(
      privacy.unshield(await privacy.quoteUnshield({ network: NETWORK, token: USDC, amount: 100n }))
    );

    expect(error).toMatchObject({
      code: 'OMS_PRIVACY_SERVICE_ERROR',
      message: 'The privacy service failed before the withdrawal was submitted.'
    });
    expect(error.cause).toBeUndefined();
  });

  it('recovers only to the own wallet, and only when there is something to recover', async () => {
    const { privacy, backend } = setup();

    expect((await rejection(privacy.recover({ network: NETWORK, token: USDC }))).code).toBe(
      'OMS_PRIVACY_NOTHING_TO_RECOVER'
    );

    backend.recoverableList = [{ chainId: NETWORK.id, token: USDC, amount: 50n }];
    const result = await privacy.recover({ network: NETWORK, token: USDC });
    expect(result.txnHashes).toHaveLength(1);
    expect(backend.recoveredTo).toBe(WALLET);
  });

  it('merges spendable and recoverable balances per token', async () => {
    const { privacy, backend } = setup();
    backend.balanceList = [
      { chainId: NETWORK.id, token: USDC, amount: 10n },
      { chainId: Networks.base.id, token: zeroAddress, amount: 3n }
    ];
    backend.recoverableList = [{ chainId: NETWORK.id, token: USDC, amount: 5n }];

    const balances = await privacy.getBalances();

    expect(balances).toEqual([
      { network: NETWORK, token: USDC, amount: 10n, recoverable: 5n },
      { network: Networks.base, token: zeroAddress, amount: 3n, recoverable: 0n }
    ]);
  });
});

describe('review fixes', () => {
  it.each(['unshield', 'recover'] as const)(
    'stops %s when the wallet changes right before submission',
    async (kind) => {
      const { privacy, wallet, backend } = setup();
      backend.balanceList = [{ chainId: NETWORK.id, token: USDC, amount: 1_000n }];
      backend.recoverableList = [{ chainId: NETWORK.id, token: USDC, amount: 50n }];
      const quote =
        kind === 'unshield'
          ? await privacy.quoteUnshield({ network: NETWORK, token: USDC, amount: 100n })
          : undefined;
      backend.beforeSubmitDelay = async () => {
        wallet.activeWallet = undefined;
      };

      const error = await rejection(
        kind === 'unshield'
          ? privacy.unshield(quote!)
          : privacy.recover({ network: NETWORK, token: USDC })
      );

      expect(error.code).toBe('OMS_PRIVACY_WALLET_CHANGED');
      expect(backend.recoveredTo).toBeUndefined();
    }
  );

  it.each(['unshield', 'recover'] as const)(
    'stops %s when the wallet is switched away and back before submission',
    async (kind) => {
      const { privacy, wallet, backend } = setup();
      backend.balanceList = [{ chainId: NETWORK.id, token: USDC, amount: 1_000n }];
      backend.recoverableList = [{ chainId: NETWORK.id, token: USDC, amount: 50n }];
      const quote =
        kind === 'unshield'
          ? await privacy.quoteUnshield({ network: NETWORK, token: USDC, amount: 100n })
          : undefined;
      backend.beforeSubmitDelay = async () => {
        wallet.switchTo(OTHER_WALLET);
        wallet.switchTo(WALLET);
      };

      const error = await rejection(
        kind === 'unshield'
          ? privacy.unshield(quote!)
          : privacy.recover({ network: NETWORK, token: USDC })
      );

      expect(error.code).toBe('OMS_PRIVACY_WALLET_CHANGED');
      expect(backend.recoveredTo).toBeUndefined();
      expect(backend.calls.filter((call) => call === kind)).toHaveLength(1);
    }
  );

  it('does not start an operation for a wallet while one from before a switch away and back still runs', async () => {
    const { privacy, wallet, backend } = setup();
    backend.balanceList = [{ chainId: NETWORK.id, token: USDC, amount: 1_000n }];
    const quote = await privacy.quoteUnshield({ network: NETWORK, token: USDC, amount: 100n });
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    backend.beforeSubmitDelay = async () => {
      order.push('unshield:waiting');
      await blocked;
      order.push('unshield:end');
    };

    const unshield = rejection(privacy.unshield(quote));
    await vi.waitFor(() => expect(order).toEqual(['unshield:waiting']));
    wallet.switchTo(OTHER_WALLET);
    wallet.switchTo(WALLET);
    const balances = privacy.getBalances().then(() => order.push('balances'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['unshield:waiting']);

    release();
    expect((await unshield).code).toBe('OMS_PRIVACY_WALLET_CHANGED');
    await balances;
    expect(order).toEqual(['unshield:waiting', 'unshield:end', 'balances']);
  });

  it('keeps the delivery ID when a status read fails after scheduling', async () => {
    const { privacy, backend } = setup();
    backend.deliveryStatus = async () => {
      throw new Error('status service down');
    };

    const error = await rejection(
      privacy.privateSend(
        await privacy.quotePrivateSend({
          network: NETWORK,
          token: USDC,
          amount: 100n,
          to: RECIPIENT
        }),
        { waitForDelivery: true, deliveryPolling: { intervalMs: 1 } }
      )
    );

    expect(error).toMatchObject({
      code: 'OMS_PRIVACY_SERVICE_ERROR',
      stage: 'delivery',
      deliveryId: 'delivery-1',
      txnIds: ['txn-1', 'txn-2']
    });
    expect(error.message).toContain('Do not send it again');
  });

  it('waits for an async onProgress before executing a prepared transaction', async () => {
    const { privacy, wallet, backend } = setup();
    backend.allowance = 100n;
    const order: string[] = [];
    wallet.outcome = () => {
      order.push('execute');
      return {};
    };

    await privacy.shield(
      await privacy.quoteShield({ network: NETWORK, token: USDC, amount: 100n }),
      {
        onProgress: async (event) => {
          if (event.state !== 'prepared') return;
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(`saved ${event.txnId}`);
        }
      }
    );

    expect(order).toEqual(['saved txn-1', 'execute']);
  });

  it('does not execute when onProgress rejects for a prepared transaction', async () => {
    const { privacy, wallet, backend } = setup();
    backend.allowance = 100n;
    const executed: number[] = [];
    wallet.outcome = (index) => {
      executed.push(index);
      return {};
    };

    const error = await rejection(
      privacy.shield(await privacy.quoteShield({ network: NETWORK, token: USDC, amount: 100n }), {
        onProgress: async (event) => {
          if (event.state === 'prepared') throw new Error('IndexedDB is full');
        }
      })
    );

    expect(error).toMatchObject({ code: 'OMS_PRIVACY_TRANSACTION_FAILED', txnIds: ['txn-1'] });
    expect(error.message).toContain('not executed');
    expect(executed).toEqual([]);
  });
});

describe('second review fixes', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const sendQuote = (privacy: ReturnType<typeof setup>['privacy']) =>
    privacy.quotePrivateSend({ network: NETWORK, token: USDC, amount: 100n, to: RECIPIENT });

  it('reports the deposit when the provider fails while the deposit is still running', async () => {
    const { privacy, backend, wallet } = setup();
    // The provider starts the deposit and its delivery proofs together; the proofs fail first.
    backend.privateSend = async (params, send) => {
      const [approveCall, depositCall] = backend.privateSendCalls(params.amount + backend.fee);
      await send(approveCall!);
      void send(depositCall!).catch(() => {});
      throw new Error('relayer not available');
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const send = wallet.sendTransaction.getMockImplementation()!;
    wallet.sendTransaction.mockImplementation(async (params) => {
      if (wallet.sent.length === 1) await gate;
      return send(params);
    });
    const pending = rejection(privacy.privateSend(await sendQuote(privacy)));
    await tick();
    release();

    const error = await pending;
    expect(error).toMatchObject({
      code: 'OMS_PRIVACY_SERVICE_ERROR',
      stage: 'delivery',
      txnIds: ['txn-1', 'txn-2']
    });
    expect(error.message).toContain('Do not send it again');
  });

  it('starts no deposit once the provider has failed', async () => {
    const { privacy, backend, wallet } = setup();
    backend.privateSend = async (params, send) => {
      const calls = backend.privateSendCalls(params.amount + backend.fee);
      void (async () => {
        for (const call of calls) await send(call);
      })().catch(() => {});
      throw new Error('relayer not available');
    };

    const error = await rejection(privacy.privateSend(await sendQuote(privacy)));
    await tick();
    expect(error).toMatchObject({
      code: 'OMS_PRIVACY_SERVICE_ERROR',
      stage: 'deposit',
      txnIds: ['txn-1']
    });
    expect(wallet.sent.map((sent) => decodeApproval(sent.params.data as Hex).amount)).toEqual([
      100n + backend.fee
    ]);
  });

  it('refuses wallet transactions the provider requests after the operation or while one runs', async () => {
    const { privacy, backend, wallet } = setup();
    let late: (() => Promise<unknown>) | undefined;
    backend.privateSend = async (params, send) => {
      const [approveCall, depositCall] = backend.privateSendCalls(params.amount + backend.fee);
      const overlapping = await Promise.allSettled([send(approveCall!), send(approveCall!)]);
      expect(overlapping.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
      late = () => send(depositCall!);
      throw new Error('provider failure');
    };

    const error = await rejection(privacy.privateSend(await sendQuote(privacy)));
    expect(error.code).toBe('OMS_PRIVACY_UNAUTHORIZED_TRANSACTION');
    await expect(late!()).rejects.toThrow('after the operation ended');
    expect(wallet.sent).toHaveLength(1);
  });

  it('keeps getBalances in the queue until both reads settle', async () => {
    const { privacy, backend } = setup();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    backend.balances = async () => {
      throw new Error('rpc down');
    };
    backend.recoverableBalances = async () => {
      order.push('recoverable:start');
      await gate;
      order.push('recoverable:end');
      return [];
    };
    backend.quoteFee = async () => {
      order.push('quoteFee');
      return { fee: 1n, data: {} };
    };

    const balances = rejection(privacy.getBalances());
    const quote = privacy.quoteUnshield({ network: NETWORK, token: USDC, amount: 1n });
    await tick();
    release();
    await balances;
    await quote;
    expect(order).toEqual(['recoverable:start', 'recoverable:end', 'quoteFee']);
  });

  it('does not return balances or quotes for a wallet that is no longer active', async () => {
    const { privacy, backend, wallet } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    backend.balances = async () => {
      await gate;
      return [{ chainId: NETWORK.id, token: USDC, amount: 7n }];
    };
    backend.quoteFee = async () => {
      await gate;
      return { fee: 1n, data: {} };
    };

    const balances = rejection(privacy.getBalances());
    const quote = rejection(privacy.quoteUnshield({ network: NETWORK, token: USDC, amount: 1n }));
    await tick();
    wallet.switchTo(OTHER_WALLET);
    wallet.switchTo(WALLET);
    release();
    expect((await balances).code).toBe('OMS_PRIVACY_WALLET_CHANGED');
    expect((await quote).code).toBe('OMS_PRIVACY_WALLET_CHANGED');
  });

  it('binds a quote to the inputs at the call and the package’s own network', async () => {
    const { privacy, backend } = setup();
    const quotedFor: bigint[] = [];
    backend.quoteFee = async (params: { amount: bigint }) => {
      quotedFor.push(params.amount);
      await tick();
      return { fee: 1n, data: {} };
    };
    const network = { ...Networks.polygon };
    const params = { network, token: USDC, amount: 100n, to: RECIPIENT };
    const pending = privacy.quotePrivateSend(params);
    params.amount = 1000n;
    (network as { id: number }).id = Networks.base.id;
    const quote = await pending;

    expect(quotedFor).toEqual([100n]);
    expect(quote.amount).toBe(100n);
    expect(quote.network).toBe(Networks.polygon);
  });

  it('refuses the zero address as a recipient', async () => {
    const { privacy } = setup();
    for (const quote of [
      privacy.quotePrivateSend({ network: NETWORK, token: USDC, amount: 1n, to: zeroAddress }),
      privacy.quoteUnshield({ network: NETWORK, token: USDC, amount: 1n, to: zeroAddress })
    ]) {
      expect((await rejection(quote)).code).toBe('OMS_PRIVACY_INVALID_PARAMS');
    }
  });

  it('times out a delivery status read that never settles, keeping the delivery ID', async () => {
    const { privacy, backend } = setup();
    backend.deliveryStatus = () => new Promise(() => {});

    const error = await rejection(
      privacy.privateSend(await sendQuote(privacy), {
        waitForDelivery: true,
        deliveryPolling: { timeoutMs: 20, intervalMs: 1 }
      })
    );
    expect(error).toMatchObject({
      code: 'OMS_PRIVACY_DELIVERY_TIMEOUT',
      deliveryId: 'delivery-1',
      txnIds: ['txn-1', 'txn-2']
    });
  });

  it('refuses invalid delivery polling before sending anything', async () => {
    const { privacy, wallet } = setup();
    for (const deliveryPolling of [{ timeoutMs: Number.NaN }, { intervalMs: 0 }]) {
      const error = await rejection(
        privacy.privateSend(await sendQuote(privacy), { waitForDelivery: true, deliveryPolling })
      );
      expect(error.code).toBe('OMS_PRIVACY_INVALID_PARAMS');
    }
    expect(wallet.sent).toHaveLength(0);
  });

  it.each(['unshield', 'recover'] as const)(
    'says a %s may have been submitted when the service fails after taking it',
    async (kind) => {
      const { privacy, backend } = setup();
      backend.balanceList = [{ chainId: NETWORK.id, token: USDC, amount: 1_000n }];
      backend.recoverableList = [{ chainId: NETWORK.id, token: USDC, amount: 50n }];
      const quote =
        kind === 'unshield'
          ? await privacy.quoteUnshield({ network: NETWORK, token: USDC, amount: 100n })
          : undefined;
      backend.beforeSubmitDelay = undefined;
      const submit = backend[kind].bind(backend);
      backend[kind] = (async (params: Parameters<typeof submit>[0]) => {
        await submit(params as never);
        throw new Error('response lost');
      }) as never;

      const error = await rejection(
        kind === 'unshield'
          ? privacy.unshield(quote!)
          : privacy.recover({ network: NETWORK, token: USDC })
      );
      expect(error).toMatchObject({ code: 'OMS_PRIVACY_SERVICE_ERROR', txnIds: [] });
      expect(error.message).toContain('may have been submitted');
    }
  );
});

describe('third review fixes', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('fails a backend read that never settles and frees the queue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { privacy, backend } = setup();
      backend.deliveryStatus = () => new Promise(() => {});

      const stalled = rejection(privacy.getDeliveryStatus({ deliveryId: 'd1' }));
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
      expect(await stalled).toMatchObject({
        code: 'OMS_PRIVACY_SERVICE_ERROR',
        message: 'The privacy service did not answer in time.'
      });
      await expect(privacy.getBalances()).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the delivery it was called for, for the wallet it was called for', async () => {
    const { privacy, backend, wallet } = setup();
    const read: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    backend.deliveryStatus = async (deliveryId: string) => {
      read.push(deliveryId);
      await gate;
      return { status: 'delivered' };
    };

    const params = { deliveryId: 'A' };
    const pending = rejection(privacy.getDeliveryStatus(params));
    params.deliveryId = 'B';
    await tick();
    wallet.switchTo(OTHER_WALLET);
    release();

    expect((await pending).code).toBe('OMS_PRIVACY_WALLET_CHANGED');
    expect(read).toEqual(['A']);
  });

  it('reports every transaction the run created, even ones that started after the failure', async () => {
    const { privacy, backend, wallet } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const send = wallet.sendTransaction.getMockImplementation()!;
    wallet.sendTransaction.mockImplementation(async (params) => {
      await gate;
      return send(params);
    });
    backend.privateSend = async (params, sendCall) => {
      const [, deposit] = backend.privateSendCalls(params.amount + backend.fee);
      void sendCall(deposit!).catch(() => {});
      await sendCall(deposit!);
      return { deliveryId: 'unreachable' };
    };

    const pending = rejection(
      privacy.privateSend(
        await privacy.quotePrivateSend({ network: NETWORK, token: USDC, amount: 1n, to: RECIPIENT })
      )
    );
    await tick();
    release();

    expect(await pending).toMatchObject({
      code: 'OMS_PRIVACY_UNAUTHORIZED_TRANSACTION',
      txnIds: ['txn-1']
    });
  });
});
