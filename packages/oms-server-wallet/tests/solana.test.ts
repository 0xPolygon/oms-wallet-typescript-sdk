import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  UpstreamError,
  type SolanaTransfer,
  type SolanaTransferInput
} from '@polygonlabs/oms-server-wallet-sdk';

import { IndexerClient } from '../src/indexer.js';
import {
  SOLANA_ADDRESS,
  SOLANA_RECIPIENT,
  SOLANA_SIGNATURE,
  TRON_ADDRESS,
  sdkHarness
} from './helpers.js';

const usdcDevnet = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const transfer: SolanaTransfer = {
  network: 'solana:devnet',
  to: SOLANA_RECIPIENT,
  asset: 'native',
  amount: '1000000'
};
const calls = (h: ReturnType<typeof sdkHarness>, method: string) =>
  h.remote.calls.filter((call) => call.method === method);
afterEach(() => vi.useRealTimers());

describe('Solana transfers', () => {
  it('quotes a sponsored SOL transfer through the fee payer and sends it once', async () => {
    const h = sdkHarness();
    const op = await h.client.solana.sendTransfer({ idempotencyKey: 'sol-send-1', ...transfer });
    expect(calls(h, 'CreateWallet').map((call) => call.body.networkFamily)).toEqual(['solana']);
    expect(calls(h, 'PrepareSolanaTransfer')[0].body).toEqual({
      network: 'solana:devnet',
      walletId: 'wallet-sol',
      asset: 'SOL',
      recipient: { address: SOLANA_RECIPIENT },
      amount: '1000000',
      mode: 'relayer'
    });
    expect(calls(h, 'Execute')[0].body).toEqual({ txnId: 'sol-txn-1' });
    expect(op).toMatchObject({
      family: 'solana',
      kind: 'transfer',
      network: 'solana:devnet',
      status: 'pending',
      transfer
    });
    h.remote.chainOutcome = 'executed';
    expect(await h.client.solana.refreshOperation('sol-send-1')).toMatchObject({
      status: 'executed',
      txnHash: SOLANA_SIGNATURE
    });
    expect(
      await h.client.solana.sendTransfer({ idempotencyKey: 'sol-send-1', ...transfer })
    ).toMatchObject({
      status: 'executed'
    });
    expect(calls(h, 'Execute')).toHaveLength(1);
  });

  it('sends SPL and Token-2022 mints as the asset; WaaS picks the token program', async () => {
    const h = sdkHarness();
    await h.client.solana.prepareTransfer({
      idempotencyKey: 'sol-spl-1',
      ...transfer,
      asset: usdcDevnet
    });
    expect(calls(h, 'PrepareSolanaTransfer')[0].body.asset).toBe(usdcDevnet);
  });

  it('lets a quote be reviewed before it is executed with its reviewId', async () => {
    const h = sdkHarness();
    const quoted = await h.client.solana.prepareTransfer({
      idempotencyKey: 'sol-review-1',
      ...transfer
    });
    expect(quoted.status).toBe('quoted');
    expect(quoted.reviewId).toBeTruthy();
    expect(Date.parse(quoted.quote!.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
    expect(calls(h, 'Execute')).toHaveLength(0);
    expect(
      (
        await h.client.solana.execute({
          idempotencyKey: 'sol-review-1',
          reviewId: quoted.reviewId!
        })
      ).status
    ).toBe('pending');
  });

  it.each([
    ['an EVM recipient', { to: '0x2222222222222222222222222222222222222222' }, 'INVALID_ADDRESS'],
    ['a Tron mint', { asset: TRON_ADDRESS }, 'INVALID_ADDRESS'],
    ['a zero amount', { amount: '0' }, 'INVALID_AMOUNT'],
    ['a decimal amount', { amount: '1.5' }, 'INVALID_AMOUNT'],
    ['an amount above u64', { amount: (2n ** 64n).toString() }, 'INVALID_AMOUNT'],
    ['an unknown network', { network: 'solana:testnet' }, 'UNSUPPORTED_NETWORK'],
    ['an unexpected field', { memo: 'x' }, 'INVALID_TRANSFER']
  ])('rejects %s before contacting WaaS', async (_, change, code) => {
    const h = sdkHarness();
    await expect(
      h.client.solana.prepareTransfer({
        idempotencyKey: 'sol-bad-1',
        ...transfer,
        ...change
      } as SolanaTransferInput)
    ).rejects.toMatchObject({ code });
    expect(h.remote.calls).toHaveLength(0);
  });

  it('refuses a transfer to the wallet itself', async () => {
    const h = sdkHarness();
    await expect(
      h.client.solana.prepareTransfer({
        idempotencyKey: 'sol-self-1',
        ...transfer,
        to: SOLANA_ADDRESS
      })
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    expect(calls(h, 'PrepareSolanaTransfer')).toHaveLength(0);
  });

  it('requires sponsorship and records the refusal', async () => {
    const h = sdkHarness();
    h.remote.chainSponsored = false;
    await expect(
      h.client.solana.sendTransfer({ idempotencyKey: 'sol-unsponsored', ...transfer })
    ).rejects.toMatchObject({
      code: 'SPONSORSHIP_REQUIRED'
    });
    expect(await h.client.solana.getOperation('sol-unsponsored')).toMatchObject({
      status: 'failed',
      error: 'SPONSORSHIP_REQUIRED',
      provenUnsent: true
    });
    expect(calls(h, 'Execute')).toHaveLength(0);
  });

  it('reads null fee options from older servers as none', async () => {
    const h = sdkHarness();
    h.remote.nullFeeOptions = true;
    expect(
      (await h.client.solana.prepareTransfer({ idempotencyKey: 'sol-null-fees', ...transfer }))
        .quote
    ).toMatchObject({
      sponsored: true,
      feeOptions: []
    });
  });

  it('keeps IDs unique across families and inputs', async () => {
    const h = sdkHarness();
    const prepared = await h.client.solana.prepareTransfer({
      idempotencyKey: 'shared-id-1',
      ...transfer
    });
    await expect(
      h.client.solana.prepareTransfer({ idempotencyKey: 'shared-id-1', ...transfer, amount: '2' })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      h.client.evm.signMessage({
        idempotencyKey: 'shared-id-1',
        chainId: 137 as const,
        message: 'hello'
      })
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT'
    });
    expect((await h.client.evm.listOperations()).items).toEqual([]);
    expect(await h.client.evm.getOperation('shared-id-1')).toBeNull();
    await expect(
      h.client.evm.execute({ idempotencyKey: 'shared-id-1', reviewId: prepared.reviewId! })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND'
    });
    expect((await h.client.solana.listOperations()).items.map((op) => op.id)).toEqual([
      'shared-id-1'
    ]);
  });
});

describe('Solana quote expiry', () => {
  it('marks a quote that expired locally before submission as expired (QUOTE_EXPIRED) and sends nothing', async () => {
    const h = sdkHarness();
    const prepared = await h.client.solana.prepareTransfer({
      idempotencyKey: 'sol-late-1',
      ...transfer
    });
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ['Date'] });
    await expect(
      h.client.solana.execute({ idempotencyKey: 'sol-late-1', reviewId: prepared.reviewId! })
    ).rejects.toMatchObject({
      code: 'QUOTE_EXPIRED'
    });
    expect(calls(h, 'Execute')).toHaveLength(0);
    expect(
      await h.client.solana.execute({ idempotencyKey: 'sol-late-1', reviewId: prepared.reviewId! })
    ).toMatchObject({
      status: 'expired',
      error: 'QUOTE_EXPIRED',
      provenUnsent: true
    });
  });

  it('keeps an Execute refused as expired open and escalates to RECONCILIATION_REQUIRED past grace', async () => {
    const h = sdkHarness();
    const prepared = await h.client.solana.prepareTransfer({
      idempotencyKey: 'sol-blockhash-1',
      ...transfer
    });
    h.remote.executeRefusal = 7309;
    expect(
      await h.client.solana.execute({
        idempotencyKey: 'sol-blockhash-1',
        reviewId: prepared.reviewId!
      })
    ).toMatchObject({
      status: 'unknown',
      error: 'SUBMISSION_UNCERTAIN'
    });
    vi.useFakeTimers({ now: Date.now() + 61_000 + 120_000, toFake: ['Date'] });
    expect(await h.client.solana.refreshOperation('sol-blockhash-1')).toMatchObject({
      status: 'unknown',
      error: 'RECONCILIATION_REQUIRED',
      provenUnsent: false
    });
  });

  it.each([
    [7309, 'the claim was already taken'],
    [7311, 'the broadcast failed after the claim']
  ])(
    'never takes a stale status read after refusal %i (%s) as proof nothing was sent',
    async (code) => {
      const h = sdkHarness();
      const prepared = await h.client.solana.prepareTransfer({
        idempotencyKey: 'sol-stale-1',
        ...transfer
      });
      const request = h.remote.request.bind(h.remote);
      h.remote.request = async (method, body, credential) => {
        if (method === 'Execute') {
          h.remote.chainTxns.get(body.txnId as string)!.status = 'pending';
          h.remote.calls.push({ method, body });
          throw new UpstreamError(code, method);
        }
        return request(method, body, credential);
      };
      h.remote.staleStatusReads = 1;
      h.remote.chainOutcome = 'executed';
      expect(
        await h.client.solana.execute({
          idempotencyKey: 'sol-stale-1',
          reviewId: prepared.reviewId!
        })
      ).toMatchObject({
        status: 'unknown',
        error: 'SUBMISSION_UNCERTAIN'
      });
      expect(await h.client.solana.refreshOperation('sol-stale-1')).toMatchObject({
        status: 'executed',
        txnHash: SOLANA_SIGNATURE
      });
      expect((await h.client.solana.getOperation('sol-stale-1'))?.error).toBeUndefined();
    }
  );

  it('treats a stale expired read after a lost Execute as uncertain within the grace period', async () => {
    const h = sdkHarness();
    h.remote.chainLoseExecute = true;
    expect(
      (await h.client.solana.sendTransfer({ idempotencyKey: 'sol-stale-2', ...transfer })).status
    ).toBe('unknown');
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ['Date'] });
    h.remote.staleStatusReads = 1;
    h.remote.chainOutcome = 'executed';
    // The stale expired read leaves the operation open and unchanged.
    expect((await h.client.solana.refreshOperation('sol-stale-2'))?.status).toBe('unknown');
    expect(await h.client.solana.refreshOperation('sol-stale-2')).toMatchObject({
      status: 'executed',
      txnHash: SOLANA_SIGNATURE
    });
  });

  it('keeps the transaction hash Execute returns', async () => {
    const h = sdkHarness();
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) => {
      const response = await request(method, body, credential);
      return method === 'Execute' ? { status: 'pending', txnHash: SOLANA_SIGNATURE } : response;
    };
    expect(
      await h.client.solana.sendTransfer({ idempotencyKey: 'sol-hash-1', ...transfer })
    ).toMatchObject({
      status: 'pending',
      txnHash: SOLANA_SIGNATURE
    });
  });

  it('follows the claimed transaction when an Execute refusal comes after the claim', async () => {
    const h = sdkHarness();
    const prepared = await h.client.solana.prepareTransfer({
      idempotencyKey: 'sol-claimed-1',
      ...transfer
    });
    const txn = () => h.remote.chainTxns.get('sol-txn-1')!;
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) => {
      if (method === 'Execute') {
        txn().status = 'pending';
        h.remote.calls.push({ method, body });
        throw new UpstreamError(7311, method);
      }
      return request(method, body, credential);
    };
    expect(
      await h.client.solana.execute({
        idempotencyKey: 'sol-claimed-1',
        reviewId: prepared.reviewId!
      })
    ).toMatchObject({
      status: 'pending',
      txnHash: SOLANA_SIGNATURE
    });
  });

  it('records other refusals before submission as failed', async () => {
    const h = sdkHarness();
    const prepared = await h.client.solana.prepareTransfer({
      idempotencyKey: 'sol-refused-1',
      ...transfer
    });
    h.remote.executeRefusal = 7306;
    expect(
      await h.client.solana.execute({
        idempotencyKey: 'sol-refused-1',
        reviewId: prepared.reviewId!
      })
    ).toMatchObject({
      status: 'failed',
      error: 'EXECUTE_REFUSED',
      provenUnsent: true
    });
  });

  it('keeps a lost Execute unknown within grace and escalates to RECONCILIATION_REQUIRED past grace', async () => {
    const h = sdkHarness();
    const prepared = await h.client.solana.prepareTransfer({
      idempotencyKey: 'sol-lost-1',
      ...transfer
    });
    h.remote.executeRefusal = undefined;
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) => {
      if (method === 'Execute') throw new Error('Network timeout before WaaS answered');
      return request(method, body, credential);
    };
    expect(
      await h.client.solana.execute({ idempotencyKey: 'sol-lost-1', reviewId: prepared.reviewId! })
    ).toMatchObject({
      status: 'unknown',
      error: 'SUBMISSION_UNCERTAIN'
    });
    expect((await h.client.solana.refreshOperation('sol-lost-1'))?.status).toBe('unknown');
    vi.useFakeTimers({ now: Date.now() + 90_000, toFake: ['Date'] });
    // Inside the grace window: still open, not escalated.
    expect(await h.client.solana.refreshOperation('sol-lost-1')).toMatchObject({
      status: 'unknown',
      error: 'SUBMISSION_UNCERTAIN'
    });
    vi.setSystemTime(Date.now() + 120_000);
    expect(await h.client.solana.refreshOperation('sol-lost-1')).toMatchObject({
      status: 'unknown',
      error: 'RECONCILIATION_REQUIRED',
      provenUnsent: false
    });
    expect(calls(h, 'Execute')).toHaveLength(0);
  });

  it('keeps a claimed transaction with a lost response pending, never expired', async () => {
    const h = sdkHarness();
    h.remote.chainLoseExecute = true;
    expect(
      (await h.client.solana.sendTransfer({ idempotencyKey: 'sol-lost-2', ...transfer })).status
    ).toBe('unknown');
    vi.useFakeTimers({ now: Date.now() + 600_000, toFake: ['Date'] });
    h.remote.chainOutcome = 'failed';
    expect(await h.client.solana.refreshOperation('sol-lost-2')).toMatchObject({
      status: 'failed',
      txnHash: SOLANA_SIGNATURE
    });
  });
});

