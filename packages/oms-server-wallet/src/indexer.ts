import { getAddress, isAddress } from 'viem';
import { z } from 'zod';

import { CHAINS, environmentFromKey, requireChain } from './environment.js';
import { WalletError } from './errors.js';
import { boundedText } from './http.js';
import { isSolanaAddress, isTronAddress } from './internal/protocol/addresses.js';
import { SOLANA_NETWORKS, TRON_NETWORKS } from './internal/protocol/networks.js';

export type SolanaNetwork = (typeof SOLANA_NETWORKS)[number];
export type TronNetwork = (typeof TRON_NETWORKS)[number];

const quantity = z.string().regex(/^[0-9]+$/);
const rowSchema = z.object({
  chainId: z.number().int(),
  accountAddress: z.string(),
  balance: quantity.optional(),
  balanceWei: quantity.optional(),
  contractType: z.string().optional(),
  contractAddress: z.string().optional(),
  name: z.string().optional(),
  symbol: z.string().optional(),
  balanceUSD: z.string().optional(),
  contractInfo: z
    .object({
      name: z.string().optional(),
      symbol: z.string().optional(),
      decimals: z.number().int().min(0).max(255).optional()
    })
    .optional(),
  errorReason: z.string().optional()
});
const groupSchema = z.object({
  chainId: z.number().int(),
  errorReason: z.string().optional(),
  results: z.array(rowSchema).optional()
});
const responseSchema = z.object({
  nativeBalances: z.array(groupSchema),
  balances: z.array(groupSchema),
  page: z
    .object({ page: z.number().int(), pageSize: z.number().int(), more: z.boolean() })
    .optional()
});

/** Single EVM native or ERC-20 balance from the unattested indexer. */
export interface EvmBalance {
  readonly chainId: number;
  readonly asset: string;
  readonly name: string;
  readonly symbol: string;
  readonly balance: string;
  readonly decimals?: number;
  readonly balanceUSD?: string;
}

/** Paginated EVM balances from the unattested indexer. */
export interface EvmBalances {
  readonly items: readonly EvmBalance[];
  readonly errors: readonly { readonly chainId: number; readonly message: string }[];
  readonly nextPage?: number;
  readonly fetchedAt: string;
}

/** A Solana or Tron balance. `asset` is `'native'` or the token's mint or contract address. */
export interface ChainBalance {
  readonly network: string;
  readonly asset: 'native' | string;
  readonly name: string;
  readonly symbol: string;
  /** Base units: lamports or sun for the native asset. */
  readonly balance: string;
  readonly decimals: number;
  readonly balanceUSD?: string;
  /** The Solana token program that owns the mint. */
  readonly tokenProgram?: 'spl-token' | 'token-2022';
}

/** Solana or Tron balances from the unattested indexer. */
export interface ChainBalances {
  readonly items: readonly ChainBalance[];
  readonly errors: readonly { readonly network: string; readonly message: string }[];
  readonly fetchedAt: string;
}

const nativeDecimals = { solana: 9, tron: 6 } as const;
const gatewayRowSchema = z.object({
  network: z.string(),
  accountAddress: z.string(),
  assetType: z.enum(['native', 'fungible-token']),
  tokenProgram: z.string().nullish(),
  tokenStandard: z.string().nullish(),
  mintAddress: z.string().nullish(),
  contractAddress: z.string().nullish(),
  name: z.string(),
  symbol: z.string(),
  decimals: z.number().int().min(0).max(255),
  balance: quantity,
  balanceUSD: z.string().nullish()
});
const gatewaySchema = z.object({
  balances: z.array(gatewayRowSchema),
  errors: z.array(z.object({ network: z.string(), reason: z.string() }))
});

/**
 * Balances come from the indexer and are not attested by the wallet enclave: use them for display
 * and preflight checks only, never as proof of funds.
 */
