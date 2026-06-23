import {WalletClient, type OidcProviderName} from "../src/clients/walletClient";
import {
    Networks,
    OMSClient,
    defineOmsAuthConfig,
    findNetworkById,
    findNetworkByName,
    supportedNetworks,
    type Network,
    type GetIdTokenParams,
    type OMSClientSessionLoginType,
    type OMSClientSessionExpiredListener,
    type OMSClientSessionState,
    type OmsSdkError,
    type OmsSdkErrorCode,
    type OmsUpstreamError,
    type BalancesResult,
    type GetBalancesParams,
    type GetTransactionHistoryParams,
    type IndexerNetworkType,
    type OmsAuthConfig,
    type TokenBalance,
    type TokenBalancesPage,
    type TokenContractInfo,
    type TokenMetadata,
    type TransactionHistoryResult,
} from "../src/index";
import {omsEnvironmentFromPublishableKey} from "../src/omsEnvironment";
import {googleOidcProvider} from "../src/oidc";

const auth = defineOmsAuthConfig({
    oidcProviders: {
        google: googleOidcProvider(),
    },
});
const environment = omsEnvironmentFromPublishableKey("pk_dev_sdbx_project_key", auth);

type ProviderName = OidcProviderName<typeof environment>;

const configuredProvider: ProviderName = "google";
void configuredProvider;

// @ts-expect-error github is not configured in this static environment.
const unknownProvider: ProviderName = "github";
void unknownProvider;

if (false) {
    const wallet = undefined as unknown as WalletClient<typeof environment>;
    void wallet.startOidcRedirectAuth({
        provider: "google",
        redirectUri: "https://app.example/auth/callback",
    });

    void wallet.startOidcRedirectAuth({
        // @ts-expect-error github is not configured in this static environment.
        provider: "github",
        redirectUri: "https://app.example/auth/callback",
    });

    void (async () => {
        const manualAuth = await wallet.completeEmailAuth({code: "123456", walletSelection: "manual"});
        void manualAuth.walletType;
        void manualAuth.wallets;
        void manualAuth.selectWallet({walletId: manualAuth.wallets[0].id});
        void manualAuth.createAndSelectWallet({reference: "main"});
        // @ts-expect-error manual auth does not activate a wallet.
        void manualAuth.walletAddress;

        const activatedAuth = await wallet.completeEmailAuth({code: "123456"});
        void activatedAuth.walletAddress;
        void activatedAuth.wallets;
    });
}