describe('Solana message signing', () => {
  it('signs an off-chain message and verifies it against the Solana wallet', async () => {
    const h = sdkHarness();
    const op = await h.client.solana.signMessage({
      idempotencyKey: 'sol-sign-1',
      message: 'hello solana'
    });
    expect(op).toMatchObject({ status: 'signed', verified: true, signature: SOLANA_SIGNATURE });
    expect(calls(h, 'SignMessage')[0].body).toEqual({
      network: '',
      walletId: 'wallet-sol',
      message: 'hello solana'
    });
    expect(calls(h, 'IsValidMessageSignature')[0].body).toEqual({
      networkFamily: 'solana',
      walletAddress: SOLANA_ADDRESS,
      message: 'hello solana',
      signature: SOLANA_SIGNATURE
    });
    expect(
      await h.client.solana.signMessage({ idempotencyKey: 'sol-sign-1', message: 'hello solana' })
    ).toEqual(op);
    expect(calls(h, 'SignMessage')).toHaveLength(1);
  });

  it('records a signature that does not verify as failed', async () => {
    const h = sdkHarness();
    h.remote.signaturesValid = false;
    await expect(
      h.client.solana.signMessage({ idempotencyKey: 'sol-sign-2', message: 'hello' })
    ).rejects.toMatchObject({
      code: 'SIGNATURE_INVALID'
    });
    expect((await h.client.solana.listOperations()).items[0]).toMatchObject({
      status: 'failed',
      error: 'SIGNATURE_INVALID'
    });
  });

  it('rejects a malformed signature without verifying it', async () => {
    const h = sdkHarness();
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) =>
      method === 'SignMessage' ? { signature: '0x1234' } : request(method, body, credential);
    await expect(
      h.client.solana.signMessage({ idempotencyKey: 'sol-sign-3', message: 'hello' })
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
    expect(calls(h, 'IsValidMessageSignature')).toHaveLength(0);
  });

  it.each([
    ['empty', ''],
    ['too long', 'x'.repeat(16_385)],
    ['malformed UTF-16', 'bad \uD800 surrogate']
  ])('rejects an %s message', async (_, message) => {
    const h = sdkHarness();
    await expect(
      h.client.solana.signMessage({ idempotencyKey: 'sol-sign-4', message })
    ).rejects.toMatchObject({
      code: 'INVALID_MESSAGE'
    });
    expect(h.remote.calls).toHaveLength(0);
  });
});

