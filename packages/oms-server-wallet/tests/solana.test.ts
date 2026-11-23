import { afterEach, describe, expect, it, vi } from 'vitest';

import { IndexerClient, type SolanaTransfer } from '@polygonlabs/oms-server-wallet-sdk';

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
    const op = await h.client.solana.sendTransfer('sol-send-1', transfer);
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
    expect(await h.client.solana.getOperation('sol-send-1')).toMatchObject({
      status: 'executed',
      txnHash: SOLANA_SIGNATURE
    });
    expect(await h.client.solana.sendTransfer('sol-send-1', transfer)).toMatchObject({
      status: 'executed'
    });
    expect(calls(h, 'Execute')).toHaveLength(1);
  });
  it('sends SPL and Token-2022 mints as the asset; WaaS picks the token program', async () => {
    const h = sdkHarness();
    await h.client.solana.prepareTransfer('sol-spl-1', { ...transfer, asset: usdcDevnet });
    expect(calls(h, 'PrepareSolanaTransfer')[0].body.asset).toBe(usdcDevnet);
  });
  it('lets a quote be reviewed before it is executed', async () => {
    const h = sdkHarness();
    const quoted = await h.client.solana.prepareTransfer('sol-review-1', transfer);
    expect(quoted.status).toBe('quoted');
    expect(Date.parse(quoted.quote!.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
    expect(calls(h, 'Execute')).toHaveLength(0);
    expect((await h.client.solana.executeTransfer('sol-review-1')).status).toBe('pending');
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
      h.client.solana.prepareTransfer('sol-bad-1', { ...transfer, ...change } as SolanaTransfer)
    ).rejects.toMatchObject({ code });
    expect(h.remote.calls).toHaveLength(0);
  });
  it('refuses a transfer to the wallet itself', async () => {
    const h = sdkHarness();
    await expect(
      h.client.solana.prepareTransfer('sol-self-1', { ...transfer, to: SOLANA_ADDRESS })
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    expect(calls(h, 'PrepareSolanaTransfer')).toHaveLength(0);
  });
  it('requires sponsorship and records the refusal', async () => {
    const h = sdkHarness();
    h.remote.chainSponsored = false;
    await expect(h.client.solana.sendTransfer('sol-unsponsored', transfer)).rejects.toMatchObject({
      code: 'SPONSORSHIP_REQUIRED'
    });
    expect(await h.client.solana.getOperation('sol-unsponsored')).toMatchObject({
      status: 'failed',
      error: 'SPONSORSHIP_REQUIRED'
    });
    expect(calls(h, 'Execute')).toHaveLength(0);
  });
  it('reads null fee options from older servers as none', async () => {
    const h = sdkHarness();
    h.remote.nullFeeOptions = true;
    expect((await h.client.solana.prepareTransfer('sol-null-fees', transfer)).quote).toMatchObject({
      sponsored: true,
      feeOptions: []
    });
  });
  it('keeps IDs unique across families and inputs', async () => {
    const h = sdkHarness();
    await h.client.solana.prepareTransfer('shared-id-1', transfer);
    await expect(
      h.client.solana.prepareTransfer('shared-id-1', { ...transfer, amount: '2' })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(h.client.signMessage('shared-id-1', 137, 'hello')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT'
    });
    // EVM listings and lookups never return Solana operations.
    expect(await h.client.listOperations()).toEqual([]);
    expect(await h.client.getOperation('shared-id-1')).toBeNull();
    await expect(h.client.executeOperation('shared-id-1')).rejects.toMatchObject({
      code: 'NOT_FOUND'
    });
    expect((await h.client.solana.listOperations()).map((op) => op.id)).toEqual(['shared-id-1']);
  });
});

