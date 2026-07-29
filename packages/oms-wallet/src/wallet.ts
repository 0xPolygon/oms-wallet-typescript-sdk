import type { Abi, Address, ContractFunctionName } from 'viem';

import type { Network } from './networks.js';
import type { CustomOidcProviderConfig, OmsRelayOidcProvider } from './oidc.js';
import type {
  AccessGrant,
  AccessGrantPage,
  ListAccessParams,
  WalletCredential
} from './types/accessGrant.js';
import type {
  FeeOptionSelector,
  SendContractTransactionParams,
  SendDataTransactionParams,
  SendNativeTransactionParams,
  SendTransactionParams,
  SendTransactionResponse,
  TransactionStatusPollingOptions
} from './types/transactionTypes.js';
import type {
  AbiArg,
  TransactionMode,
  TransactionStatusResponse,
  WalletType
} from './types/waas.js';

interface OidcRedirectAuthParamsBase {
  walletType?: WalletType;
  walletSelection?: WalletSelectionBehavior;
  sessionLifetimeSeconds?: number;
  loginHint?: string;
}

export type StartOidcRedirectAuthParams = OidcRedirectAuthParamsBase &
  (
    | { provider: OmsRelayOidcProvider; omsRelayReturnUri?: string; authorizeParams?: never }
    | {
        provider: CustomOidcProviderConfig;
        omsRelayReturnUri?: never;
        authorizeParams?: Record<string, string>;
      }
  );

export interface StartOidcRedirectAuthResult {
  authorizationUrl: string;
}

export interface CompleteOidcRedirectAuthParams {
  callbackUrl?: string;
  cleanUrl?: boolean;
  replaceUrl?: (url: string) => void;
  walletSelection?: WalletSelectionBehavior;
  sessionLifetimeSeconds?: number;
}

export interface StartEmailAuthParams {
  email: string;
  sessionLifetimeSeconds?: number;
}

export interface CompleteEmailAuthParams {
  code: string;
  walletType?: WalletType;
  walletSelection?: WalletSelectionBehavior;
}

export interface SignInWithOidcIdTokenParams {
  idToken: string;
  issuer: string;
  audience: string;
  walletType?: WalletType;
  walletSelection?: WalletSelectionBehavior;
  sessionLifetimeSeconds?: number;
  provider?: string;
  providerLabel?: string;
}

export type WalletSelectionBehavior = 'automatic' | 'manual';

export type AutomaticWalletSelectionParams<
  T extends { walletSelection?: WalletSelectionBehavior }
> = Omit<T, 'walletSelection'> & { walletSelection?: 'automatic' };
export type ManualWalletSelectionParams<T extends { walletSelection?: WalletSelectionBehavior }> =
  Omit<T, 'walletSelection'> & { walletSelection: 'manual' };

export interface WalletAccount {
  readonly id: string;
  readonly type: WalletType;
  readonly address: Address;
  readonly reference?: string;
}

export interface WalletActivationResult {
  readonly walletAddress: Address;
  readonly wallet: WalletAccount;
}

export interface CompleteWalletAuthResult {
  readonly walletAddress: Address;
  readonly wallet: WalletAccount;
  readonly wallets: ReadonlyArray<WalletAccount>;
  readonly credential: Readonly<WalletCredential>;
}

// Intentional named result types kept as interfaces for declaration-merging compatibility.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CompleteEmailAuthResult extends CompleteWalletAuthResult {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CompleteOidcIdTokenAuthResult extends CompleteWalletAuthResult {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CompleteOidcRedirectAuthResult extends CompleteWalletAuthResult {}

export interface PendingWalletSelection {
  readonly walletType: WalletType;
  readonly wallets: ReadonlyArray<WalletAccount>;
  readonly credential: Readonly<WalletCredential>;

  selectWallet(params: { walletId: string }): Promise<WalletActivationResult>;
  createAndSelectWallet(params?: { reference?: string }): Promise<WalletActivationResult>;
}

export interface OMSWalletEmailSessionAuth {
  readonly type: 'email';
  readonly email: string;
}

export type OMSWalletOidcSessionAuthFlow = 'redirect' | 'id-token';

export interface OMSWalletOidcSessionAuth {
  readonly type: 'oidc';
  readonly flow: OMSWalletOidcSessionAuthFlow;
  readonly issuer: string;
  readonly provider: string | undefined;
  readonly providerLabel: string | undefined;
  readonly email: string | undefined;
}

export type OMSWalletSessionAuth = OMSWalletEmailSessionAuth | OMSWalletOidcSessionAuth;

export interface OMSWalletSessionState {
  readonly walletAddress: Address | undefined;
  readonly expiresAt: string | undefined;
  readonly auth: OMSWalletSessionAuth | undefined;
}

export interface OMSWalletSessionExpiredEvent {
  readonly session: OMSWalletSessionState;
  readonly expiredAt: string;
}

export type OMSWalletSessionExpiredListener = (
  event: OMSWalletSessionExpiredEvent
) => void | Promise<void>;

export interface SignMessageParams {
  network: Network;
  message: string;
}