describe('Solana balances', () => {
  const row = {
    network: 'solana:devnet',
    accountAddress: SOLANA_ADDRESS,
    tokenProgram: null,
    mintAddress: null,
    name: 'Solana',
    symbol: 'SOL',
    decimals: 9,
    balance: '4679287',
    formattedBalance: '0.004679287',
    imageUrl: null,
    metadataUri: null,
    verificationStatus: 'unknown',
    verificationSource: 'none',
    priceUSD: '105.00',
    balanceUSD: '0.49',
    assetType: 'native'
  };
  const token = {
    ...row,
    assetType: 'fungible-token',
    tokenProgram: 'token-2022',
    mintAddress: usdcDevnet,
    name: 'USD Coin',
    symbol: 'USDC',
    decimals: 6,
    balance: '4208117429',
    balanceUSD: null
  };
  const indexer = (payload: unknown, status = 200) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
    return { fetcher, client: new IndexerClient('pk_dev_sdbx_abc_key', fetcher) };
  };

  it('reads SOL with 9 decimals and Token-2022 balances from the Solana gateway', async () => {
    const { fetcher, client } = indexer({
      balances: [row, token],
      errors: [{ network: 'solana:mainnet', reason: 'RPC unavailable' }]
    });
    const balances = await client.getSolanaBalances(SOLANA_ADDRESS);
    expect(balances.items).toEqual([
      {
        network: 'solana:devnet',
        asset: 'native',
        name: 'Solana',
        symbol: 'SOL',
        balance: '4679287',
        decimals: 9,
        balanceUSD: '0.49'
      },
      {
        network: 'solana:devnet',
        asset: usdcDevnet,
        name: 'USD Coin',
        symbol: 'USDC',
        balance: '4208117429',
        decimals: 6,
        tokenProgram: 'token-2022'
      }
    ]);
    expect(balances.errors).toEqual([{ network: 'solana:mainnet', message: 'RPC unavailable' }]);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://sandbox-api.dev.polygon-dev.technology/v1/SolanaIndexerGateway/GetTokenBalancesDetails'
    );
    expect(JSON.parse(init.body as string)).toEqual({
      networks: ['solana:mainnet', 'solana:devnet'],
      filter: { accountAddresses: [SOLANA_ADDRESS], omitNativeBalances: false },
      omitMetadata: false
    });
  });

  it.each([
    ['another wallet', { ...row, accountAddress: SOLANA_ADDRESS.replace(/1/, '2') }],
    ['an unrequested network', { ...row, network: 'solana:testnet' }],
    ['18 native decimals', { ...row, decimals: 18 }],
    ['an unknown token program', { ...token, tokenProgram: 'other' }],
    ['a token without a mint', { ...token, mintAddress: null }]
  ])('rejects balances for %s', async (_, balance) => {
    const { client } = indexer({ balances: [balance], errors: [] });
    await expect(client.getSolanaBalances(SOLANA_ADDRESS)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
  });

  it('rejects bad input and failed responses', async () => {
    const { client } = indexer({}, 500);
    await expect(client.getSolanaBalances('0x123')).rejects.toMatchObject({
      code: 'INVALID_ADDRESS'
    });
    await expect(client.getSolanaBalances(SOLANA_ADDRESS, [])).rejects.toMatchObject({
      code: 'UNSUPPORTED_NETWORK'
    });
    await expect(client.getSolanaBalances(SOLANA_ADDRESS)).rejects.toMatchObject({
      code: 'INDEXER_UNAVAILABLE'
    });
  });
});
