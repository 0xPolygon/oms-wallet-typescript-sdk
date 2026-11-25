import { hashTypedData } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import {
  UpstreamError,
  type TronCallInput,
  type TronTransferInput,
  type TypedDataInput
} from '@polygonlabs/oms-server-wallet-sdk';

import { IndexerClient } from '../src/indexer.js';
import { hexToTron, tronToHex } from '../src/internal/protocol/addresses.js';
import { validateTronTypedData } from '../src/typed-data.js';
import { SOLANA_ADDRESS, TRON_ADDRESS, TRON_RECIPIENT, TRON_TXID, sdkHarness } from './helpers.js';

const usdt = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
const transfer = {
  network: 'tron:nile' as const,
  to: TRON_RECIPIENT,
  asset: 'native',
  amount: '1500000'
};
const tokenTransfer = { ...transfer, asset: usdt, amount: '2500000' };
const call = {
  network: 'tron:nile' as const,
  to: usdt,
  method: 'approve',
  args: [
    { type: 'address', value: TRON_RECIPIENT },
    { type: 'uint256', value: '2500000' }
  ]
};
const calls = (h: ReturnType<typeof sdkHarness>, method: string) =>
  h.remote.calls.filter((entry) => entry.method === method);

describe('Tron transfers, calls and fees', () => {
  it('sends a sponsored TRX transfer in native mode without a fee option', async () => {
    const h = sdkHarness();
    const op = await h.client.tron.sendTransfer({ idempotencyKey: 'trx-send-1', ...transfer });
    expect(calls(h, 'CreateWallet').map((entry) => entry.body.networkFamily)).toEqual(['tron']);
    expect(calls(h, 'PrepareTronTransaction')[0].body).toEqual({
      network: 'tron:nile',
      walletId: 'wallet-trx',
      to: TRON_RECIPIENT,
      value: '1500000',
      mode: 'native'
    });
    expect(calls(h, 'Execute')[0].body).toEqual({ txnId: 'trx-txn-1' });
    expect(op).toMatchObject({
      family: 'tron',
      kind: 'transfer',
      status: 'pending',
      transfer: { network: 'tron:nile', to: TRON_RECIPIENT, asset: 'native', amount: '1500000' }
    });
    expect(op.fee).toBeUndefined();
    h.remote.chainOutcome = 'executed';
    expect(await h.client.tron.refreshOperation('trx-send-1')).toMatchObject({
      status: 'executed',
      txnHash: TRON_TXID
    });
  });

  it('builds a TRC-20 transfer as transfer(address,uint256) on the token contract', async () => {
    const h = sdkHarness();
    const prepared = await h.client.tron.prepareTransfer({
      idempotencyKey: 'trx-token-1',
      ...tokenTransfer,
      amount: (2n ** 255n).toString()
    });
    expect(calls(h, 'PrepareTronContractCall')[0].body).toEqual({
      network: 'tron:nile',
      walletId: 'wallet-trx',
      contract: usdt,
      method: 'transfer',
      args: [
        { type: 'address', value: TRON_RECIPIENT },
        { type: 'uint256', value: (2n ** 255n).toString() }
      ],
      mode: 'native'
    });
    expect(prepared).toMatchObject({
      kind: 'transfer',
      status: 'quoted',
      transfer: { asset: usdt, to: TRON_RECIPIENT, amount: (2n ** 255n).toString() }
    });
    expect(prepared.call).toBeUndefined();
    expect(calls(h, 'PrepareTronTransaction')).toHaveLength(0);
  });

  it('refuses to pay TRX unless the caller sets maxQuotedFee', async () => {
    const h = sdkHarness();
    h.remote.chainSponsored = false;
    await expect(
      h.client.tron.sendTransfer({ idempotencyKey: 'trx-fee-1', ...transfer })
    ).rejects.toMatchObject({
      code: 'SPONSORSHIP_REQUIRED'
    });
    expect(await h.client.tron.getOperation('trx-fee-1')).toMatchObject({
      status: 'failed',
      error: 'SPONSORSHIP_REQUIRED',
      provenUnsent: true
    });
    expect(calls(h, 'Execute')).toHaveLength(0);
  });

  it('pays the quoted TRX fee within maxQuotedFee and selects it on Execute', async () => {
    const h = sdkHarness();
    h.remote.chainSponsored = false;
    const op = await h.client.tron.sendTransfer({
      idempotencyKey: 'trx-fee-2',
      ...transfer,
      maxQuotedFee: '345000'
    });
    expect(op).toMatchObject({ status: 'pending', maxQuotedFee: '345000' });
    expect(op.fee).toMatchObject({ token: { symbol: 'TRX' }, value: '345000' });
    expect(calls(h, 'Execute')[0].body).toEqual({
      txnId: 'trx-txn-1',
      feeOption: { token: 'TRX', index: 0 }
    });
  });

  it('refuses a quoted fee above maxQuotedFee before executing', async () => {
    const h = sdkHarness();
    h.remote.chainSponsored = false;
    h.remote.tronFee = '345001';
    await expect(
      h.client.tron.sendTransfer({
        idempotencyKey: 'trx-fee-3',
        ...transfer,
        maxQuotedFee: '345000'
      })
    ).rejects.toMatchObject({ code: 'FEE_LIMIT_EXCEEDED' });
    expect(calls(h, 'Execute')).toHaveLength(0);
  });

  it('records a fee re-priced above the quote at Execute as failed, with nothing sent', async () => {
    const h = sdkHarness();
    h.remote.chainSponsored = false;
    const prepared = await h.client.tron.prepareTransfer({
      idempotencyKey: 'trx-fee-4',
      ...transfer,
      maxQuotedFee: '400000'
    });
    h.remote.executeRefusal = 7310;
    expect(
      await h.client.tron.execute({ idempotencyKey: 'trx-fee-4', reviewId: prepared.reviewId! })
    ).toMatchObject({
      status: 'failed',
      error: 'FEE_ABOVE_QUOTE',
      provenUnsent: true
    });
    expect(h.remote.chainTxns.get('trx-txn-1')!.status).toBe('quoted');
  });

  it('rejects a fee quote that is not a single TRX option', async () => {
    const h = sdkHarness();
    h.remote.chainSponsored = false;
    h.remote.nullFeeOptions = true;
    await expect(
      h.client.tron.prepareTransfer({
        idempotencyKey: 'trx-fee-5',
        ...transfer,
        maxQuotedFee: '400000'
      })
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('makes maxQuotedFee part of the request: changing it under the same ID conflicts', async () => {
    const h = sdkHarness();
    await h.client.tron.prepareTransfer({ idempotencyKey: 'trx-fee-6', ...transfer });
    await expect(
      h.client.tron.prepareTransfer({
        idempotencyKey: 'trx-fee-6',
        ...transfer,
        maxQuotedFee: '1'
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('sends raw calldata as a call, keeping an empty 0x for the fallback', async () => {
    const h = sdkHarness();
    const first = await h.client.tron.prepareCall({
      idempotencyKey: 'trx-raw-1',
      network: 'tron:nile',
      to: usdt,
      data: '0xA9059CBB'
    });
    await h.client.tron.prepareCall({
      idempotencyKey: 'trx-raw-2',
      network: 'tron:nile',
      to: usdt,
      value: '5',
      data: '0x'
    });
    expect(calls(h, 'PrepareTronTransaction').map((entry) => entry.body)).toMatchObject([
      { to: usdt, value: '0', data: '0xa9059cbb' },
      { to: usdt, value: '5', data: '0x' }
    ]);
    expect(first).toMatchObject({
      kind: 'call',
      transaction: { to: usdt, value: '0', data: '0xa9059cbb' }
    });
    expect(first.call).toBeUndefined();
  });

  it('prepares an ABI call that WaaS encodes, then executes it once and refuses immediate send on review quote', async () => {
    const h = sdkHarness();
    const prepared = await h.client.tron.prepareCall({
      idempotencyKey: 'trx-call-1',
      ...call
    });
    expect(calls(h, 'PrepareTronContractCall')[0].body).toEqual({
      network: 'tron:nile',
      walletId: 'wallet-trx',
      contract: usdt,
      method: 'approve',
      args: call.args,
      mode: 'native'
    });
    expect(prepared).toMatchObject({
      kind: 'call',
      status: 'quoted',
      network: 'tron:nile',
      call: { to: usdt, method: 'approve', args: call.args }
    });
    // Immediate send cannot adopt a review-mode operation ID!
    await expect(
      h.client.tron.sendCall({ idempotencyKey: 'trx-call-1', ...call })
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(
      (await h.client.tron.execute({ idempotencyKey: 'trx-call-1', reviewId: prepared.reviewId! }))
        .status
    ).toBe('pending');
    expect(
      (await h.client.tron.execute({ idempotencyKey: 'trx-call-1', reviewId: prepared.reviewId! }))
        .status
    ).toBe('pending');
    expect(calls(h, 'Execute')).toHaveLength(1);
  });

  it('snapshots call arguments when the call is made', async () => {
    const h = sdkHarness();
    const args = [{ type: 'uint256', value: '1' }];
    const pending = h.client.tron.prepareCall({
      idempotencyKey: 'trx-call-2',
      ...call,
      args
    });
    args[0].value = '999';
    await pending;
    expect(calls(h, 'PrepareTronContractCall')[0].body.args).toEqual([
      { type: 'uint256', value: '1' }
    ]);
  });

  it.each([
    ['an EVM recipient', { to: '0x2222222222222222222222222222222222222222' }, 'INVALID_ADDRESS'],
    ['an EVM token', { asset: '0x2222222222222222222222222222222222222222' }, 'INVALID_ADDRESS'],
    ['the token contract as recipient', { asset: TRON_RECIPIENT }, 'INVALID_ADDRESS'],
    ['a zero TRX transfer', { amount: '0' }, 'INVALID_AMOUNT'],
    ['a TRX amount from 2^63', { amount: (2n ** 63n).toString() }, 'INVALID_AMOUNT'],
    [
      'a token amount from 2^256',
      { asset: usdt, amount: (2n ** 256n).toString() },
      'INVALID_AMOUNT'
    ],
    ['a leading-zero amount', { amount: '01' }, 'INVALID_AMOUNT'],
    ['a zero maxQuotedFee', { maxQuotedFee: '0' }, 'INVALID_FEE'],
    ['an unknown network', { network: 'tron:shasta' }, 'UNSUPPORTED_NETWORK'],
    ['calldata', { data: '0x' }, 'INVALID_TRANSFER'],
    ['the old maxFee name', { maxFee: '1' }, 'INVALID_TRANSFER']
  ])('rejects a transfer with %s before contacting WaaS', async (_, change, code) => {
    const h = sdkHarness();
    await expect(
      h.client.tron.prepareTransfer({
        idempotencyKey: 'trx-bad-1',
        ...transfer,
        ...change
      } as TronTransferInput)
    ).rejects.toMatchObject({ code });
    expect(h.remote.calls).toHaveLength(0);
  });

  it.each([
    ['a full signature as the method', { method: 'transfer(address,uint256)' }, 'INVALID_CALL'],
    ['an unknown ABI type', { args: [{ type: 'uint7', value: '1' }] }, 'INVALID_CALL'],
    ['an argument without a value', { args: [{ type: 'bool' }] }, 'INVALID_CALL'],
    ['too many arguments', { args: Array(33).fill({ type: 'bool', value: true }) }, 'INVALID_CALL'],
    ['an unsafe number', { args: [{ type: 'uint256', value: 2 ** 60 }] }, 'INVALID_JSON'],
    ['both method and data', { data: '0x' }, 'INVALID_CALL'],
    ['a value on an ABI call', { value: '1' }, 'INVALID_CALL'],
    ['args without a method', { method: undefined, data: '0x' }, 'INVALID_CALL'],
    ['odd-length calldata', { method: undefined, args: undefined, data: '0xabc' }, 'INVALID_CALL'],
    [
      'a value from 2^63',
      { method: undefined, args: undefined, data: '0x', value: (2n ** 63n).toString() },
      'INVALID_AMOUNT'
    ],
    ['neither method nor data', { method: undefined, args: undefined }, 'INVALID_CALL'],
    ['the old contract field', { contract: usdt }, 'INVALID_CALL']
  ])('rejects a call with %s before contacting WaaS', async (_, change, code) => {
    const h = sdkHarness();
    await expect(
      h.client.tron.prepareCall({
        idempotencyKey: 'trx-bad-2',
        ...call,
        ...change
      } as TronCallInput)
    ).rejects.toMatchObject({ code });
    expect(h.remote.calls).toHaveLength(0);
  });

  it('refuses transfers to, tokens at and calls on the wallet itself', async () => {
    const h = sdkHarness();
    await expect(
      h.client.tron.prepareTransfer({ idempotencyKey: 'trx-self-1', ...transfer, to: TRON_ADDRESS })
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    await expect(
      h.client.tron.prepareTransfer({
        idempotencyKey: 'trx-self-2',
        ...tokenTransfer,
        to: TRON_ADDRESS
      })
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    await expect(
      h.client.tron.prepareTransfer({
        idempotencyKey: 'trx-self-3',
        ...tokenTransfer,
        asset: TRON_ADDRESS
      })
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    await expect(
      h.client.tron.prepareCall({ idempotencyKey: 'trx-self-4', ...call, to: TRON_ADDRESS })
    ).rejects.toMatchObject({ code: 'INVALID_CALL' });
    await expect(
      h.client.tron.prepareCall({
        idempotencyKey: 'trx-self-5',
        network: 'tron:nile',
        to: TRON_ADDRESS,
        data: '0x'
      })
    ).rejects.toMatchObject({ code: 'INVALID_CALL' });
    expect(calls(h, 'PrepareTronTransaction')).toHaveLength(0);
    expect(calls(h, 'PrepareTronContractCall')).toHaveLength(0);
  });

  it('follows a claimed transaction after a refused broadcast', async () => {
    const h = sdkHarness();
    const prepared = await h.client.tron.prepareTransfer({
      idempotencyKey: 'trx-claimed-1',
      ...transfer
    });
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) => {
      if (method !== 'Execute') return request(method, body, credential);
      h.remote.chainTxns.get('trx-txn-1')!.status = 'pending';
      throw new UpstreamError(7311, method);
    };
    expect(
      await h.client.tron.execute({
        idempotencyKey: 'trx-claimed-1',
        reviewId: prepared.reviewId!
      })
    ).toMatchObject({
      status: 'pending',
      txnHash: TRON_TXID
    });
  });
});

describe('Tron message and typed-data signing', () => {
  const typedData: TypedDataInput = {
    domain: { name: 'Permit', version: '1', chainId: 3448148188 as const, verifyingContract: usdt },
    types: {
      Transfer: [
        { name: 'to', type: 'address' },
        { name: 'cc', type: 'address[]' },
        { name: 'amount', type: 'uint256' },
        { name: 'memo', type: 'Memo' }
      ],
      Memo: [
        { name: 'from', type: 'address' },
        { name: 'text', type: 'string' }
      ]
    },
    primaryType: 'Transfer',
    message: {
      to: TRON_RECIPIENT,
      cc: [TRON_ADDRESS],
      amount: '123456789012345678901234567890',
      memo: { from: TRON_ADDRESS, text: 'hi' }
    }
  };

  it('signs a TIP-191 message and verifies it against the Tron wallet', async () => {
    const h = sdkHarness();
    const op = await h.client.tron.signMessage({
      idempotencyKey: 'trx-sign-1',
      message: 'hello tron'
    });
    expect(op).toMatchObject({ status: 'signed', verified: true, kind: 'sign' });
    expect(calls(h, 'IsValidMessageSignature')[0].body).toMatchObject({
      networkFamily: 'tron',
      walletAddress: TRON_ADDRESS,
      message: 'hello tron'
    });
  });

  it('hashes TIP-712 data as EIP-712 over the hex form of its Tron addresses', () => {
    const { digest, typedData: normalized } = validateTronTypedData(typedData, 3448148188);
    const hex = (address: string) => tronToHex(address);
    expect(digest).toBe(
      hashTypedData({
        domain: { ...typedData.domain, chainId: 3448148188 as const, verifyingContract: hex(usdt) },
        types: typedData.types,
        primaryType: 'Transfer',
        message: {
          to: hex(TRON_RECIPIENT),
          cc: [hex(TRON_ADDRESS)],
          amount: 123456789012345678901234567890n,
          memo: { from: hex(TRON_ADDRESS), text: 'hi' }
        }
      })
    );
    expect(normalized.domain.verifyingContract).toBe(hex(usdt));
    const hexInput = {
      ...typedData,
      domain: { ...typedData.domain, verifyingContract: hex(usdt) }
    };
    expect(validateTronTypedData(hexInput, 3448148188).digest).toBe(digest);
  });

  it('signs typed data bound to the network and verifies it with WaaS', async () => {
    const h = sdkHarness();
    const op = await h.client.tron.signTypedData({
      idempotencyKey: 'trx-712-1',
      network: 'tron:nile',
      typedData
    });
    expect(op).toMatchObject({ kind: 'signTypedData', network: 'tron:nile', status: 'signed' });
    const sent = calls(h, 'SignTypedData')[0].body;
    expect(sent).toMatchObject({ network: '', walletId: 'wallet-trx' });
    expect(calls(h, 'IsValidTypedDataSignature')[0].body).toMatchObject({
      networkFamily: 'tron',
      walletAddress: TRON_ADDRESS,
      typedData: sent.typedData
    });
  });

  it.each([
    ['the wrong network', 'tron:mainnet', typedData],
    ['a bad checksum', 'tron:nile', { ...typedData, message: { ...typedData.message, to: 'T1' } }],
    [
      'a missing verifying contract',
      'tron:nile',
      { ...typedData, domain: { name: 'Permit', chainId: 3448148188 as const } }
    ]
  ])('rejects typed data for %s', async (_, network, data) => {
    const h = sdkHarness();
    await expect(
      h.client.tron.signTypedData({
        idempotencyKey: 'trx-712-2',
        network: network as 'tron:nile',
        typedData: data as TypedDataInput
      })
    ).rejects.toMatchObject({ code: 'INVALID_TYPED_DATA' });
    expect(h.remote.calls).toHaveLength(0);
  });

  it('rejects malformed signatures and messages', async () => {
    const h = sdkHarness();
    const request = h.remote.request.bind(h.remote);
    h.remote.request = async (method, body, credential) =>
      method === 'SignMessage' ? { signature: '0x12' } : request(method, body, credential);
    await expect(
      h.client.tron.signMessage({ idempotencyKey: 'trx-sign-2', message: 'hello' })
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
    await expect(
      h.client.tron.signMessage({ idempotencyKey: 'trx-sign-3', message: '' })
    ).rejects.toMatchObject({
      code: 'INVALID_MESSAGE'
    });
    await expect(
      h.client.tron.signTypedData({
        idempotencyKey: 'trx-sign-4',
        network: 'tron:shasta' as 'tron:nile',
        typedData
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_NETWORK' });
  });
});

describe('Tron balances', () => {
  const trx = {
    network: 'tron:nile',
    accountAddress: TRON_ADDRESS,
    assetType: 'native',
    tokenStandard: null,
    contractAddress: null,
    name: 'Tron',
    symbol: 'TRX',
    decimals: 6,
    balance: '2000000',
    formattedBalance: '2',
    verificationStatus: 'verified',
    verificationSource: 'tronscan'
  };
  const trc20 = {
    ...trx,
    assetType: 'fungible-token',
    tokenStandard: 'trc20',
    contractAddress: usdt,
    name: 'Tether USD',
    symbol: 'USDT',
    balance: '7000000',
    balanceUSD: '7.00'
  };
  const indexer = (payload: unknown) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    return { fetcher, client: new IndexerClient('pk_sdbx_abc_key', fetcher) };
  };

  it('reads TRX with 6 decimals and TRC-20 balances from the Tron gateway', async () => {
    const { fetcher, client } = indexer({ balances: [trx, trc20], errors: [] });
    const balances = await client.getTronBalances(TRON_ADDRESS, ['tron:nile']);
    expect(balances.items).toEqual([
      {
        network: 'tron:nile',
        asset: 'native',
        name: 'Tron',
        symbol: 'TRX',
        balance: '2000000',
        decimals: 6
      },
      {
        network: 'tron:nile',
        asset: usdt,
        name: 'Tether USD',
        symbol: 'USDT',
        balance: '7000000',
        decimals: 6,
        balanceUSD: '7.00'
      }
    ]);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://sandbox-api.polygon.technology/v1/TronIndexerGateway/GetTokenBalancesDetails'
    );
    expect(JSON.parse(init.body as string).networks).toEqual(['tron:nile']);
  });

  it.each([
    ['9 native decimals', { ...trx, decimals: 9 }],
    ['a hex token contract', { ...trc20, contractAddress: tronToHex(usdt) }],
    ['a non-TRC-20 token', { ...trc20, tokenStandard: 'trc10' }]
  ])('rejects balances with %s', async (_, balance) => {
    const { client } = indexer({ balances: [balance], errors: [] });
    await expect(client.getTronBalances(TRON_ADDRESS)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
  });

  it('rejects a non-Tron address', async () => {
    const { client } = indexer({ balances: [], errors: [] });
    await expect(client.getTronBalances(SOLANA_ADDRESS)).rejects.toMatchObject({
      code: 'INVALID_ADDRESS'
    });
    expect(hexToTron(tronToHex(usdt))).toBe(usdt);
  });
});