export class IndexerClient {
  private readonly environment;
  constructor(
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.environment = environmentFromKey(key);
  }
  /** SOL and SPL/Token-2022 balances on the requested networks (both by default). */
  async getSolanaBalances(
    walletAddress: string,
    networks: readonly SolanaNetwork[] = SOLANA_NETWORKS
  ): Promise<ChainBalances> {
    if (!isSolanaAddress(walletAddress))
      throw new WalletError('INVALID_ADDRESS', 'Provide a base58 Solana wallet address.');
    return this.chainBalances(
      'solana',
      this.environment.solanaIndexerUrl,
      'webrpc@v0.31.2;gen-typescript@v0.23.1;solana-indexer-gateway@v1',
      walletAddress,
      networks,
      SOLANA_NETWORKS
    );
  }
  /** TRX (6 decimals) and TRC-20 balances on the requested networks (both by default). */
  async getTronBalances(
    walletAddress: string,
    networks: readonly TronNetwork[] = TRON_NETWORKS
  ): Promise<ChainBalances> {
    if (!isTronAddress(walletAddress))
      throw new WalletError('INVALID_ADDRESS', 'Provide a Base58Check Tron wallet address (T…).');
    return this.chainBalances(
      'tron',
      this.environment.tronIndexerUrl,
      'webrpc@v0.31.2;gen-typescript@v0.23.1;tron-indexer-gateway@v1',
      walletAddress,
      networks,
      TRON_NETWORKS
    );
  }
  private async chainBalances(
    family: 'solana' | 'tron',
    url: string,
    webrpc: string,
    address: string,
    networks: readonly string[],
    supported: readonly string[]
  ): Promise<ChainBalances> {
    if (
      !Array.isArray(networks) ||
      !networks.length ||
      networks.some((network) => !supported.includes(network))
    )
      throw new WalletError(
        'UNSUPPORTED_NETWORK',
        `Select networks from: ${supported.join(', ')}.`
      );
    const requested = [...new Set(networks)];
    const fetcher = this.fetcher;
    let response: Response;
    let body: string;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Api-Key': this.key, Webrpc: webrpc },
        body: JSON.stringify({
          networks: requested,
          filter: { accountAddresses: [address], omitNativeBalances: false },
          omitMetadata: false
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000)
      });
      body = await boundedText(response);
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw new WalletError(
        'INDEXER_UNAVAILABLE',
        'Balance service request did not complete.',
        502,
        { cause: error }
      );
    }
    if (!response.ok)
      throw new WalletError(
        'INDEXER_UNAVAILABLE',
        `Balance service returned HTTP ${response.status}.`,
        502
      );
    let parsed;
    try {
      parsed = gatewaySchema.safeParse(JSON.parse(body));
    } catch {
      throw new WalletError('INVALID_RESPONSE', 'Balance service returned invalid JSON.', 502);
    }
    if (!parsed.success)
      throw new WalletError(
        'INVALID_RESPONSE',
        'Balance service returned an invalid response.',
        502
      );
    const invalid = (message: string) => new WalletError('INVALID_RESPONSE', message, 502);
    const items: ChainBalance[] = [];
    for (const row of parsed.data.balances) {
      if (!requested.includes(row.network) || row.accountAddress !== address)
        throw invalid('Indexer returned balances for a different wallet or network.');
      if (row.assetType === 'native') {
        if (row.mintAddress || row.contractAddress || row.decimals !== nativeDecimals[family])
          throw invalid('Incomplete native balance response.');
        items.push({
          network: row.network,
          asset: 'native',
          name: row.name,
          symbol: row.symbol,
          balance: row.balance,
          decimals: row.decimals,
          ...(row.balanceUSD ? { balanceUSD: row.balanceUSD } : {})
        });
        continue;
      }
      const token = family === 'solana' ? row.mintAddress : row.contractAddress;
      const program = row.tokenProgram;
      if (
        family === 'solana'
          ? !isSolanaAddress(token) || (program !== 'spl-token' && program !== 'token-2022')
          : !isTronAddress(token) || row.tokenStandard !== 'trc20'
      )
        throw invalid('Incomplete token balance response.');
      items.push({
        network: row.network,
        asset: token!,
        name: row.name,
        symbol: row.symbol,
        balance: row.balance,
        decimals: row.decimals,
        ...(row.balanceUSD ? { balanceUSD: row.balanceUSD } : {}),
        ...(family === 'solana' ? { tokenProgram: program as 'spl-token' | 'token-2022' } : {})
      });
    }
    // Only the gateway's own errors: a missing row is not evidence of a failure.
    const errors = parsed.data.errors
      .filter((error) => requested.includes(error.network))
      .map((error) => ({ network: error.network, message: error.reason }));
    return { items, errors, fetchedAt: new Date().toISOString() };
  }
  async getBalances(
    walletAddress: string,
    options: { readonly chainIds?: readonly number[]; readonly page?: number } = {}
  ): Promise<EvmBalances> {
    if (typeof walletAddress !== 'string' || !isAddress(walletAddress))
      throw new WalletError('INVALID_ADDRESS', 'Provide a valid EVM wallet address.');
    const address = getAddress(walletAddress);
    const page = options.page ?? 0;
    if (!Number.isInteger(page) || page < 0 || page > 1000)
      throw new WalletError('INVALID_PAGE', 'Invalid balance page.');
    const requestedChainIds = options.chainIds
      ? [...new Set(options.chainIds)]
      : CHAINS.map((c) => c.id);
    if (!Array.isArray(requestedChainIds) || !requestedChainIds.length)
      throw new WalletError('UNSUPPORTED_CHAIN', 'Select one or more configured EVM networks.');
    for (const id of requestedChainIds) requireChain(id);
    const requestedSet = new Set<number>(requestedChainIds);

    const fetcher = this.fetcher;
    let response: Response;
    let body: string;
    try {
      response = await fetcher(this.environment.indexerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Api-Key': this.key,
          Webrpc: 'webrpc@v0.31.2;gen-typescript@v0.23.1;sequence-indexer@v0.4.0'
        },
        body: JSON.stringify({
          chainIds: requestedChainIds,
          filter: { accountAddresses: [address], omitNativeBalances: false, contractStatus: 'ALL' },
          omitMetadata: false,
          page: { page, pageSize: 40 }
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000)
      });
      body = await boundedText(response);
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw new WalletError(
        'INDEXER_UNAVAILABLE',
        'Balance service request did not complete.',
        502,
        { cause: error }
      );
    }
    if (!response.ok)
      throw new WalletError(
        'INDEXER_UNAVAILABLE',
        `Balance service returned HTTP ${response.status}.`,
        502
      );
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new WalletError('INVALID_RESPONSE', 'Balance service returned invalid JSON.', 502);
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success)
      throw new WalletError(
        'INVALID_RESPONSE',
        'Balance service returned an invalid response.',
        502
      );
    const result = parsed.data;
    const items: EvmBalance[] = [];
    const errors: { chainId: number; message: string }[] = [];
    for (const [native, groups] of [
      [true, result.nativeBalances],
      [false, result.balances]
    ] as const) {
      for (const group of groups) {
        if (!requestedSet.has(group.chainId)) continue;
        if (group.errorReason) {
          errors.push({ chainId: group.chainId, message: group.errorReason });
          continue;
        }
        if (!group.results) {
          errors.push({ chainId: group.chainId, message: 'No balance result returned.' });
          continue;
        }
        for (const row of group.results) {
          if (
            row.chainId !== group.chainId ||
            row.accountAddress.toLowerCase() !== address.toLowerCase()
          )
            throw new WalletError(
              'INVALID_RESPONSE',
              'Indexer returned balances for a different wallet or network.',
              502
            );
          if (row.errorReason) {
            errors.push({ chainId: group.chainId, message: row.errorReason });
            continue;
          }
          if (!native && row.contractType !== 'ERC20') continue;
          const chain = requireChain(row.chainId);
          const amount = row.balance ?? row.balanceWei;
          if (amount === undefined || (!native && !row.contractAddress))
            throw new WalletError('INVALID_RESPONSE', 'Incomplete token balance response.', 502);
          items.push({
            chainId: row.chainId,
            asset: native ? 'native' : getAddress(row.contractAddress!),
            name: native ? (row.name ?? chain.name) : (row.contractInfo?.name ?? 'Unknown token'),
            symbol: native ? (row.symbol ?? chain.symbol) : (row.contractInfo?.symbol ?? 'TOKEN'),
            balance: amount,
            decimals: native ? 18 : row.contractInfo?.decimals,
            balanceUSD: row.balanceUSD
          });
        }
      }
    }
    for (const chainId of requestedChainIds)
      if (!result.nativeBalances.some((group) => group.chainId === chainId))
        errors.push({ chainId, message: 'Native balance unavailable.' });
    return {
      items,
      errors,
      nextPage: result.page?.more ? page + 1 : undefined,
      fetchedAt: new Date().toISOString()
    };
  }
}
