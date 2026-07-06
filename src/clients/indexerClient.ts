// Minimal hand-written IndexerGateway adapter for the SDK surface we expose.

import {HttpClient} from "../httpClient.js";
import {errorMessage, OMSWalletRequestError, OMSWalletResponseError, type OMSWalletUpstreamError} from "../errors.js";
import type {Network} from "../networks.js";
import {IndexerOperation} from "../operations.js";

const WebrpcHeaderValue = "webrpc@v0.31.2;gen-typescript@v0.23.1;sequence-indexer@v0.4.0";

export type IndexerNetworkType = "MAINNETS" | "TESTNETS" | "ALL";
export type ContractVerificationStatus = "VERIFIED" | "UNVERIFIED" | "ALL";

export interface TokenBalancesPage {
    page?: number;
    column?: string;
    before?: unknown;
    after?: unknown;
    sort?: SortBy[];
    pageSize?: number;
    more?: boolean;
}

export interface SortBy {
    column: string;
    order: "DESC" | "ASC";
}

export interface TokenContractInfo {
    chainId?: number;
    address?: string;
    source?: string;
    name?: string;
    type?: string;
    symbol?: string;
    decimals?: number;
    logoURI?: string;
    deployed?: boolean;
    bytecodeHash?: string;
    extensions?: Record<string, unknown>;
    updatedAt?: string;
    queuedAt?: string | null;
    status?: string;
}

export interface TokenMetadataAsset {
    id?: number;
    collectionId?: number;
    tokenId?: string;
    url?: string;
    metadataField?: string;
    name?: string;
    filesize?: number;
    mimeType?: string;
    width?: number;
    height?: number;
    updatedAt?: string;
}

export interface TokenMetadata {
    chainId?: number;
    contractAddress?: string;
    tokenId?: string;
    source?: string;
    name?: string;
    description?: string;
    image?: string;
    video?: string;
    audio?: string;
    properties?: Record<string, unknown>;
    attributes?: Record<string, unknown>[];
    image_data?: string;
    external_url?: string;
    background_color?: string;
    animation_url?: string;
    decimals?: number;
    updatedAt?: string;
    assets?: TokenMetadataAsset[];
    status?: string;
    queuedAt?: string | null;
    lastFetched?: string;
}

export interface TokenBalance {
    contractType?: string;
    contractAddress?: string;
    accountAddress?: string;
    /** Wire format uses `tokenID`; this field is re-mapped during decoding. */
    tokenId?: string;
    name?: string;
    symbol?: string;
    balance?: string;
    balanceUSD?: string;
    priceUSD?: string;
    priceUpdatedAt?: string;
    blockHash?: string;
    blockNumber?: number;
    chainId?: number;
    uniqueCollectibles?: string;
    isSummary?: boolean;
    contractInfo?: TokenContractInfo;
    tokenMetadata?: TokenMetadata;
}

export interface MetadataOptions {
    verifiedOnly?: boolean;
    unverifiedOnly?: boolean;
    includeContracts?: string[];
}

export interface GetBalancesParams {
    walletAddress: string;
    networks?: Network[];
    networkType?: IndexerNetworkType;
    contractAddresses?: string[];
    includeMetadata?: boolean;
    omitPrices?: boolean;
    tokenIds?: string[];
    contractStatus?: ContractVerificationStatus;
    page?: TokenBalancesPage;
}

export interface BalancesResult {
    status: number;
    page?: TokenBalancesPage;
    nativeBalances: TokenBalance[];
    balances: TokenBalance[];
}

export interface TransactionTransfer {
    transferType?: string;
    contractAddress?: string;
    contractType?: string;
    from?: string;
    to?: string;
    tokenIds?: string[];
    amounts?: string[];
    logIndex?: number;
    amountsUSD?: string[];
    pricesUSD?: string[];
    contractInfo?: TokenContractInfo;
    tokenMetadata?: Record<string, TokenMetadata>;
}

export interface Transaction {
    txnHash: string;
    blockNumber: number;
    blockHash: string;
    chainId: number;
    metaTxnId?: string;
    transfers?: TransactionTransfer[];
    timestamp: string;
}

export interface GetTransactionHistoryParams {
    walletAddress: string;
    networks?: Network[];
    networkType?: IndexerNetworkType;
    contractAddresses?: string[];
    transactionHashes?: string[];
    metaTransactionIds?: string[];
    fromBlock?: number;
    toBlock?: number;
    tokenId?: string;
    includeMetadata?: boolean;
    omitPrices?: boolean;
    metadataOptions?: MetadataOptions;
    page?: TokenBalancesPage;
}