export interface SignTypedDataParams {
  network: Network;
  typedData: unknown;
}

export interface GetIdTokenParams {
  ttlSeconds?: number;
  customClaims?: Record<string, unknown>;
}

export interface IsValidMessageSignatureParams {
  network?: Network;
  walletAddress?: Address;
  walletId?: string;
  message: string;
  signature: string;
}

export interface IsValidTypedDataSignatureParams {
  network?: Network;
  walletAddress?: Address;
  walletId?: string;
  typedData: unknown;
  signature: string;
}

export type SignInWithOidcRedirectParams = OidcRedirectAuthParamsBase & {
  currentUrl?: string;
  assignUrl?: (url: string) => void;
} & (
    | { provider: OmsRelayOidcProvider; omsRelayReturnUri?: string; authorizeParams?: never }
    | {
        provider: CustomOidcProviderConfig;
        omsRelayReturnUri?: never;
        authorizeParams?: Record<string, string>;
      }
  );

export interface OMSWalletClient {
  readonly walletAddress: Address | undefined;
  readonly session: OMSWalletSessionState;

  onSessionExpired(listener: OMSWalletSessionExpiredListener): () => void;
  startEmailAuth(params: StartEmailAuthParams): Promise<void>;
  completeEmailAuth(
    params: ManualWalletSelectionParams<CompleteEmailAuthParams>
  ): Promise<PendingWalletSelection>;
  completeEmailAuth(
    params: AutomaticWalletSelectionParams<CompleteEmailAuthParams>
  ): Promise<CompleteEmailAuthResult>;
  completeEmailAuth(
    params: CompleteEmailAuthParams
  ): Promise<CompleteEmailAuthResult | PendingWalletSelection>;
  signInWithOidcIdToken(
    params: ManualWalletSelectionParams<SignInWithOidcIdTokenParams>
  ): Promise<PendingWalletSelection>;
  signInWithOidcIdToken(
    params: AutomaticWalletSelectionParams<SignInWithOidcIdTokenParams>
  ): Promise<CompleteOidcIdTokenAuthResult>;
  signInWithOidcIdToken(
    params: SignInWithOidcIdTokenParams
  ): Promise<CompleteOidcIdTokenAuthResult | PendingWalletSelection>;
  startOidcRedirectAuth(params: StartOidcRedirectAuthParams): Promise<StartOidcRedirectAuthResult>;
  completeOidcRedirectAuth(): Promise<
    CompleteOidcRedirectAuthResult | PendingWalletSelection | void
  >;
  completeOidcRedirectAuth(
    params: ManualWalletSelectionParams<CompleteOidcRedirectAuthParams>
  ): Promise<PendingWalletSelection | void>;
  completeOidcRedirectAuth(
    params: AutomaticWalletSelectionParams<CompleteOidcRedirectAuthParams>
  ): Promise<CompleteOidcRedirectAuthResult | void>;
  completeOidcRedirectAuth(
    params: CompleteOidcRedirectAuthParams
  ): Promise<CompleteOidcRedirectAuthResult | PendingWalletSelection | void>;
  signInWithOidcRedirect(params: SignInWithOidcRedirectParams): Promise<void>;
  signOut(): Promise<void>;
  listWallets(): Promise<Array<WalletAccount>>;
  useWallet(params: { walletId: string }): Promise<WalletActivationResult>;
  createWallet(params?: { type?: WalletType; reference?: string }): Promise<WalletActivationResult>;
  getIdToken(params?: GetIdTokenParams): Promise<string>;
  signMessage(params: SignMessageParams): Promise<string>;
  signTypedData(params: SignTypedDataParams): Promise<string>;
  isValidMessageSignature(params: IsValidMessageSignatureParams): Promise<boolean>;
  isValidTypedDataSignature(params: IsValidTypedDataSignatureParams): Promise<boolean>;
  sendTransaction(params: SendNativeTransactionParams): Promise<SendTransactionResponse>;
  sendTransaction(params: SendDataTransactionParams): Promise<SendTransactionResponse>;
  sendTransaction<
    const abi extends Abi | readonly unknown[],
    functionName extends ContractFunctionName<abi> | undefined = ContractFunctionName<abi>
  >(
    params: SendContractTransactionParams<abi, functionName>
  ): Promise<SendTransactionResponse>;
  sendTransaction(params: SendTransactionParams): Promise<SendTransactionResponse>;
  callContract(params: {
    network: Network;
    contractAddress: Address;
    method: string;
    args?: Array<AbiArg>;
    mode?: TransactionMode;
    selectFeeOption?: FeeOptionSelector;
    waitForStatus?: boolean;
    statusPolling?: TransactionStatusPollingOptions;
  }): Promise<SendTransactionResponse>;
  getTransactionStatus(params: { txnId: string }): Promise<TransactionStatusResponse>;
  listAccess(params?: ListAccessParams): Promise<AccessGrant[]>;
  listAccessPages(params?: ListAccessParams): AsyncIterable<AccessGrantPage>;
  revokeAccess(params: { targetCredentialId: string }): Promise<void>;
}
