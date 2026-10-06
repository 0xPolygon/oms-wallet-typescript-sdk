import type { Abi, Address, ContractFunctionName } from 'viem';

import type { Network } from './networks.js';
import type { CustomOidcProviderConfig, OmsRelayOidcProvider } from './oidc.js';
import type {
  AccessGrant,
  AccessGrantPage,
  AuthorizeRemoteAccessParams,
  AuthorizedRemoteAccess,
  ListAccessParams,
  RemoteAccessSession,
  RemoteCredentialMetadata,
  RevokeAccessParams,
  SmartSessionGrantUsage,
  WalletCredential
} from './types/accessGrant.js';
import type {
  FeeOptionSelector,
  SendContractTransactionParams,
  SendDataTransactionParams,
  SendNativeTransactionParams,
  SendSolanaTransferParams,
  SendTransactionParams,
  SendTronTransactionParams,
  CallTronContractParams,
  SendTransactionResponse,
  TransactionStatusPollingOptions
} from './types/transactionTypes.js';
import type {
  AbiArg,
  TransactionMode,
  TransactionStatusResponse,
  WalletImportCipherSuite,
  WalletKeyOrigin,
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

export interface EthereumWalletAccount {
  readonly id: string;
  readonly type: 'ethereum';
  readonly address: Address;
  readonly reference?: string;
  readonly keyOrigin: WalletKeyOrigin;
}

export interface SolanaWalletAccount {
  readonly id: string;
  readonly type: 'solana';
  readonly address: string;
  readonly reference?: string;
  readonly keyOrigin: WalletKeyOrigin;
}

export interface TronWalletAccount {
  readonly id: string;
  readonly type: 'tron';
  /** Base58Check address (`T…`). */
  readonly address: string;
  readonly reference?: string;
  readonly keyOrigin: WalletKeyOrigin;
}

export type WalletAccount = EthereumWalletAccount | SolanaWalletAccount | TronWalletAccount;

export interface WalletActivationResult {
  readonly wallet: WalletAccount;
}

export type ImportWalletParams =
  | {
      type: 'ethereum';
      privateKey: string | Uint8Array;
      reference?: string;
    }
  | {
      type: 'solana';
      privateKey: string | Uint8Array;
      reference?: string;
    }
  | {
      type: 'tron';
      /** A secp256k1 private key: 32 raw bytes or 64 hex characters (optionally `0x`-prefixed). */
      privateKey: string | Uint8Array;
      reference?: string;
    };

export interface WalletImportRecipientKey {
  readonly keyId: string;
  readonly cipherSuite: WalletImportCipherSuite;
  readonly publicKey: string;
}

export interface EncryptedWalletImportKeyMaterial {
  readonly keyId: string;
  readonly cipherSuite: WalletImportCipherSuite;
  readonly encapsulatedKey: string;
  readonly ciphertext: string;
}

export interface ImportEncryptedWalletParams {
  type: WalletType;
  keyMaterial: EncryptedWalletImportKeyMaterial;
  reference?: string;
}

export interface CompleteWalletAuthResult {
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

export interface OMSWalletSession {
  readonly expiresAt: string;
  readonly auth: OMSWalletSessionAuth;
}

export interface OMSWalletSessionExpiredEvent {
  /**
   * The wallet that was active when the session expired. `undefined` when the credential expired
   * while a manual wallet selection was still pending.
   */
  readonly wallet: WalletAccount | undefined;
  readonly session: OMSWalletSession;
  readonly expiredAt: string;
}

export type OMSWalletSessionExpiredListener = (
  event: OMSWalletSessionExpiredEvent
) => void | Promise<void>;

export interface SignMessageParams {
  network: Network;
  message: string;
}

export interface SignSolanaMessageParams {
  message: string;
}

export interface SignTypedDataParams {
  network: Network;
  typedData: unknown;
}

export interface SignTronMessageParams {
  message: string;
}

export interface SignTronTypedDataParams {
  /** TIP-712 typed data. Address values may be Base58Check (`T…`). */
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

export interface IsValidSolanaMessageSignatureParams {
  walletAddress?: string;
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

export interface IsValidTronMessageSignatureParams {
  /** Base58Check address (`T…`). */
  walletAddress?: string;
  walletId?: string;
  message: string;
  signature: string;
}

export interface IsValidTronTypedDataSignatureParams {
  /** Base58Check address (`T…`). */
  walletAddress?: string;
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
  /** The active wallet, or `undefined` when signed out. Same shape as `listWallets()` entries. */
  readonly activeWallet: WalletAccount | undefined;
  /** Expiry and auth metadata for the active session; defined exactly when `activeWallet` is. */
  readonly session: OMSWalletSession | undefined;

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
  importWallet(params: ImportWalletParams): Promise<WalletActivationResult>;
  getWalletImportRecipientKey(params: {
    cipherSuite: WalletImportCipherSuite;
  }): Promise<WalletImportRecipientKey>;
  importEncryptedWallet(params: ImportEncryptedWalletParams): Promise<WalletActivationResult>;
  getIdToken(params?: GetIdTokenParams): Promise<string>;
  signMessage(params: SignMessageParams): Promise<string>;
  signSolanaMessage(params: SignSolanaMessageParams): Promise<string>;
  signTypedData(params: SignTypedDataParams): Promise<string>;
  isValidMessageSignature(params: IsValidMessageSignatureParams): Promise<boolean>;
  isValidSolanaMessageSignature(params: IsValidSolanaMessageSignatureParams): Promise<boolean>;
  isValidTypedDataSignature(params: IsValidTypedDataSignatureParams): Promise<boolean>;
  signTronMessage(params: SignTronMessageParams): Promise<string>;
  signTronTypedData(params: SignTronTypedDataParams): Promise<string>;
  isValidTronMessageSignature(params: IsValidTronMessageSignatureParams): Promise<boolean>;
  isValidTronTypedDataSignature(params: IsValidTronTypedDataSignatureParams): Promise<boolean>;
  sendTransaction(params: SendNativeTransactionParams): Promise<SendTransactionResponse>;
  sendTransaction(params: SendDataTransactionParams): Promise<SendTransactionResponse>;
  sendTransaction<
    const abi extends Abi | readonly unknown[],
    functionName extends ContractFunctionName<abi> | undefined = ContractFunctionName<abi>
  >(
    params: SendContractTransactionParams<abi, functionName>
  ): Promise<SendTransactionResponse>;
  sendTransaction(params: SendTransactionParams): Promise<SendTransactionResponse>;
  sendSolanaTransfer(params: SendSolanaTransferParams): Promise<SendTransactionResponse>;
  sendTronTransaction(params: SendTronTransactionParams): Promise<SendTransactionResponse>;
  callTronContract(params: CallTronContractParams): Promise<SendTransactionResponse>;
  callContract(params: {
    network: Network;
    contractAddress: Address;
    /** Function name only, e.g. `'transfer'`. The signature is built from the `args` types. */
    method: string;
    args?: Array<AbiArg>;
    mode?: TransactionMode;
    selectFeeOption?: FeeOptionSelector;
    waitForStatus?: boolean;
    statusPolling?: TransactionStatusPollingOptions;
  }): Promise<SendTransactionResponse>;
  getTransactionStatus(params: { txnId: string }): Promise<TransactionStatusResponse>;
  inspectRemoteCredential(params: { credentialId: string }): Promise<RemoteCredentialMetadata>;
  authorizeRemoteAccess(params: AuthorizeRemoteAccessParams): Promise<AuthorizedRemoteAccess>;
  listAccess(params?: ListAccessParams): Promise<AccessGrant[]>;
  listAccessPages(params?: ListAccessParams): AsyncIterable<AccessGrantPage>;
  getRemoteAccessSession(params: { sessionId: string }): Promise<RemoteAccessSession>;
  getRemoteAccessSessionUsage(params: {
    sessionId: string;
    network: Network;
  }): Promise<SmartSessionGrantUsage[]>;
  revokeAccess(params: RevokeAccessParams): Promise<void>;
}
