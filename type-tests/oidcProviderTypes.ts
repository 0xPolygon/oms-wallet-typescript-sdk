import {
    AuthMode,
    Networks,
    OMSWallet,
    appleOidcProvider,
    defineOMSWalletAuthConfig,
    findNetworkById,
    findNetworkByName,
    googleOidcProvider,
    supportedNetworks,
    type CompleteOidcIdTokenAuthResult,
    type Network,
    type GetIdTokenParams,
    type OMSWalletSessionAuth,
    type OMSWalletSessionExpiredListener,
    type OMSWalletSessionState,
    type OMSWalletError,
    type OMSWalletErrorCode,
    type OMSWalletUpstreamError,
    type BalancesResult,
    type AbiArg,
    type DefaultOMSWalletEnvironment,
    type GetBalancesParams,
    type GetTransactionHistoryParams,
    type IndexerNetworkType,
    type OMSWalletAuthConfig,
    type OMSWalletEnvironment,
    type OMSWalletParams,
    type OidcAuthMode,
    type OidcProviderConfig,
    type SendDataTransactionParams,
    type SendNativeTransactionParams,
    type SendTransactionBase,
    type SendTransactionParams,
    type SendContractTransactionParams,
    type TokenBalance,
    type TokenBalancesPage,
    type TokenContractInfo,
    type TokenMetadata,
    type TransactionHistoryResult,
    type SignInWithOidcIdTokenParams,
    type OidcProviderName,
} from "../src/index";

const auth = defineOMSWalletAuthConfig({
    oidcProviders: {
        google: googleOidcProvider(),
        apple: appleOidcProvider({authMode: AuthMode.AuthCode}),
    },
});
const configuredOmsWallet = new OMSWallet({
    publishableKey: "pk_dev_sdbx_project_key",
    auth,
});

type ConfiguredEnvironment = typeof configuredOmsWallet extends OMSWallet<infer Env> ? Env : never;
type ProviderName = OidcProviderName<ConfiguredEnvironment>;

const configuredProvider: ProviderName = "google";
void configuredProvider;
const configuredAppleProvider: ProviderName = "apple";
void configuredAppleProvider;

// @ts-expect-error github is not configured in this static environment.
const unknownProvider: ProviderName = "github";
void unknownProvider;

const customOidcProvider: OidcProviderConfig = {
    clientId: "custom-client",
    issuer: "https://issuer.example",
    authorizationUrl: "https://issuer.example/oauth/authorize",
    providerRedirectUri: "https://app.example/auth/callback",
};
void customOidcProvider;

// @ts-expect-error custom OIDC redirect providers require providerRedirectUri.
const customOidcProviderWithoutRedirectUri: OidcProviderConfig = {
    clientId: "custom-client",
    issuer: "https://issuer.example",
    authorizationUrl: "https://issuer.example/oauth/authorize",
};
void customOidcProviderWithoutRedirectUri;

void googleOidcProvider({
    // @ts-expect-error SDK default Google helper uses the OMS relay and does not accept providerRedirectUri.
    providerRedirectUri: "https://app.example/auth/callback",
});
void appleOidcProvider({
    // @ts-expect-error SDK default Apple helper uses the OMS relay and does not accept providerRedirectUri.
    providerRedirectUri: "https://app.example/auth/callback",
});