describe('Solana quote expiry', () => {
  it('marks a quote that expired before submission and sends nothing', async () => {
    const h = sdkHarness();
    await h.client.solana.prepareTransfer('sol-late-1', transfer);
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ['Date'] });
    await expect(h.client.solana.executeTransfer('sol-late-1')).rejects.toMatchObject({
      code: 'TRANSACTION_EXPIRED'
    });
    expect(calls(h, 'Execute')).toHaveLength(0);
    expect(await h.client.solana.executeTransfer('sol-late-1')).toMatchObject({
      status: 'expired',
      error: 'TRANSACTION_EXPIRED'
    });
  });
  it('settles an Execute refused as expired by WaaS as not sent', async () => {
    const h = sdkHarness();
    await h.client.solana.prepareTransfer('sol-blockhash-1', transfer);
    // The blockhash lapsed first: WaaS refuses before claiming, so the row is still quoted.
    h.remote.executeRefusal = 7309;
    await expect(h.client.solana.executeTransfer('sol-blockhash-1')).rejects.toMatchObject({
      code: 'TRANSACTION_EXPIRED'
    });
    expect(await h.client.solana.getOperation('sol-blockhash-1')).toMatchObject({
      status: 'expired'
    });
  });
  it('follows the claimed transaction when an Execute refusal comes after the claim', async () => {
    const h = sdkHarness();
    await h.client.solana.prepareTransfer('sol-claimed-1', transfer);
    const txn = () => h.remote.chainTxns.get('sol-txn-1')!;
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) => {
      if (method === 'Execute') {
        txn().status = 'pending'; // claimed, then the broadcast failed
        h.remote.calls.push({ method, body });
        const { UpstreamError } = await import('@polygonlabs/oms-server-wallet-sdk');
        throw new UpstreamError(7311, method);
      }
      return request(method, body, credential);
    };
    expect(await h.client.solana.executeTransfer('sol-claimed-1')).toMatchObject({
      status: 'pending',
      txnHash: SOLANA_SIGNATURE
    });
  });
  it('records other refusals before submission as failed', async () => {
    const h = sdkHarness();
    await h.client.solana.prepareTransfer('sol-refused-1', transfer);
    h.remote.executeRefusal = 7306;
    expect(await h.client.solana.executeTransfer('sol-refused-1')).toMatchObject({
      status: 'failed',
      error: 'EXECUTE_REFUSED'
    });
  });
  it('keeps a lost Execute unknown, then never treats it as expired within the grace period', async () => {
    const h = sdkHarness();
    await h.client.solana.prepareTransfer('sol-lost-1', transfer);
    h.remote.executeRefusal = undefined;
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) => {
      if (method === 'Execute') throw new Error('Network timeout before WaaS answered');
      return request(method, body, credential);
    };
    expect(await h.client.solana.executeTransfer('sol-lost-1')).toMatchObject({
      status: 'unknown',
      error: 'SUBMISSION_UNCERTAIN'
    });
    // Within a minute the quote still lives: still uncertain.
    expect((await h.client.solana.getOperation('sol-lost-1'))?.status).toBe('unknown');
    vi.useFakeTimers({ now: Date.now() + 90_000, toFake: ['Date'] });
    await expect(h.client.solana.getOperation('sol-lost-1')).rejects.toMatchObject({
      upstreamCode: 7309
    });
    vi.setSystemTime(Date.now() + 120_000);
    expect(await h.client.solana.getOperation('sol-lost-1')).toMatchObject({
      status: 'expired',
      error: 'TRANSACTION_EXPIRED'
    });
    expect(calls(h, 'Execute')).toHaveLength(0);
  });
  it('keeps a claimed transaction with a lost response pending, never expired', async () => {
    const h = sdkHarness();
    h.remote.chainLoseExecute = true;
    expect((await h.client.solana.sendTransfer('sol-lost-2', transfer)).status).toBe('unknown');
    vi.useFakeTimers({ now: Date.now() + 600_000, toFake: ['Date'] });
    h.remote.chainOutcome = 'failed';
    expect(await h.client.solana.getOperation('sol-lost-2')).toMatchObject({
      status: 'failed',
      txnHash: SOLANA_SIGNATURE
    });
  });
});

describe('Solana message signing', () => {
  it('signs an off-chain message and verifies it against the Solana wallet', async () => {
    const h = sdkHarness();
    const op = await h.client.solana.signMessage('sol-sign-1', 'hello solana');
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
    expect(await h.client.solana.signMessage('sol-sign-1', 'hello solana')).toEqual(op);
    expect(calls(h, 'SignMessage')).toHaveLength(1);
  });
  it('records a signature that does not verify as failed', async () => {
    const h = sdkHarness();
    h.remote.signaturesValid = false;
    await expect(h.client.solana.signMessage('sol-sign-2', 'hello')).rejects.toMatchObject({
      code: 'SIGNATURE_INVALID'
    });
    expect((await h.client.solana.listOperations())[0]).toMatchObject({
      status: 'failed',
      error: 'SIGNATURE_INVALID'
    });
  });
  it('rejects a malformed signature without verifying it', async () => {
    const h = sdkHarness();
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) =>
      method === 'SignMessage' ? { signature: '0x1234' } : request(method, body, credential);
    await expect(h.client.solana.signMessage('sol-sign-3', 'hello')).rejects.toMatchObject({
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
    await expect(h.client.solana.signMessage('sol-sign-4', message)).rejects.toMatchObject({
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
    await expect(client.getSolanaBalances(TRON_ADDRESS)).rejects.toMatchObject({
      code: 'INVALID_ADDRESS'
    });
    await expect(
      client.getSolanaBalances(SOLANA_ADDRESS, ['solana:testnet' as 'solana:devnet'])
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_NETWORK' });
    await expect(client.getSolanaBalances(SOLANA_ADDRESS)).rejects.toMatchObject({
      code: 'INDEXER_UNAVAILABLE'
    });
    const malformed = indexer({ balances: 'x' });
    await expect(malformed.client.getSolanaBalances(SOLANA_ADDRESS)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
  });
});
