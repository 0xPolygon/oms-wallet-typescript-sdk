import type { Abi, Address, ContractFunctionName } from 'viem';

import type { Network } from './networks.js';
import type { CustomOidcProviderConfig, OmsRelayOidcProvider } from './oidc.js';
import type {
  AccessGrant,
  AccessGrantPage,
  AuthorizeRemoteAccessParams,
  AuthorizedRemoteAccess,
  ListAccessPageParams,
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
  walletType: WalletType;
  keyMaterial: EncryptedWalletImportKeyMaterial;
  reference?: string;
}

export interface CompleteWalletAuthResult {
  readonly wallet: WalletAccount;
  readonly wallets: ReadonlyArray<WalletAccount>;
  /**
   * Preallocated wallets the signed-in user can still claim, of every wallet type. Excludes a
   * wallet claimed during this sign-in; empty when there are none.
   */
  readonly claimableWallets: ReadonlyArray<WalletAccount>;
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
  /** Preallocated wallets of `walletType` that the signed-in user can claim. */
  readonly claimableWallets: ReadonlyArray<WalletAccount>;
  readonly credential: Readonly<WalletCredential>;

  selectWallet(params: { walletId: string }): Promise<WalletActivationResult>;
  createAndSelectWallet(params?: { reference?: string }): Promise<WalletActivationResult>;
  /** Claims one of `claimableWallets` and activates it. */
  claimAndSelectWallet(params: { walletId: string }): Promise<WalletActivationResult>;
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
  /**
   * The current session expiry. WaaS extends it with use, up to the lifetime requested at sign-in,
   * and the SDK refreshes it.
   */
  readonly expiresAt: string;
  readonly auth: OMSWalletSessionAuth;
}

/** Session lifetime requested when `sessionLifetimeSeconds` is omitted (180 days, the maximum). */
export const DEFAULT_SESSION_LIFETIME_SECONDS = 15_552_000;
/** Largest accepted `sessionLifetimeSeconds` (180 days). */
export const MAX_SESSION_LIFETIME_SECONDS = 15_552_000;

/** A session that expired, as reported by an `expired` session change. */
export interface OMSWalletExpiredSession {
  /**
   * The wallet that was active when the session expired. `undefined` when the credential expired
   * while a manual wallet selection was still pending.
   */
  readonly wallet: WalletAccount | undefined;
  readonly session: OMSWalletSession;
  /**
   * When the session ended: its expiry, or the time the SDK found it ended when that was earlier
   * (for example after another tab's session ended it).
   */
  readonly expiredAt: string;
}

/**
 * Why `activeWallet` or `session` changed.
 *
 * - `signedIn`: a sign-in made a wallet active, in this client or in another tab.
 * - `walletChanged`: another wallet of the same sign-in became active, here or in another tab.
 * - `expiryUpdated`: `session.expiresAt` moved. Safe to ignore unless you show the expiry.
 * - `signedOut`: there is no session any more and it did not expire: `signOut()`, a sign-in
 *   started while signed in, or another tab taking over. Not necessarily the user's choice.
 * - `expired`: the session expired, or the wallet API no longer accepts it.
 */
export type OMSWalletSessionChangeReason =
  'signedIn' | 'walletChanged' | 'expiryUpdated' | 'signedOut' | 'expired';

/** The state right after a session change: what `activeWallet` and `session` returned then. */
export type OMSWalletSessionChangeEvent =
  | {
      readonly reason: 'signedIn' | 'walletChanged' | 'expiryUpdated';
      readonly activeWallet: WalletAccount;
      readonly session: OMSWalletSession;
    }
  | {
      readonly reason: 'signedOut';
      readonly activeWallet: undefined;
      readonly session: undefined;
    }
  | {
      readonly reason: 'expired';
      readonly activeWallet: undefined;
      readonly session: undefined;
      readonly expiredSession: OMSWalletExpiredSession;
    };

export type OMSWalletSessionChangeListener = (
  event: OMSWalletSessionChangeEvent
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
  /** Address to verify against. Omit to use the active Ethereum wallet's address. */
  walletAddress?: Address;
  message: string;
  signature: string;
}

export interface IsValidSolanaMessageSignatureParams {
  /** Address to verify against. Omit to use the active Solana wallet's address. */
  walletAddress?: string;
  message: string;
  signature: string;
}

export interface IsValidTypedDataSignatureParams {
  network?: Network;
  /** Address to verify against. Omit to use the active Ethereum wallet's address. */
  walletAddress?: Address;
  typedData: unknown;
  signature: string;
}

export interface IsValidTronMessageSignatureParams {
  /** Base58Check address (`T…`) to verify against. Omit to use the active Tron wallet's address. */
  walletAddress?: string;
  message: string;
  signature: string;
}

export interface IsValidTronTypedDataSignatureParams {
  /** Base58Check address (`T…`) to verify against. Omit to use the active Tron wallet's address. */
  walletAddress?: string;
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

export interface WalletClient {
  /**
   * The active wallet, or `undefined` when signed out or while a manual wallet selection is pending.
   * Same shape as `listWallets()` entries. The same frozen object is returned until it changes.
   */
  readonly activeWallet: WalletAccount | undefined;
  /**
   * Expiry and auth metadata for the active session; defined exactly when `activeWallet` is. The
   * same frozen object is returned until it changes.
   */
  readonly session: OMSWalletSession | undefined;

  /**
   * Calls `listener` after every change of `activeWallet` or `session`, in order and shortly after
   * the change (never during the call that made it). Subscribe first, then read `activeWallet` and
   * `session`, so no change is missed. A listener added while signed out first receives the last
   * `expired` change, if a session expired since the last sign-in or sign-out (for example while
   * the page was closed). Returns a function that unsubscribes.
   */
  onSessionChange(listener: OMSWalletSessionChangeListener): () => void;
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
  /**
   * Claims a preallocated wallet for the signed-in user and makes it the active wallet. Requires
   * an active session; during a pending manual selection use
   * `PendingWalletSelection.claimAndSelectWallet`.
   */
  claimWallet(params: { walletId: string }): Promise<WalletActivationResult>;
  createWallet(params?: {
    walletType?: WalletType;
    reference?: string;
  }): Promise<WalletActivationResult>;
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
  /** Returns one access page. Pass the previous page's `page.cursor` to continue. */
  listAccessPage(params?: ListAccessPageParams): Promise<AccessGrantPage>;
  listAccessPages(params?: ListAccessParams): AsyncIterable<AccessGrantPage>;
  getRemoteAccessSession(params: { sessionId: string }): Promise<RemoteAccessSession>;
  getRemoteAccessSessionUsage(params: {
    sessionId: string;
    network: Network;
  }): Promise<SmartSessionGrantUsage[]>;
  revokeAccess(params: RevokeAccessParams): Promise<void>;
}