if (false) {
    const wallet = configuredOmsWallet.wallet;
    void wallet.startOidcRedirectAuth({
        provider: "google",
        omsRelayReturnUri: "https://app.example/auth/callback",
    });
    void wallet.startOidcRedirectAuth({
        provider: "apple",
        omsRelayReturnUri: "https://app.example/auth/callback",
    });

    void wallet.startOidcRedirectAuth({
        // @ts-expect-error github is not configured in this static environment.
        provider: "github",
        omsRelayReturnUri: "https://app.example/auth/callback",
    });

    void (async () => {
        const manualAuth = await wallet.completeEmailAuth({code: "123456", walletSelection: "manual"});
        void manualAuth.walletType;
        void manualAuth.wallets;
        void manualAuth.selectWallet({walletId: manualAuth.wallets[0].id});
        void manualAuth.createAndSelectWallet({reference: "main"});
        // @ts-expect-error manual auth wallet lists are readonly snapshots.
        manualAuth.wallets.push(manualAuth.wallets[0]);
        // @ts-expect-error manual auth wallet metadata is readonly.
        manualAuth.wallets[0].id = "wallet-id";
        // @ts-expect-error manual auth credential metadata is readonly.
        manualAuth.credential.expiresAt = "2099-01-01T00:00:00Z";
        // @ts-expect-error manual auth does not activate a wallet.
        void manualAuth.walletAddress;

        const activatedAuth = await wallet.completeEmailAuth({code: "123456"});
        void activatedAuth.walletAddress;
        void activatedAuth.wallets;
        // @ts-expect-error completed auth wallet lists are readonly snapshots.
        activatedAuth.wallets.push(activatedAuth.wallet);
        // @ts-expect-error completed auth wallet metadata is readonly.
        activatedAuth.wallet.id = "wallet-id";
        // @ts-expect-error completed auth credential metadata is readonly.
        activatedAuth.credential.expiresAt = "2099-01-01T00:00:00Z";

        const manualOidcIdTokenAuth = await wallet.signInWithOidcIdToken({
            idToken: "jwt",
            issuer: "https://accounts.google.com",
            audience: "google-client-id",
            walletSelection: "manual",
        });
        void manualOidcIdTokenAuth.walletType;
        // @ts-expect-error manual ID-token auth does not activate a wallet.
        void manualOidcIdTokenAuth.walletAddress;

        const activatedOidcIdTokenAuth = await wallet.signInWithOidcIdToken({
            idToken: "jwt",
            issuer: "https://accounts.google.com",
            audience: "google-client-id",
        });
        void activatedOidcIdTokenAuth.walletAddress;
    });
}

const defaultClient = new OMSWallet({
    publishableKey: "pk_dev_sdbx_project_key",
});
// @ts-expect-error publishableKey is required.
new OMSWallet({});
// @ts-expect-error projectId is not a constructor parameter.
new OMSWallet({publishableKey: "pk_dev_sdbx_project_key", projectId: "project-id"});
// @ts-expect-error projectAccessKey initializer name is not supported.
new OMSWallet({projectAccessKey: "pk_dev_sdbx_project_key"});
// @ts-expect-error publicApiKey initializer name is not supported.
new OMSWallet({publicApiKey: "pk_dev_sdbx_project_key"});
// @ts-expect-error authorizationScope initializer name is not supported.
new OMSWallet({publishableKey: "pk_dev_sdbx_project_key", authorizationScope: "project-id"});
new OMSWallet({
    publishableKey: "pk_dev_sdbx_project_key",
    // @ts-expect-error session expiry is subscribed through wallet.onSessionExpired, not constructor params.
    onSessionExpired: () => {},
});
const session: OMSWalletSessionState = defaultClient.wallet.session;
// @ts-expect-error sessions are owned by the wallet sub-client.
void defaultClient.session;
const defaultEnvironmentTypedClient: OMSWallet<DefaultOMSWalletEnvironment> = defaultClient;
void defaultEnvironmentTypedClient;
const omsWalletParams: OMSWalletParams = {publishableKey: "pk_dev_sdbx_project_key"};
void omsWalletParams;
const envConfig: OMSWalletEnvironment = {
    walletApiUrl: "https://wallet.example",
    indexerGatewayUrl: "https://indexer.example",
};
void envConfig;
const oidcAuthMode: OidcAuthMode = AuthMode.AuthCodePKCE;
void oidcAuthMode;
const unsubscribeSessionExpired: () => void = defaultClient.wallet.onSessionExpired(({session}) => {
    void session.auth?.email;
    // @ts-expect-error expired session snapshots are readonly.
    session.auth = undefined;
});
const sessionExpiredListener: OMSWalletSessionExpiredListener = ({expiredAt}) => {
    void expiredAt;
};
void defaultClient.wallet.onSessionExpired(sessionExpiredListener);
// @ts-expect-error walletAddress is readonly SDK state.
defaultClient.wallet.walletAddress = "0x9999999999999999999999999999999999999999";
const idTokenParams: GetIdTokenParams = {ttlSeconds: 300, customClaims: {role: "admin"}};
const idToken: Promise<string> = defaultClient.wallet.getIdToken(idTokenParams);
const oidcIdTokenParams: SignInWithOidcIdTokenParams = {
    idToken: "jwt",
    issuer: "https://accounts.google.com",
    audience: "google-client-id",
    provider: "google",
    providerLabel: "Google",
};
const oidcIdTokenResult: Promise<CompleteOidcIdTokenAuthResult> =
    defaultClient.wallet.signInWithOidcIdToken({
        idToken: "jwt",
        issuer: "https://accounts.google.com",
        audience: "google-client-id",
    });