export interface TransactionHistoryResult {
    status: number;
    page?: TokenBalancesPage;
    transactions: Transaction[];
}

interface GatewayNativeTokenBalances {
    chainId: number;
    errorReason?: string;
    results?: NativeTokenBalanceRaw[];
}

interface GatewayTokenBalance {
    chainId: number;
    errorReason?: string;
    results?: TokenBalanceRaw[];
}

interface GatewayTransaction {
    chainId: number;
    errorReason?: string;
    results?: TransactionRaw[];
}

interface NativeTokenBalanceRaw {
    accountAddress?: string;
    chainId?: number;
    name?: string;
    symbol?: string;
    balance?: string;
    balanceUSD?: string;
    priceUSD?: string;
    priceUpdatedAt?: string;
    errorReason?: string;
}

interface TokenBalanceRaw {
    contractType?: string;
    contractAddress?: string;
    accountAddress?: string;
    tokenID?: string; // note the wire key
    balance?: string;
    balanceUSD?: string;
    priceUSD?: string;
    priceUpdatedAt?: string;
    blockHash?: string;
    blockNumber?: number;
    chainId?: number;
    uniqueCollectibles?: string;
    isSummary?: boolean;
    contractInfo?: TokenContractInfo;
    tokenMetadata?: TokenMetadataRaw;
}

interface TokenMetadataRaw extends Omit<TokenMetadata, "tokenId" | "assets"> {
    tokenId?: string;
    tokenID?: string;
    assets?: TokenMetadataAssetRaw[];
}

interface TokenMetadataAssetRaw extends Omit<TokenMetadataAsset, "tokenId"> {
    tokenId?: string;
    tokenID?: string;
}

interface TransactionRaw {
    txnHash: string;
    blockNumber: number;
    blockHash: string;
    chainId: number;
    metaTxnID?: string;
    transfers?: TransactionTransferRaw[];
    timestamp: string;
}

interface TransactionTransferRaw extends Omit<TransactionTransfer, "tokenIds" | "tokenMetadata"> {
    tokenIds?: string[];
    tokenIDs?: string[];
    tokenMetadata?: Record<string, TokenMetadataRaw>;
}

interface TokenBalancesFilter {
    accountAddresses: string[];
    contractStatus?: ContractVerificationStatus;
    contractTypes?: string[];
    contractWhitelist?: string[];
    contractBlacklist?: string[];
    omitNativeBalances: boolean;
    omitPrices?: boolean;
    tokenIDs?: string[];
}

interface GetTokenBalancesDetailsRequest {
    chainIds?: number[];
    networkType?: IndexerNetworkType;
    filter: TokenBalancesFilter;
    omitMetadata?: boolean;
    page?: TokenBalancesPage;
}

interface GetTokenBalancesDetailsResponse {
    page?: TokenBalancesPage;
    nativeBalances?: GatewayNativeTokenBalances[];
    balances?: GatewayTokenBalance[];
}

interface TransactionHistoryFilter {
    accountAddresses: string[];
    contractAddresses?: string[];
    transactionHashes?: string[];
    metaTransactionIDs?: string[];
    fromBlock?: number;
    toBlock?: number;
    tokenID?: string;
    omitPrices?: boolean;
}

interface GetTransactionHistoryRequest {
    chainIds?: number[];
    networkType?: IndexerNetworkType;
    filter: TransactionHistoryFilter;
    includeMetadata?: boolean;
    metadataOptions?: MetadataOptions;
    page?: TokenBalancesPage;
}

interface GetTransactionHistoryResponse {
    page?: TokenBalancesPage;
    transactions?: GatewayTransaction[];
}

// Matches the Swift `OMSWalletEnvironment` shape used by IndexerClient.
export interface OMSWalletEnvironment {
    indexerGatewayUrl: string;
}

export class IndexerClient {
    private readonly publishableKey: string;
    private readonly environment: OMSWalletEnvironment;
    private readonly client: HttpClient;

    constructor(params: {
        publishableKey: string,
        environment: OMSWalletEnvironment
    }) {
        this.publishableKey = params.publishableKey;
        this.environment = params.environment;
        this.client = new HttpClient();
    }