const defaultClient = new OMSClient({
    publishableKey: "pk_dev_sdbx_project_key",
});
// @ts-expect-error publishableKey is required.
new OMSClient({});
// @ts-expect-error projectId is not a constructor parameter.
new OMSClient({publishableKey: "pk_dev_sdbx_project_key", projectId: "project-id"});
// @ts-expect-error projectAccessKey initializer name is not supported.
new OMSClient({projectAccessKey: "pk_dev_sdbx_project_key"});
// @ts-expect-error publicApiKey initializer name is not supported.
new OMSClient({publicApiKey: "pk_dev_sdbx_project_key"});
// @ts-expect-error authorizationScope initializer name is not supported.
new OMSClient({publishableKey: "pk_dev_sdbx_project_key", authorizationScope: "project-id"});
new OMSClient({
    publishableKey: "pk_dev_sdbx_project_key",
    // @ts-expect-error session expiry is subscribed through wallet.onSessionExpired, not constructor params.
    onSessionExpired: () => {},
});
const session: OMSClientSessionState = defaultClient.wallet.session;
const unsubscribeSessionExpired: () => void = defaultClient.wallet.onSessionExpired(({session}) => {
    void session.sessionEmail;
});
const sessionExpiredListener: OMSClientSessionExpiredListener = ({expiredAt}) => {
    void expiredAt;
};
void defaultClient.wallet.onSessionExpired(sessionExpiredListener);
const idTokenParams: GetIdTokenParams = {ttlSeconds: 300, customClaims: {role: "admin"}};
const idToken: Promise<string> = defaultClient.wallet.getIdToken(idTokenParams);
const loginType: OMSClientSessionLoginType | undefined = defaultClient.wallet.session.loginType;
const polygonNetwork: Network = Networks.polygon;
const polygonDisplayName: string = Networks.polygon.displayName;
const amoyNetwork: Network | undefined = findNetworkById(80002);
const baseNetwork: Network | undefined = findNetworkByName("base");
const allNetworks: readonly Network[] = supportedNetworks;
const tokenContractInfo: TokenContractInfo = {symbol: "USDC", decimals: 6};
const tokenMetadata: TokenMetadata = {tokenId: "0", name: "USDC"};
const tokenBalance: TokenBalance = {
    chainId: Networks.polygon.id,
    contractInfo: tokenContractInfo,
    tokenMetadata,
    balanceUSD: "0.141799",
    priceUSD: "1",
};
const tokenBalancesPage: TokenBalancesPage = {page: 0, pageSize: 40, more: false};
const tokenBalancesResult: BalancesResult = {
    status: 200,
    page: tokenBalancesPage,
    nativeBalances: [tokenBalance],
    balances: [tokenBalance],
};
const indexerNetworkType: IndexerNetworkType = "MAINNETS";
const transactionHistoryResult: TransactionHistoryResult = {status: 200, page: tokenBalancesPage, transactions: []};
const upstreamError: OmsUpstreamError = {
    service: "waas",
    name: "CommitmentConsumed",
    code: 7008,
    message: "The authentication commitment has already been used",
    status: 400,
};
const sdkError = undefined as unknown as OmsSdkError;
const maybeUpstreamError: OmsUpstreamError | undefined = sdkError.upstreamError;
const transactionExecutionCode: OmsSdkErrorCode = "OMS_TRANSACTION_EXECUTION_UNCONFIRMED";
void session;
void unsubscribeSessionExpired;
void loginType;
void polygonNetwork;
void amoyNetwork;
void baseNetwork;
void allNetworks;
void tokenContractInfo;
void tokenMetadata;
void tokenBalancesResult;
void indexerNetworkType;
void transactionHistoryResult;
void upstreamError;
void maybeUpstreamError;
void transactionExecutionCode;
void defaultClient.supportedNetworks;
// @ts-expect-error findNetworkById accepts numeric chain IDs only.
findNetworkById("80002");
void defaultClient.indexer.getBalances({
    networks: [Networks.polygon],
    contractAddresses: ["0x2222222222222222222222222222222222222222"],
    walletAddress: "0x9999999999999999999999999999999999999999",
    includeMetadata: false,
});
void defaultClient.indexer.getBalances({
    networks: [Networks.polygon],
    walletAddress: "0x9999999999999999999999999999999999999999",
    includeMetadata: true,
    page: {page: 1, pageSize: 25},
});
void defaultClient.indexer.getBalances({
    // @ts-expect-error Indexer public methods accept Network objects, not numeric chain IDs.
    networks: [137],
    contractAddresses: ["0x2222222222222222222222222222222222222222"],
    walletAddress: "0x9999999999999999999999999999999999999999",
    includeMetadata: false,
});
void defaultClient.indexer.getBalances({
    // @ts-expect-error chainId is not a public indexer parameter.
    chainId: 137,
    contractAddresses: ["0x2222222222222222222222222222222222222222"],
    walletAddress: "0x9999999999999999999999999999999999999999",
    includeMetadata: false,
});
const getBalancesParams: GetBalancesParams = {
    walletAddress: "0x9999999999999999999999999999999999999999",
    networkType: "TESTNETS",
};
void defaultClient.indexer.getBalances(getBalancesParams);
const transactionHistoryParams: GetTransactionHistoryParams = {
    walletAddress: "0x9999999999999999999999999999999999999999",
    networks: [Networks.polygon],
    includeMetadata: true,
};
void defaultClient.indexer.getTransactionHistory(transactionHistoryParams);
void defaultClient.wallet.startOidcRedirectAuth({
    provider: "google",
    redirectUri: "https://app.example/auth/callback",
});
void defaultClient.wallet.startOidcRedirectAuth({
    // @ts-expect-error github is not configured on the default auth config.
    provider: "github",
    redirectUri: "https://app.example/auth/callback",
});

const customClient = new OMSClient({
    publishableKey: "pk_dev_sdbx_project_key",
    auth,
});
let broadlyTypedClient: OMSClient;
broadlyTypedClient = customClient;
void broadlyTypedClient;
void customClient.wallet.startOidcRedirectAuth({
    provider: "google",
    redirectUri: "https://app.example/auth/callback",
});

const noProviderClient = new OMSClient({
    publishableKey: "pk_dev_sdbx_project_key",
    auth: {},
});
void noProviderClient.wallet.startOidcRedirectAuth({
    // @ts-expect-error string provider names are not available without configured providers.
    provider: "google",
    redirectUri: "https://app.example/auth/callback",
});
new OMSClient({
    publishableKey: "pk_dev_sdbx_project_key",
    // @ts-expect-error environment URL overrides are not constructor parameters.
    environment,
});

function createClient(params: {
    publishableKey: string;
    auth?: OmsAuthConfig;
}) {
    return new OMSClient(params);
}

void createClient({
    publishableKey: "pk_dev_sdbx_project_key",
});
void createClient({
    publishableKey: "pk_dev_sdbx_project_key",
    auth,
});