void defaultClient.wallet.signInWithOidcIdToken(oidcIdTokenParams);
const sessionAuth: OMSWalletSessionAuth | undefined = defaultClient.wallet.session.auth;
// @ts-expect-error session snapshots are readonly.
session.auth = undefined;
if (session.auth) {
    // @ts-expect-error session auth metadata is readonly.
    session.auth.email = "mutated@example.com";
}
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
const upstreamError: OMSWalletUpstreamError = {
    service: "waas",
    name: "CommitmentConsumed",
    code: 7008,
    message: "The authentication commitment has already been used",
    status: 400,
};
const sdkError = undefined as unknown as OMSWalletError;
const maybeUpstreamError: OMSWalletUpstreamError | undefined = sdkError.upstreamError;
const transactionExecutionCode: OMSWalletErrorCode = "OMS_TRANSACTION_EXECUTION_UNCONFIRMED";
const storageCode: OMSWalletErrorCode = "OMS_STORAGE_ERROR";
void session;
void unsubscribeSessionExpired;
void sessionAuth;
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
void storageCode;
// @ts-expect-error network helpers are package exports, not OMSWallet properties.
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
    omsRelayReturnUri: "https://app.example/auth/callback",
});
void (async () => {
    const redirectStart = await defaultClient.wallet.startOidcRedirectAuth({
        provider: "google",
        omsRelayReturnUri: "https://app.example/auth/callback",
    });
    const authorizationUrl: string = redirectStart.authorizationUrl;
    void authorizationUrl;
    // @ts-expect-error redirect start result uses authorizationUrl, not url.
    void redirectStart.url;
});
void defaultClient.wallet.startOidcRedirectAuth({
    provider: "google",
});
void defaultClient.wallet.startOidcRedirectAuth({
    provider: "apple",
    omsRelayReturnUri: "https://app.example/auth/callback",
});
void defaultClient.wallet.startOidcRedirectAuth({
    provider: "google",
    // @ts-expect-error redirectUri was replaced by omsRelayReturnUri for SDK relayed providers.
    redirectUri: "https://app.example/auth/callback",
});
void defaultClient.wallet.startOidcRedirectAuth({
    provider: "google",
    // @ts-expect-error relayRedirectUri was replaced by providerRedirectUri on provider config.
    relayRedirectUri: "https://relay.example/callback",
});
void defaultClient.wallet.completeOidcRedirectAuth();
void defaultClient.wallet.completeOidcRedirectAuth({
    walletSelection: "manual",
    sessionLifetimeSeconds: 120,
});
void defaultClient.wallet.signInWithOidcIdToken({
    idToken: "jwt",
    issuer: "https://accounts.google.com",
    audience: "google-client-id",
});
void defaultClient.wallet.signInWithOidcIdToken({
    idToken: "jwt",
    issuer: "https://idp.example",
    audience: "custom-client-id",
    provider: "enterprise",
    providerLabel: "Enterprise SSO",
    walletSelection: "manual",
    sessionLifetimeSeconds: 120,
});
// @ts-expect-error ID-token sign-in requires an ID token.
void defaultClient.wallet.signInWithOidcIdToken({
    issuer: "https://accounts.google.com",
    audience: "google-client-id",
});
// @ts-expect-error ID-token sign-in requires an issuer.
void defaultClient.wallet.signInWithOidcIdToken({
    idToken: "jwt",
    audience: "google-client-id",
});
// @ts-expect-error ID-token sign-in requires an audience.
void defaultClient.wallet.signInWithOidcIdToken({
    idToken: "jwt",
    issuer: "https://accounts.google.com",
});
void defaultClient.wallet.startOidcRedirectAuth({
    // @ts-expect-error github is not configured on the default auth config.
    provider: "github",
    omsRelayReturnUri: "https://app.example/auth/callback",
});
void defaultClient.wallet.signInWithOidcRedirect({
    provider: "google",
});
void defaultClient.wallet.signInWithOidcRedirect({
    provider: "apple",
});
void defaultClient.wallet.signInWithOidcRedirect({
    provider: "google",
    walletSelection: "manual",
    sessionLifetimeSeconds: 120,
});
// @ts-expect-error provider is required when starting redirect sign-in.
void defaultClient.wallet.signInWithOidcRedirect();
// @ts-expect-error provider is required when starting redirect with an omsRelayReturnUri override.
void defaultClient.wallet.signInWithOidcRedirect({
    omsRelayReturnUri: "https://app.example/auth/callback",
});
// @ts-expect-error provider is required when starting redirect with assignUrl.
void defaultClient.wallet.signInWithOidcRedirect({
    currentUrl: "https://app.example/login",
    assignUrl: (url: string) => { void url; },
});