    async getBalances(params: GetBalancesParams): Promise<BalancesResult> {
        const request: GetTokenBalancesDetailsRequest = {
            ...this.chainScope(params),
            filter: {
                accountAddresses: [params.walletAddress],
                contractWhitelist: nonEmpty(params.contractAddresses),
                contractStatus: params.contractStatus,
                omitNativeBalances: false,
                omitPrices: params.omitPrices,
                tokenIDs: nonEmpty(params.tokenIds),
            },
            omitMetadata: params.includeMetadata === false,
            page: this.requestPage(params.page),
        };

        const response = await this.postJson<GetTokenBalancesDetailsResponse>(IndexerOperation.getBalances, {
            baseUrl: this.indexerGatewayUrl(),
            path: "/GetTokenBalancesDetails",
            body: JSON.stringify(request),
            headers: this.defaultHeaders(),
        });

        return {
            status: response.statusCode,
            page: response.payload.page,
            nativeBalances: flattenGatewayResults(response.payload.nativeBalances).map(mapNativeTokenBalance),
            balances: flattenGatewayResults(response.payload.balances).map(mapTokenBalance),
        };
    }

    async getTransactionHistory(params: GetTransactionHistoryParams): Promise<TransactionHistoryResult> {
        const request: GetTransactionHistoryRequest = {
            ...this.chainScope(params),
            filter: {
                accountAddresses: [params.walletAddress],
                contractAddresses: nonEmpty(params.contractAddresses),
                transactionHashes: nonEmpty(params.transactionHashes),
                metaTransactionIDs: nonEmpty(params.metaTransactionIds),
                fromBlock: params.fromBlock,
                toBlock: params.toBlock,
                tokenID: params.tokenId,
                omitPrices: params.omitPrices,
            },
            includeMetadata: params.includeMetadata ?? true,
            metadataOptions: params.metadataOptions,
            page: this.requestPage(params.page),
        };

        const response = await this.postJson<GetTransactionHistoryResponse>(IndexerOperation.getTransactionHistory, {
            baseUrl: this.indexerGatewayUrl(),
            path: "/GetTransactionHistory",
            body: JSON.stringify(request),
            headers: this.defaultHeaders(),
        });

        return {
            status: response.statusCode,
            page: response.payload.page,
            transactions: flattenGatewayResults(response.payload.transactions).map(mapTransaction),
        };
    }

    private async postJson<T>(
        operation: IndexerOperation,
        args: Parameters<HttpClient["postJson"]>[0],
    ): Promise<{statusCode: number, payload: T}> {
        let response;
        try {
            response = await this.client.postJson(args);
        } catch (error) {
            throw new OMSWalletRequestError({
                operation,
                retryable: true,
                upstreamError: indexerRequestFailure(error),
                cause: error,
                message: errorMessage(error),
            });
        }

        let payload: T;
        if (response.statusCode < 200 || response.statusCode >= 300) {
            const errorPayload = parseJsonOrText(response.body);
            const message = responseErrorMessage(errorPayload, operation, response.statusCode);
            throw new OMSWalletRequestError({
                code: "OMS_HTTP_ERROR",
                operation,
                status: response.statusCode,
                retryable: response.statusCode >= 500,
                upstreamError: indexerResponseError(errorPayload, response.statusCode, message),
                cause: errorPayload,
                message,
            });
        }

        try {
            payload = JSON.parse(response.body) as T;
        } catch (error) {
            const message = `Invalid JSON response from ${operation}`;
            throw new OMSWalletResponseError({
                operation,
                status: response.statusCode,
                upstreamError: {
                    service: "indexer",
                    status: response.statusCode,
                    message,
                },
                cause: error,
                message,
            });
        }

        return {statusCode: response.statusCode, payload};
    }

    private chainScope(params: {
        networks?: Network[]
        networkType?: IndexerNetworkType
    }): {chainIds?: number[], networkType?: IndexerNetworkType} {
        if (params.networks && params.networks.length > 0) {
            return {chainIds: params.networks.map(network => network.id)};
        }
        return {networkType: params.networkType ?? "MAINNETS"};
    }

    private requestPage(page: TokenBalancesPage | undefined): TokenBalancesPage {
        return {
            ...page,
            page: page?.page ?? 0,
            pageSize: page?.pageSize ?? 40,
        };
    }

    private indexerGatewayUrl(): string {
        return this.environment.indexerGatewayUrl;
    }

    private defaultHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            "Api-Key": this.publishableKey,
            Accept: "application/json",
            Webrpc: WebrpcHeaderValue,
        };

        return headers;
    }
}

function flattenGatewayResults<T>(groups: Array<{results?: T[]}> | undefined): T[] {
    return groups?.flatMap(group => group.results ?? []) ?? [];
}

function nonEmpty<T>(values: T[] | undefined): T[] | undefined {
    return values && values.length > 0 ? values : undefined;
}