const customClient = new OMSWallet({
    publishableKey: "pk_dev_sdbx_project_key",
    auth,
});
let broadlyTypedClient: OMSWallet;
broadlyTypedClient = customClient;
void broadlyTypedClient;
void customClient.wallet.startOidcRedirectAuth({
    provider: "google",
    omsRelayReturnUri: "https://app.example/auth/callback",
});
void customClient.wallet.startOidcRedirectAuth({
    provider: "apple",
    omsRelayReturnUri: "https://app.example/auth/callback",
});

const noProviderClient = new OMSWallet({
    publishableKey: "pk_dev_sdbx_project_key",
    auth: {},
});
void noProviderClient.wallet.startOidcRedirectAuth({
    // @ts-expect-error string provider names are not available without configured providers.
    provider: "google",
    omsRelayReturnUri: "https://app.example/auth/callback",
});

const abiArg: AbiArg = {type: "uint256", value: "1"};
void abiArg;
const sendBase: SendTransactionBase = {
    network: Networks.polygon,
    to: "0x1111111111111111111111111111111111111111",
};
void sendBase;
const nativeSend: SendNativeTransactionParams = {
    network: Networks.polygon,
    to: "0x1111111111111111111111111111111111111111",
    value: 1n,
};
const dataSend: SendDataTransactionParams = {
    network: Networks.polygon,
    to: "0x1111111111111111111111111111111111111111",
    data: "0x",
};
const contractSend: SendContractTransactionParams = {
    network: Networks.polygon,
    to: "0x1111111111111111111111111111111111111111",
    abi: [],
    functionName: undefined,
};
const generalSend: SendTransactionParams = nativeSend;
void nativeSend;
void dataSend;
void contractSend;
void generalSend;
new OMSWallet({
    publishableKey: "pk_dev_sdbx_project_key",
    // @ts-expect-error environment URL overrides are not constructor parameters.
    environment,
});

function createClient(params: {
    publishableKey: string;
    auth?: OMSWalletAuthConfig;
}) {
    return new OMSWallet(params);
}

void createClient({
    publishableKey: "pk_dev_sdbx_project_key",
});
void createClient({
    publishableKey: "pk_dev_sdbx_project_key",
    auth,
});