function mapNativeTokenBalance(raw: NativeTokenBalanceRaw): TokenBalance {
    return {
        contractType: "NATIVE",
        contractAddress: undefined,
        accountAddress: raw.accountAddress,
        tokenId: undefined,
        name: raw.name,
        symbol: raw.symbol,
        balance: raw.balance,
        balanceUSD: raw.balanceUSD,
        priceUSD: raw.priceUSD,
        priceUpdatedAt: raw.priceUpdatedAt,
        blockHash: undefined,
        blockNumber: undefined,
        chainId: raw.chainId,
    };
}

/** Re-maps the wire key `tokenID` onto the camelCase `tokenId` field. */
function mapTokenBalance(raw: TokenBalanceRaw): TokenBalance {
    return {
        contractType: raw.contractType,
        contractAddress: raw.contractAddress,
        accountAddress: raw.accountAddress,
        tokenId: raw.tokenID,
        balance: raw.balance,
        balanceUSD: raw.balanceUSD,
        priceUSD: raw.priceUSD,
        priceUpdatedAt: raw.priceUpdatedAt,
        blockHash: raw.blockHash,
        blockNumber: raw.blockNumber,
        chainId: raw.chainId,
        uniqueCollectibles: raw.uniqueCollectibles,
        isSummary: raw.isSummary,
        contractInfo: raw.contractInfo,
        tokenMetadata: raw.tokenMetadata ? mapTokenMetadata(raw.tokenMetadata) : undefined,
    };
}

function mapTransaction(raw: TransactionRaw): Transaction {
    return {
        txnHash: raw.txnHash,
        blockNumber: raw.blockNumber,
        blockHash: raw.blockHash,
        chainId: raw.chainId,
        metaTxnId: raw.metaTxnID,
        transfers: raw.transfers?.map(mapTransactionTransfer),
        timestamp: raw.timestamp,
    };
}

function mapTransactionTransfer(raw: TransactionTransferRaw): TransactionTransfer {
    const {tokenIDs, tokenMetadata, ...transfer} = raw;
    return {
        ...transfer,
        tokenIds: raw.tokenIds ?? tokenIDs,
        tokenMetadata: tokenMetadata ? mapTokenMetadataRecord(tokenMetadata) : undefined,
    };
}

function mapTokenMetadataRecord(raw: Record<string, TokenMetadataRaw>): Record<string, TokenMetadata> {
    return Object.fromEntries(
        Object.entries(raw).map(([tokenId, metadata]) => [tokenId, mapTokenMetadata(metadata)]),
    );
}

function mapTokenMetadata(raw: TokenMetadataRaw): TokenMetadata {
    const {tokenID, assets, ...metadata} = raw;
    return {
        ...metadata,
        tokenId: raw.tokenId ?? tokenID,
        assets: assets?.map(asset => {
            const {tokenID: assetTokenID, ...metadataAsset} = asset;
            return {
                ...metadataAsset,
                tokenId: asset.tokenId ?? assetTokenID,
            };
        }),
    };
}

function responseErrorMessage(payload: unknown, operation: IndexerOperation, status: number): string {
    const message = gatewayErrorMessage(payload);
    if (message) {
        return message;
    }
    return `${operation} failed with HTTP ${status}`;
}

function parseJsonOrText(body: string): unknown {
    try {
        return JSON.parse(body);
    } catch {
        return body;
    }
}

function indexerRequestFailure(error: unknown): OMSWalletUpstreamError {
    const status = numberField(error, "status");
    return {
        service: "indexer",
        name: error instanceof Error ? error.name : stringField(error, "name"),
        code: numberOrStringField(error, "code"),
        message: errorMessage(error),
        status,
    };
}

function indexerResponseError(payload: unknown, status: number, fallbackMessage: string): OMSWalletUpstreamError {
    return {
        service: "indexer",
        name: stringField(payload, "name") ?? stringField(payload, "error"),
        code: numberOrStringField(payload, "code"),
        message: gatewayErrorMessage(payload) ?? fallbackMessage,
        status,
    };
}

function gatewayErrorMessage(payload: unknown): string | undefined {
    return stringField(payload, "message")
        ?? stringField(payload, "cause")
        ?? stringField(payload, "msg");
}

function stringField(source: unknown, key: string): string | undefined {
    const value = objectField(source, key);
    return typeof value === "string" ? value : undefined;
}

function numberField(source: unknown, key: string): number | undefined {
    const value = objectField(source, key);
    return typeof value === "number" ? value : undefined;
}

function numberOrStringField(source: unknown, key: string): number | string | undefined {
    const value = objectField(source, key);
    return typeof value === "number" || typeof value === "string" ? value : undefined;
}

function objectField(source: unknown, key: string): unknown {
    return source && typeof source === "object"
        ? (source as Record<string, unknown>)[key]
        : undefined;
}
