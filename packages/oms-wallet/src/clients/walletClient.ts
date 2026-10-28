import type { ContractFunctionName, Abi, Address, EncodeFunctionDataParameters } from 'viem';

import { encodeFunctionData, isAddress } from 'viem';

import type { CredentialSigner, CredentialSigningAlgorithm } from '../credentialSigner.js';
import type { OMSWalletError } from '../errors.js';
import type {
  CommitVerifierRequest,
  CompleteAuthRequest,
  CompleteAuthResponse,
  ClaimWalletRequest,
  CreateWalletRequest,
  UseWalletRequest,
  ListAccessRequest,
  ListWalletsRequest,
  RevokeAccessRequest,
  AuthorizeRemoteAccessRequest,
  SignMessageRequest,
  SignTypedDataRequest,
  GetIDTokenRequest,
  IsValidMessageSignatureRequest,
  IsValidTypedDataSignatureRequest,
  PrepareEthereumTransactionRequest,
  PrepareEthereumContractCallRequest,
  PrepareSolanaTransferRequest,
  PrepareTronTransactionRequest,
  PrepareTronContractCallRequest,
  ExecuteRequest,
  ExecuteResponse,
  TransactionStatusRequest,
  PrepareResponse,
  Fetch,
  HPKEPayload,
  FeeOption as GeneratedFeeOption
} from '../generated/waas.gen.js';
import type { Network, SolanaNetwork, TronNetwork } from '../networks.js';
import type { ResolvedOidcProviderConfig } from '../oidc.js';
import type { OMSWalletEnvironment } from '../omsEnvironment.js';
import type { StorageManager } from '../storageManager.js';
import type {
  AccessGrant,
  AccessGrantPage,
  AuthorizeRemoteAccessParams,
  AuthorizedRemoteAccess,
  ListAccessPageParams,
  ListAccessParams,
  RemoteCredentialMetadata,
  RevokeAccessParams,
  RemoteAccessSession,
  SmartSessionGrantUsage,
  WalletCredential
} from '../types/accessGrant.js';
import type {
  FeeOptionSelector,
  FeeOptionWithBalance,
  SendContractTransactionParams,
  SendDataTransactionParams,
  SendNativeTransactionParams,
  SendSolanaTransferParams,
  SendTransactionParams,
  SendTransactionResponse,
  SendTronTransactionParams,
  CallTronContractParams,
  TransactionStatusPollingOptions
} from '../types/transactionTypes.js';
import type {
  AbiArg,
  OidcAuthMode,
  FeeOption,
  FeeOptionSelection,
  TransactionStatusResponse,
  WalletImportCipherSuite
} from '../types/waas.js';
import type { SessionStorageKeys } from '../utils/constants.js';
import type {
  AutomaticWalletSelectionParams,
  CompleteEmailAuthParams,
  CompleteEmailAuthResult,
  CompleteOidcIdTokenAuthResult,
  CompleteOidcRedirectAuthParams,
  CompleteOidcRedirectAuthResult,
  CompleteWalletAuthResult,
  GetIdTokenParams,
  IsValidMessageSignatureParams,
  IsValidSolanaMessageSignatureParams,
  IsValidTypedDataSignatureParams,
  IsValidTronMessageSignatureParams,
  IsValidTronTypedDataSignatureParams,
  ImportEncryptedWalletParams,
  ImportWalletParams,
  ManualWalletSelectionParams,
  WalletClient,
  OMSWalletEmailSessionAuth,
  OMSWalletOidcSessionAuth,
  OMSWalletOidcSessionAuthFlow,
  OMSWalletSessionAuth,
  OMSWalletSessionExpiredEvent,
  OMSWalletSessionExpiredListener,
  OMSWalletSession,
  PendingWalletSelection,
  SignInWithOidcIdTokenParams,
  SignInWithOidcRedirectParams,
  SignMessageParams,
  SignSolanaMessageParams,
  SignTypedDataParams,
  SignTronMessageParams,
  SignTronTypedDataParams,
  StartEmailAuthParams,
  StartOidcRedirectAuthParams,
  StartOidcRedirectAuthResult,
  WalletAccount,
  WalletActivationResult,
  WalletImportRecipientKey,
  WalletSelectionBehavior
} from '../wallet.js';
import type { TokenBalance } from './indexerClient.js';

import { createAttestedFetch } from '../attestation.js';
import { WebCryptoP256CredentialSigner } from '../credentialSigner.js';
import {
  isBadRouteError,
  isCredentialEndedError,
  isUnauthorizedError,
  OMSWalletResponseError,
  OMSWalletSessionError,
  OMSWalletValidationError,
  OMSWalletStorageError,
  OMSWalletTransactionError,
  OMSWalletSelectionError,
  toOMSWalletError
} from '../errors.js';
import {
  Waas as WaasClient,
  WaasPublic as WaasPublicClient,
  IdentityType,
  AuthMode as GeneratedAuthMode,
  NetworkFamily as GeneratedNetworkFamily,
  CredentialType,
  KeyFormat as GeneratedKeyFormat,
  TransportPurpose as GeneratedTransportPurpose
} from '../generated/waas.gen.js';
import { TronNetworks } from '../networks.js';
import { isOmsRelayOidcProvider, resolveOidcProviderConfig } from '../oidc.js';
import { WalletOperation } from '../operations.js';
import {
  createDeadlineFetch,
  createSerialFetch,
  createSignedFetch,
  untilAborted,
  wasRequestSent
} from '../signedFetch.js';
import { createDefaultStorage, SessionStorageManager } from '../storageManager.js';
import { feeOptionSelection } from '../types/transactionTypes.js';
import {
  AuthMode,
  TransactionMode,
  TransactionStatus,
  WalletImportCipherSuite as WalletImportCipherSuiteValues,
  WalletKeyOrigin,
  WalletType
} from '../types/waas.js';
import {
  fromGeneratedRemoteAccessSession,
  fromGeneratedSmartSessionGrantUsages,
  toGeneratedSmartSessionGrant
} from '../utils/accessGrant.js';
import { sessionStorageKeys } from '../utils/constants.js';
import { oidcIdTokenExpiresAtEpochSeconds, oidcIdTokenHandleHash } from '../utils/oidcIdToken.js';
import {
  buildOidcAuthorizationUrl,
  cleanOidcCallbackUrl,
  decodeOidcState,
  encodeOidcState,
  generateOidcNonce,
  matchesRedirectUri,
  parseOidcCallbackUrl,
  redirectUriFromCurrentUrl
} from '../utils/oidcRedirect.js';
import { RequestUtils } from '../utils/requestUtils.js';
import {
  fromGeneratedFeeOption,
  fromGeneratedTransactionStatus,
  fromGeneratedTransactionStatusResponse,
  toGeneratedAuthMode,
  toGeneratedFeeOptionSelection,
  toGeneratedNetworkFamily,
  toGeneratedTransactionMode,
  toGeneratedWalletImportCipherSuite
} from '../utils/waasTypes.js';
import {
  fromGeneratedAccessGrant,
  fromGeneratedRemoteCredentialMetadata,
  fromGeneratedWallet
} from '../utils/walletResponse.js';
import { DEFAULT_SESSION_LIFETIME_SECONDS, MAX_SESSION_LIFETIME_SECONDS } from '../wallet.js';
import {
  requireBase64,
  sealWalletImportPrivateKey,
  validateWalletImportReference,
  walletImportPlaintext
} from '../walletImport.js';
import { IndexerClientImpl } from './indexerClient.js';

interface PendingOidcRedirectAuth {
  verifier: string;
  nonce: string;
  authMode: OidcAuthMode;
  provider?: string;
  providerLabel?: string;
  walletType: WalletType;
  walletSelection?: WalletSelectionBehavior;
  sessionLifetimeSeconds?: number;
  signerCredentialId: string;
  signerKeyType: CredentialSigningAlgorithm;
  expectedCallbackUri: string;
  issuer: string;
  projectId: string;
  consumed?: boolean;
}

/**
 * What sign-in reveals about how far WaaS can extend the session expiry. Undefined when unknown (a
 * sign-in response without a usable expiry).
 */
interface SessionExpiryBounds {
  /**
   * The server's idle window: how far a session-signed request can move the expiry past its own
   * send time. Derived at sign-in, where WaaS sets the expiry to an idle window after the request.
   */
  idleWindowMs: number;
  /** The latest the server can extend the expiry to (sign-in plus the requested lifetime), epoch ms. */
  expiryCeilingMs: number;
}

/** When a `CompleteAuth` request was sent (epoch ms) and the session lifetime it requested. */
interface CompleteAuthSent {
  sentAt: number;
  lifetimeSeconds: number;
}

interface WalletSessionMetadata {
  expiresAt: string;
  auth: OMSWalletSessionAuth;
  signerCredentialId: string;
  signerKeyType: CredentialSigningAlgorithm;
  expiryBounds?: SessionExpiryBounds;
  /** Send time of the `CompleteAuth` that returned `expiresAt`, in epoch ms; set only at sign-in. */
  signInSentAt?: number;
}

/** A point-in-time view of a session; `wallet` is undefined while a wallet selection is pending. */
interface SessionSnapshot {
  wallet: WalletAccount | undefined;
  expiresAt: string;
  auth: OMSWalletSessionAuth;
}

interface StoredSessionSnapshot {
  serializedRecord: string;
  session: SessionSnapshot;
}

interface StoredSessionRecord {
  version: 2;
  scope: {
    projectId: string;
    walletApiUrl: string;
    indexerGatewayUrl: string;
  };
  wallet: WalletAccount;
  expiresAt: string;
  auth: OMSWalletSessionAuth;
  signerCredentialId: string;
  signerKeyType: CredentialSigningAlgorithm;
  /**
   * `SessionExpiryBounds.idleWindowMs`. Absent when unknown; a record without valid bounds is
   * discarded on load.
   */
  idleWindowMs?: number;
  /** `SessionExpiryBounds.expiryCeilingMs` as an ISO 8601 timestamp; absent when unknown. */
  expiryCeiling?: string;
}

interface LoadedSessionRecord {
  record: StoredSessionRecord;
  serialized: string;
}

/**
 * Result of reading the session credential's current expiry from WaaS. `ended`: WaaS no longer
 * accepts the credential and the session was ended. `unsupported`: the server has no
 * `GetCredential`. `unavailable`: the request failed and the session is unchanged. `stale`: the
 * session changed while the request was in flight, so the result was not applied.
 * `signerMismatch`: the signer no longer holds the session's key, so the session was cleared
 * without a request.
 */
/**
 * Who starts an expiry read. `timer`: the expiry timer's check, sent past the bound on the server
 * expiry, so it is not recorded as activity. `operation`: an operation on a locally expired session,
 * which reports the outcome itself. `background`: a restore, the 6-hour refresh, or a check after an
 * `Unauthorized` request; when it finds the signer key replaced, it notifies `onSessionExpired`.
 */
type CredentialReadOrigin = 'timer' | 'operation' | 'background';

type CredentialRefreshResult =
  | { outcome: 'refreshed' | 'unsupported' | 'stale' | 'signerMismatch' }
  | { outcome: 'ended' | 'unavailable'; error: unknown };

interface PolledTransactionStatus {
  response: TransactionStatusResponse;
  resolution: 'resolved' | 'timed-out';
}

interface ActivePendingWalletSelection {
  id: string;
  inFlight: boolean;
  signerCredentialId: string;
  signerKeyType: CredentialSigningAlgorithm;
  walletType: WalletType;
  metadata: WalletSessionMetadata;
}

interface ActiveWalletActivationContext {
  walletId: string;
  metadata: WalletSessionMetadata;
}

type WalletImportActivationContext =
  | {
      type: 'active';
      walletId: string;
      metadata: WalletSessionMetadata;
    }
  | {
      type: 'pending';
      selectionId: string;
      metadata: WalletSessionMetadata;
    };

type PendingWalletSelectionActionRunner = <T>(
  operation: WalletOperation,
  action: () => Promise<T>
) => Promise<T>;

interface WalletAuthCommitGuard {
  validate(): void;
}

interface EmailAuthCompletionParams {
  code: string;
  walletType: WalletType;
  walletSelection: WalletSelectionBehavior;
}

interface ActiveEmailAuthAttempt {
  email: string;
  verifier: string;
  challenge: string;
  sessionLifetimeSeconds: number;
  completion?: {
    params: EmailAuthCompletionParams;
    promise: Promise<CompleteEmailAuthResult | PendingWalletSelection>;
  };
}

class PendingWalletSelectionImpl implements PendingWalletSelection {
  private readonly availableWalletIds: Set<string>;
  private readonly claimableWalletIds: Set<string>;

  constructor(
    public readonly walletType: WalletType,
    public readonly wallets: ReadonlyArray<WalletAccount>,
    public readonly claimableWallets: ReadonlyArray<WalletAccount>,
    public readonly credential: Readonly<WalletCredential>,
    private readonly selectWalletAction: (walletId: string) => Promise<WalletActivationResult>,
    private readonly createAndSelectWalletAction: (
      reference?: string
    ) => Promise<WalletActivationResult>,
    private readonly claimAndSelectWalletAction: (
      walletId: string
    ) => Promise<WalletActivationResult>,
    private readonly runExclusiveAction: PendingWalletSelectionActionRunner
  ) {
    this.availableWalletIds = new Set(wallets.map((wallet) => wallet.id));
    this.claimableWalletIds = new Set(claimableWallets.map((wallet) => wallet.id));
  }

  async selectWallet(params: { walletId: string }): Promise<WalletActivationResult> {
    return this.runExclusiveAction(WalletOperation.pendingWalletSelectionSelectWallet, async () => {
      if (!this.availableWalletIds.has(params.walletId)) {
        throw new OMSWalletSelectionError({
          code: 'OMS_WALLET_SELECTION_UNAVAILABLE',
          operation: WalletOperation.pendingWalletSelectionSelectWallet,
          message: 'Selected wallet is not one of the available options'
        });
      }
      return this.selectWalletAction(params.walletId);
    });
  }

  async createAndSelectWallet(
    params: { reference?: string } = {}
  ): Promise<WalletActivationResult> {
    return this.runExclusiveAction(
      WalletOperation.pendingWalletSelectionCreateAndSelectWallet,
      () => this.createAndSelectWalletAction(params.reference)
    );
  }

  async claimAndSelectWallet(params: { walletId: string }): Promise<WalletActivationResult> {
    return this.runExclusiveAction(
      WalletOperation.pendingWalletSelectionClaimAndSelectWallet,
      async () => {
        if (!this.claimableWalletIds.has(params.walletId)) {
          throw new OMSWalletSelectionError({
            code: 'OMS_WALLET_SELECTION_UNAVAILABLE',
            operation: WalletOperation.pendingWalletSelectionClaimAndSelectWallet,
            message: 'Selected wallet is not one of the claimable wallets'
          });
        }
        return this.claimAndSelectWalletAction(params.walletId);
      }
    );
  }
}

export class WalletClientImpl implements WalletClient {
  private readonly client: WaasClient;
  /**
   * Reads the session credential's expiry. Its requests are not recorded as session activity, though
   * WaaS extends the credential on them too.
   */
  private readonly credentialClient: WaasClient;
  private readonly walletImportClient?: WaasClient;
  private readonly publicClient: WaasPublicClient;
  private readonly storage: StorageManager;
  private readonly storageKeys: SessionStorageKeys;
  private readonly redirectAuthStorage?: StorageManager;
  private readonly credentialSigner: CredentialSigner;
  private readonly indexerClient: IndexerClientImpl;
  private readonly environment: OMSWalletEnvironment;
  private readonly projectId: string;
  /** The key sent with each request; a rotated key of the same project replaces it. */
  private publishableKey: string;
  private readonly sessionExpiredListeners = new Set<OMSWalletSessionExpiredListener>();
  private readonly fastTransactionStatusPollIntervalMs = 400;
  private readonly fastTransactionStatusPollCount = 5;
  private readonly transactionStatusPollIntervalMs = 2_000;
  private readonly transactionStatusPollTimeoutMs = 60_000;

  private activeWalletAccount: WalletAccount | undefined;
  private sessionExpiresAt: string | undefined;
  private sessionAuth: OMSWalletSessionAuth | undefined;
  private sessionSignerCredentialId: string | undefined;
  private sessionSignerKeyType: CredentialSigningAlgorithm | undefined;
  private sessionExpiryBounds: SessionExpiryBounds | undefined;
  private activePendingWalletSelection: ActivePendingWalletSelection | undefined;
  private activeEmailAuthAttempt: ActiveEmailAuthAttempt | undefined;
  private nextPendingWalletSelectionId = 1;
  private sessionExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelRestoredSessionRead: (() => void) | undefined;
  private latestSessionExpiredEvent: OMSWalletSessionExpiredEvent | undefined;
  private sessionRevision = 0;
  /** Revision of the last session that ended by expiry, locally or reported by WaaS. */
  private expiredSessionRevision: number | undefined;
  /**
   * Signed requests share a per-credential nonce that WaaS requires to increase, so an expiry read
   * never overlaps another signed session request: it waits until none is in flight, and requests
   * started during the read wait for it before signing.
   */
  private signedSessionRequestsInFlight = 0;
  private signedSessionRequestsIdleWaiters: Array<() => void> = [];
  private credentialReadInFlight: Promise<void> | undefined;
  /** Session revision of the last session-signed request that WaaS rejected with 7202 or 7203. */
  private rejectedSessionCredentialRevision: number | undefined;
  private dispatchingSessionExpiredEvent = false;
  private credentialRefresh:
    { revision: number; promise: Promise<CredentialRefreshResult> } | undefined;
  /**
   * Until when, in epoch ms, the expiry is not read after WaaS answered `GetCredential` with
   * `WebrpcBadRoute` (a server without it, or a misrouted request); it is asked again after that.
   */
  private credentialRefreshUnsupportedUntil: number | undefined;
  /**
   * When the session expiry was last read from WaaS in this client, in epoch ms: the send time of
   * the sign-in `CompleteAuth`, or the completion of the last successful `GetCredential`. Unset
   * after a restore until a read succeeds.
   */
  private lastCredentialRefreshAt: number | undefined;
  /**
   * Completion (response or error) of the last session-signed request, in epoch ms: until then it
   * can reach WaaS and extend the credential. `GetCredential` counts whatever its outcome (WaaS may
   * have extended the credential when the response was lost), except the expiry timer's own check.
   * A restore sets it to the restore time, which bounds the requests of the process that stored
   * the session.
   */
  private lastSessionActivityAt: number | undefined;
  /** Completion of the last `GetCredential`, in epoch ms. Reads never overlap, so it is the current read's. */
  private lastCredentialReadCompletedAt: number | undefined;
  /** Whether the next `GetCredential` send counts as activity; false only for the timer's check. */
  private nextCredentialReadRecordsActivity = true;
  /** The shared activity record this client last wrote, to skip writes that would not move it. */
  private lastSharedSessionActivity: { signerCredentialId: string; at: number } | undefined;
  private credentialRefreshRetryDelayMs = CREDENTIAL_REFRESH_RETRY_MIN_MS;

  /** The active wallet's ID, or `''` without an active wallet. */
  private get walletId(): string {
    return this.activeWalletAccount?.id ?? '';
  }

  constructor(params: {
    publishableKey: string;
    projectId: string;
    environment: OMSWalletEnvironment;
    storage?: StorageManager;
    redirectAuthStorage?: StorageManager;
    credentialSigner?: CredentialSigner;
    walletImportTrustedPcr0s?: ReadonlyArray<string>;
  }) {
    this.environment = params.environment;
    this.storageKeys = sessionStorageKeys(params.projectId, params.environment.walletApiUrl);
    this.storage = params.storage ?? createDefaultStorage();
    this.redirectAuthStorage = params.redirectAuthStorage ?? defaultRedirectAuthStorage();
    this.credentialSigner =
      params.credentialSigner ??
      new WebCryptoP256CredentialSigner(this.storageKeys.webCryptoCredential);
    this.projectId = params.projectId;

    const storedSession = this.loadStoredSessionRecord();

    if (storedSession) {
      const { record } = storedSession;
      const restoredSession: SessionSnapshot = {
        wallet: record.wallet,
        expiresAt: record.expiresAt,
        auth: record.auth
      };

      if (this.isSessionExpired(restoredSession)) {
        this.activeWalletAccount = undefined;
        this.sessionExpiresAt = undefined;
        this.sessionAuth = undefined;
        this.scheduleStoredSessionExpiryNotification({
          serializedRecord: storedSession.serialized,
          session: restoredSession
        });
      } else {
        this.activeWalletAccount = record.wallet;
        this.sessionExpiresAt = restoredSession.expiresAt;
        this.sessionAuth = restoredSession.auth;
        this.sessionSignerCredentialId = record.signerCredentialId;
        this.sessionSignerKeyType = record.signerKeyType;
        this.sessionExpiryBounds = storedSessionExpiryBounds(record);
        // The process that stored the session may have used it after its last read, but not later
        // than now. The expiry is not read in this client yet, so `lastCredentialRefreshAt` stays unset.
        this.lastSessionActivityAt = Date.now();
        this.scheduleSessionExpiry(restoredSession);
      }
    } else {
      this.activeWalletAccount = undefined;
      this.sessionExpiresAt = undefined;
      this.sessionAuth = undefined;
      this.sessionSignerCredentialId = undefined;
      this.sessionSignerKeyType = undefined;
      this.sessionExpiryBounds = undefined;
    }

    this.publishableKey = params.publishableKey;
    const publishableKey = () => this.publishableKey;
    // Session requests and expiry reads signed with one credential reach WaaS one at a time.
    const signedFetch = createSerialFetch(
      createSignedFetch(publishableKey, this.credentialSigner, this.projectId),
      this.credentialSigner,
      `oms-wallet-signed-requests:${this.storageKeys.scope}`
    );
    const sessionFetch = this.sessionActivityFetch(this.sessionRequestFetch(signedFetch));
    this.client = new WaasClient(
      params.environment.walletApiUrl,
      createDeadlineFetch(sessionFetch)
    );
    this.credentialClient = new WaasClient(
      params.environment.walletApiUrl,
      createDeadlineFetch(this.credentialReadFetch(signedFetch))
    );
    this.walletImportClient = params.walletImportTrustedPcr0s
      ? new WaasClient(
          params.environment.walletApiUrl,
          createDeadlineFetch(createAttestedFetch(sessionFetch, params.walletImportTrustedPcr0s))
        )
      : undefined;
    this.publicClient = new WaasPublicClient(
      params.environment.walletApiUrl,
      createApiKeyFetch(publishableKey)
    );
    this.indexerClient = new IndexerClientImpl({
      publishableKey: params.publishableKey,
      environment: params.environment
    });

    if (this.activeWalletAccount) {
      // A restored session may have been extended or ended on the server since it was saved. The
      // read extends an active session, so a hidden or prerendered page waits until it is shown.
      // Ending the session cancels the wait so its listeners don't keep this client alive.
      this.cancelRestoredSessionRead = whenInForeground(() => {
        this.cancelRestoredSessionRead = undefined;
        void this.refreshSessionCredential('background');
      });
    }
  }

  /**
   * Sends later requests with `publishableKey`, a rotated key of the same project and environment.
   * The session belongs to the project, not to a key, so it is kept.
   */
  usePublishableKey(publishableKey: string): void {
    this.publishableKey = publishableKey;
    this.indexerClient.usePublishableKey(publishableKey);
  }

  /**
   * The active wallet. Undefined until a wallet is activated (automatic sign-in, a restored session,
   * or a choice from a pending manual selection), while a manual selection is pending, and after
   * sign-out or session expiry. Narrow on `type` to get the family-specific address type.
   */
  get activeWallet(): WalletAccount | undefined {
    return this.activeWalletAccount ? cloneWalletAccount(this.activeWalletAccount) : undefined;
  }

  /** Durable metadata for the active wallet session. Defined exactly when `activeWallet` is. */
  get session(): OMSWalletSession | undefined {
    if (!this.activeWalletAccount || !this.sessionExpiresAt || !this.sessionAuth) {
      return undefined;
    }

    return {
      expiresAt: this.sessionExpiresAt,
      auth: { ...this.sessionAuth }
    };
  }

  onSessionExpired(listener: OMSWalletSessionExpiredListener): () => void {
    this.sessionExpiredListeners.add(listener);

    if (this.latestSessionExpiredEvent && !this.dispatchingSessionExpiredEvent) {
      this.callSessionExpiredListener(
        listener,
        cloneSessionExpiredEvent(this.latestSessionExpiredEvent)
      );
    }

    return () => {
      this.sessionExpiredListeners.delete(listener);
    };
  }

  /**
   * Initiates email-based OTP authentication by sending a one-time code to the given address.
   *
   * After this resolves, show your OTP entry UI and pass the code to `completeEmailAuth`.
   */
  async startEmailAuth(params: StartEmailAuthParams): Promise<void> {
    return this.runOperation(WalletOperation.startEmailAuth, async () => {
      const sessionLifetimeSeconds = this.sessionLifetimeSeconds(
        params.sessionLifetimeSeconds,
        WalletOperation.startEmailAuth
      );
      await this.clearSession({ operation: WalletOperation.startEmailAuth });
      const request: CommitVerifierRequest = {
        identityType: IdentityType.Email,
        authMode: GeneratedAuthMode.OTP,
        metadata: {},
        handle: params.email
      };
      const response = await this.client.commitVerifier(request);
      this.activeEmailAuthAttempt = {
        email: params.email,
        verifier: response.verifier,
        challenge: response.challenge,
        sessionLifetimeSeconds
      };
    });
  }

  /**
   * Completes the email OTP flow by verifying the code the user received.
   *
   * Must be called after `startEmailAuth`. On success, this activates an
   * existing wallet or creates a new one and returns the wallet address plus
   * the credential added by WaaS.
   */
  async completeEmailAuth(
    params: ManualWalletSelectionParams<CompleteEmailAuthParams>
  ): Promise<PendingWalletSelection>;
  async completeEmailAuth(
    params: AutomaticWalletSelectionParams<CompleteEmailAuthParams>
  ): Promise<CompleteEmailAuthResult>;
  async completeEmailAuth(
    params: CompleteEmailAuthParams
  ): Promise<CompleteEmailAuthResult | PendingWalletSelection>;
  async completeEmailAuth(
    params: CompleteEmailAuthParams
  ): Promise<CompleteEmailAuthResult | PendingWalletSelection> {
    return this.runOperation(WalletOperation.completeEmailAuth, async () => {
      const completionParams: EmailAuthCompletionParams = {
        code: params.code,
        walletType: params.walletType ?? WalletType.Ethereum,
        walletSelection: params.walletSelection ?? 'automatic'
      };
      const attempt = this.currentEmailAuthAttempt(WalletOperation.completeEmailAuth);
      const completion = attempt.completion;
      if (completion) {
        if (!sameEmailAuthCompletionParams(completion.params, completionParams)) {
          throw new OMSWalletSessionError({
            operation: WalletOperation.completeEmailAuth,
            message: 'Email auth completion is already in flight'
          });
        }
        return completion.promise;
      }

      const promise: Promise<CompleteEmailAuthResult | PendingWalletSelection> =
        this.completeEmailAuthAttempt(attempt, completionParams).catch((error) => {
          const sdkError = toOMSWalletError(error, WalletOperation.completeEmailAuth);
          if (this.activeEmailAuthAttempt === attempt && attempt.completion?.promise === promise) {
            if (sdkError.code === 'OMS_AUTH_COMMITMENT_CONSUMED') {
              this.activeEmailAuthAttempt = undefined;
            } else {
              attempt.completion = undefined;
            }
          }
          throw sdkError;
        });
      attempt.completion = { params: completionParams, promise };
      return promise;
    });
  }

  /**
   * Signs in with an app-provided OIDC ID token.
   *
   * The application is responsible for obtaining the provider ID token and passing
   * the issuer and audience used to mint it. The SDK completes WaaS ID-token auth
   * and then activates an existing wallet or creates one.
   */
  async signInWithOidcIdToken(
    params: ManualWalletSelectionParams<SignInWithOidcIdTokenParams>
  ): Promise<PendingWalletSelection>;
  async signInWithOidcIdToken(
    params: AutomaticWalletSelectionParams<SignInWithOidcIdTokenParams>
  ): Promise<CompleteOidcIdTokenAuthResult>;
  async signInWithOidcIdToken(
    params: SignInWithOidcIdTokenParams
  ): Promise<CompleteOidcIdTokenAuthResult | PendingWalletSelection>;
  async signInWithOidcIdToken(
    params: SignInWithOidcIdTokenParams
  ): Promise<CompleteOidcIdTokenAuthResult | PendingWalletSelection> {
    return this.runOperation(WalletOperation.signInWithOidcIdToken, async () => {
      await this.clearSession({ operation: WalletOperation.signInWithOidcIdToken });
      const authRevision = this.sessionRevision;
      const sessionLifetimeSeconds = this.sessionLifetimeSeconds(
        params.sessionLifetimeSeconds,
        WalletOperation.signInWithOidcIdToken
      );

      const idTokenExpiresAt = oidcIdTokenExpiresAtEpochSeconds(params.idToken);
      const request: CommitVerifierRequest = {
        identityType: IdentityType.OIDC,
        authMode: GeneratedAuthMode.IDToken,
        metadata: {
          iss: params.issuer,
          aud: params.audience,
          exp: idTokenExpiresAt.toString()
        },
        handle: await oidcIdTokenHandleHash(params.idToken)
      };
      const commitment = await this.client.commitVerifier(request);
      const completeRequest: CompleteAuthRequest = {
        identityType: IdentityType.OIDC,
        authMode: GeneratedAuthMode.IDToken,
        verifier: commitment.verifier,
        answer: params.idToken,
        lifetime: sessionLifetimeSeconds
      };
      const sentAt = Date.now();
      const response = await this.client.completeAuth(completeRequest);
      return this.completeWalletAuth(
        response,
        { sentAt, lifetimeSeconds: sessionLifetimeSeconds },
        params.walletType ?? WalletType.Ethereum,
        params.walletSelection ?? 'automatic',
        this.oidcIdTokenSessionAuthFromParams(params, response),
        WalletOperation.signInWithOidcIdToken,
        {
          validate: () =>
            this.requireCurrentSessionRevision(authRevision, WalletOperation.signInWithOidcIdToken)
        }
      );
    });
  }

  /**
   * Starts an OIDC authorization-code redirect flow and returns the provider URL.
   *
   * Store or navigate to the returned `url`, then call `completeOidcRedirectAuth`
   * after the provider redirects back to your application.
   */
  async startOidcRedirectAuth(
    params: StartOidcRedirectAuthParams
  ): Promise<StartOidcRedirectAuthResult> {
    return this.runOperation(WalletOperation.startOidcRedirectAuth, async () => {
      const previousSession = this.session;
      const redirectAuthStorage = this.requireRedirectAuthStorage();
      const providerValue = params.provider;
      const provider = resolveOidcProviderConfig(providerValue);
      const isOmsRelayProvider = isOmsRelayOidcProvider(providerValue);
      if (isOmsRelayProvider && params.authorizeParams !== undefined) {
        throw new Error('OMS relay OIDC authorization parameters are fixed by the SDK');
      }
      const authMode = this.resolveOidcAuthMode(provider);
      const sessionLifetimeSeconds =
        params.sessionLifetimeSeconds === undefined
          ? undefined
          : this.sessionLifetimeSeconds(
              params.sessionLifetimeSeconds,
              WalletOperation.startOidcRedirectAuth
            );
      const providerRedirectUri = isOmsRelayProvider
        ? this.derivedOmsRelayRedirectUri(providerValue.provider)
        : providerValue.providerRedirectUri;
      if (!providerRedirectUri) {
        throw new Error('OIDC provider requires providerRedirectUri');
      }
      if (!isOmsRelayProvider && params.omsRelayReturnUri !== undefined) {
        throw new Error(
          'omsRelayReturnUri is only supported for SDK built-in Google and Apple OIDC providers'
        );
      }
      const omsRelayReturnUri =
        params.omsRelayReturnUri ??
        (isOmsRelayProvider
          ? redirectUriFromCurrentUrl(
              this.browserCurrentUrl('startOidcRedirectAuth', 'omsRelayReturnUri')
            )
          : undefined);
      const expectedCallbackUri = omsRelayReturnUri ?? providerRedirectUri;

      await this.clearSession({ operation: WalletOperation.startOidcRedirectAuth });
      const authRevision = this.sessionRevision;

      const request: CommitVerifierRequest = {
        identityType: IdentityType.OIDC,
        authMode: toGeneratedAuthMode(authMode),
        metadata: {
          iss: provider.issuer,
          aud: provider.clientId,
          redirect_uri: providerRedirectUri
        }
      };
      const response = await this.client.commitVerifier(request);
      const signerCredentialId = await this.credentialSigner.credentialId();
      this.requireCurrentSessionRevision(authRevision, WalletOperation.startOidcRedirectAuth);
      const nonce = generateOidcNonce();
      const state = encodeOidcState({
        nonce,
        scope: this.projectId,
        ...(omsRelayReturnUri ? { redirect_uri: omsRelayReturnUri } : {})
      });

      const pending: PendingOidcRedirectAuth = {
        verifier: response.verifier,
        nonce,
        authMode,
        provider: this.sessionProviderFromOidcProvider(provider),
        providerLabel: this.sessionProviderLabelFromOidcProvider(provider),
        walletType: params.walletType ?? WalletType.Ethereum,
        walletSelection: params.walletSelection,
        sessionLifetimeSeconds,
        signerCredentialId,
        signerKeyType: this.credentialSigner.signingAlgorithm,
        expectedCallbackUri,
        issuer: provider.issuer,
        projectId: this.projectId
      };
      this.savePendingOidcRedirectAuth(redirectAuthStorage, pending);

      const authorizeParams = isOmsRelayProvider
        ? provider.authorizeParams
        : {
            ...provider.authorizeParams,
            ...params.authorizeParams
          };
      const url = buildOidcAuthorizationUrl({
        authorizationUrl: provider.authorizationUrl,
        clientId: provider.clientId,
        redirectUri: providerRedirectUri,
        scopes: this.resolveOidcScopes(provider),
        state,
        challenge: response.challenge,
        usePkce: authMode === AuthMode.AuthCodePKCE,
        authorizeParams,
        loginHint: this.loginHintForProvider(
          provider,
          params.loginHint ?? previousSession?.auth.email
        )
      });
      this.requireCurrentSessionRevision(authRevision, WalletOperation.startOidcRedirectAuth);

      return {
        authorizationUrl: url
      };
    });
  }

  /**
   * Completes an OIDC authorization-code redirect flow.
   *
   * This validates the state nonce persisted by `startOidcRedirectAuth`, completes
   * WaaS auth, and activates an existing wallet or creates a new one.
   */
  async completeOidcRedirectAuth(): Promise<
    CompleteOidcRedirectAuthResult | PendingWalletSelection | void
  >;
  async completeOidcRedirectAuth(
    params: ManualWalletSelectionParams<CompleteOidcRedirectAuthParams>
  ): Promise<PendingWalletSelection | void>;
  async completeOidcRedirectAuth(
    params: AutomaticWalletSelectionParams<CompleteOidcRedirectAuthParams>
  ): Promise<CompleteOidcRedirectAuthResult | void>;
  async completeOidcRedirectAuth(
    params: CompleteOidcRedirectAuthParams
  ): Promise<CompleteOidcRedirectAuthResult | PendingWalletSelection | void>;
  async completeOidcRedirectAuth(
    params: CompleteOidcRedirectAuthParams = {}
  ): Promise<CompleteOidcRedirectAuthResult | PendingWalletSelection | void> {
    return this.runOperation(WalletOperation.completeOidcRedirectAuth, async () => {
      const callbackUrl =
        params.callbackUrl ?? this.browserCurrentUrl('completeOidcRedirectAuth', 'callbackUrl');
      const callback = parseOidcCallbackUrl(callbackUrl);
      const hasCallbackParams = !!(callback.code || callback.state || callback.error);

      if (!hasCallbackParams && params.callbackUrl === undefined) {
        return undefined;
      }

      const redirectAuthStorage = this.requireRedirectAuthStorage();
      let shouldClearPendingRedirectAuth = false;

      try {
        if (!callback.state || (!callback.code && !callback.error)) {
          throw new Error('OIDC callback URL is missing code or state');
        }

        const pending = this.loadPendingOidcRedirectAuth(redirectAuthStorage);
        this.validateOidcState(callback.state, pending);
        if (!matchesRedirectUri(callbackUrl, pending.expectedCallbackUri)) {
          return undefined;
        }
        if (pending.consumed) {
          throw new Error('No pending OIDC redirect auth found');
        }
        this.markPendingOidcRedirectAuthConsumed(redirectAuthStorage, pending);
        shouldClearPendingRedirectAuth = true;

        if (params.cleanUrl ?? params.callbackUrl === undefined) {
          this.replaceOidcCallbackUrl(callbackUrl, params.replaceUrl);
        }

        if (callback.error) {
          throw new Error(
            callback.errorDescription || `OIDC provider returned error: ${callback.error}`
          );
        }
        if (!callback.code) {
          throw new Error('OIDC callback URL is missing code or state');
        }

        await this.validatePendingOidcRedirectSigner(
          pending,
          WalletOperation.completeOidcRedirectAuth
        );
        const walletSelection = params.walletSelection ?? pending.walletSelection ?? 'automatic';
        const sessionLifetimeSeconds = this.sessionLifetimeSeconds(
          params.sessionLifetimeSeconds ?? pending.sessionLifetimeSeconds,
          WalletOperation.completeOidcRedirectAuth
        );
        const authRevision = this.sessionRevision;

        const request: CompleteAuthRequest = {
          identityType: IdentityType.OIDC,
          authMode: toGeneratedAuthMode(pending.authMode),
          verifier: pending.verifier,
          answer: callback.code,
          lifetime: sessionLifetimeSeconds
        };
        const sentAt = Date.now();
        const response = await this.client.completeAuth(request);
        const result = await this.completeWalletAuth(
          response,
          { sentAt, lifetimeSeconds: sessionLifetimeSeconds },
          pending.walletType,
          walletSelection,
          this.oidcRedirectSessionAuthFromPending(pending, response),
          WalletOperation.completeOidcRedirectAuth,
          {
            validate: () =>
              this.requireCurrentSessionRevision(
                authRevision,
                WalletOperation.completeOidcRedirectAuth
              )
          }
        );

        if (walletSelection === 'automatic' && !this.activeWalletAccount) {
          throw new Error('OIDC auth completed without an active wallet');
        }

        return result;
      } finally {
        if (shouldClearPendingRedirectAuth) {
          try {
            this.clearPendingOidcRedirectAuth();
          } catch {
            // Auth result and primary failure take precedence over best-effort pending-state cleanup.
          }
        }
      }
    });
  }

  /**
   * Browser convenience wrapper that starts an OIDC redirect and navigates to the provider.
   */
  async signInWithOidcRedirect(params: SignInWithOidcRedirectParams): Promise<void> {
    return this.runOperation(WalletOperation.signInWithOidcRedirect, async () => {
      let result: StartOidcRedirectAuthResult;
      const isOmsRelayProvider = isOmsRelayOidcProvider(params.provider);
      if (isOmsRelayProvider && params.authorizeParams !== undefined) {
        throw new Error('OMS relay OIDC authorization parameters are fixed by the SDK');
      }
      if (!isOmsRelayProvider && params.omsRelayReturnUri !== undefined) {
        throw new Error(
          'omsRelayReturnUri is only supported for SDK built-in Google and Apple OIDC providers'
        );
      }
      if (isOmsRelayOidcProvider(params.provider)) {
        const omsRelayReturnUri =
          params.omsRelayReturnUri ??
          redirectUriFromCurrentUrl(
            params.currentUrl ?? this.browserCurrentUrl('signInWithOidcRedirect', 'currentUrl')
          );
        result = await this.startOidcRedirectAuth({
          provider: params.provider,
          omsRelayReturnUri,
          walletType: params.walletType,
          walletSelection: params.walletSelection,
          sessionLifetimeSeconds: params.sessionLifetimeSeconds,
          loginHint: params.loginHint
        });
      } else {
        result = await this.startOidcRedirectAuth({
          provider: params.provider,
          walletType: params.walletType,
          walletSelection: params.walletSelection,
          sessionLifetimeSeconds: params.sessionLifetimeSeconds,
          authorizeParams: params.authorizeParams,
          loginHint: params.loginHint
        });
      }
      const assignUrl = params.assignUrl ?? this.browserAssignUrl();
      assignUrl(result.authorizationUrl);
    });
  }

  async signOut(): Promise<void> {
    return this.runOperation(WalletOperation.signOut, () =>
      this.clearSession({ operation: WalletOperation.signOut })
    );
  }

  async listWallets(): Promise<Array<WalletAccount>> {
    return this.runOperation(WalletOperation.listWallets, async () => {
      await this.requireWalletSelectionOrActiveSession(WalletOperation.listWallets);
      return this.listAllWallets();
    });
  }

  async useWallet(params: { walletId: string }): Promise<WalletActivationResult> {
    return this.runOperation(WalletOperation.useWallet, async () => {
      const context = await this.activeWalletActivationContext(WalletOperation.useWallet);
      const wallet = await this.requestUseWallet(params.walletId);
      await this.requireActiveWalletActivationContextStillActive(
        context,
        WalletOperation.useWallet
      );
      return this.activateWallet(wallet, context.metadata, WalletOperation.useWallet, true);
    });
  }

  async claimWallet(params: { walletId: string }): Promise<WalletActivationResult> {
    return this.runOperation(WalletOperation.claimWallet, async () => {
      const context = await this.activeWalletActivationContext(WalletOperation.claimWallet);
      const wallet = await this.requestClaimWallet(params.walletId);
      await this.requireActiveWalletActivationContextStillActive(
        context,
        WalletOperation.claimWallet
      );
      return this.activateWallet(wallet, context.metadata, WalletOperation.claimWallet, true);
    });
  }

  async createWallet(
    params: { walletType?: WalletType; reference?: string } = {}
  ): Promise<WalletActivationResult> {
    return this.runOperation(WalletOperation.createWallet, async () => {
      const context = await this.activeWalletActivationContext(WalletOperation.createWallet);
      const wallet = await this.requestCreateWallet(
        params.walletType ?? WalletType.Ethereum,
        params.reference
      );
      await this.requireActiveWalletActivationContextStillActive(
        context,
        WalletOperation.createWallet
      );
      return this.activateWallet(wallet, context.metadata, WalletOperation.createWallet, true);
    });
  }

  async importWallet(params: ImportWalletParams): Promise<WalletActivationResult> {
    return this.runOperation(WalletOperation.importWallet, async () => {
      const context = await this.walletImportActivationContext(
        params.type,
        WalletOperation.importWallet
      );
      return this.runWalletImportActivation(context, WalletOperation.importWallet, async () => {
        const privateKey = walletImportPlaintext(params);
        const recipientKey = await this.getWalletImportRecipientKeyUnchecked(
          WalletImportCipherSuiteValues.P256Sha256Aes256Gcm,
          WalletOperation.importWallet
        );
        let encryptedKey: Awaited<ReturnType<typeof sealWalletImportPrivateKey>>;
        try {
          encryptedKey = await sealWalletImportPrivateKey(recipientKey.publicKey, privateKey);
        } finally {
          privateKey.fill(0);
        }
        const wallet = await this.requestImportWallet({
          walletType: params.type,
          reference: params.reference,
          keyMaterial: {
            keyId: recipientKey.keyId,
            cipherSuite: recipientKey.cipherSuite,
            ...encryptedKey
          }
        });
        await this.requireWalletImportActivationContextStillActive(
          context,
          WalletOperation.importWallet
        );
        return this.activateWallet(
          wallet,
          context.metadata,
          WalletOperation.importWallet,
          context.type === 'active'
        );
      });
    });
  }

  async getWalletImportRecipientKey(params: {
    cipherSuite: WalletImportCipherSuite;
  }): Promise<WalletImportRecipientKey> {
    return this.runOperation(WalletOperation.getWalletImportRecipientKey, () =>
      this.getWalletImportRecipientKeyUnchecked(
        params.cipherSuite,
        WalletOperation.getWalletImportRecipientKey
      )
    );
  }

  async importEncryptedWallet(
    params: ImportEncryptedWalletParams
  ): Promise<WalletActivationResult> {
    return this.runOperation(WalletOperation.importEncryptedWallet, async () => {
      const context = await this.walletImportActivationContext(
        params.walletType,
        WalletOperation.importEncryptedWallet
      );
      return this.runWalletImportActivation(
        context,
        WalletOperation.importEncryptedWallet,
        async () => {
          validateWalletImportReference(params.reference);
          const wallet = await this.requestImportWallet(params);
          await this.requireWalletImportActivationContextStillActive(
            context,
            WalletOperation.importEncryptedWallet
          );
          return this.activateWallet(
            wallet,
            context.metadata,
            WalletOperation.importEncryptedWallet,
            context.type === 'active'
          );
        }
      );
    });
  }

  async getIdToken(params: GetIdTokenParams = {}): Promise<string> {
    return this.runOperation(WalletOperation.getIdToken, async () => {
      await this.requireActiveSession(WalletOperation.getIdToken);
      const request: GetIDTokenRequest = {
        walletId: this.walletId,
        ttlSeconds: params.ttlSeconds,
        customClaims: params.customClaims
      };
      const response = await this.client.getIDToken(request);
      return response.idToken;
    });
  }

  /**
   * Ends the session in this client. `keepSharedState` leaves the stored session, pending OIDC redirect
   * state, and signer key alone because a newer session elsewhere (another tab) owns them.
   */
  private async clearSession(
    options: {
      clearStorage?: boolean;
      keepSharedState?: boolean;
      operation?: WalletOperation;
    } = {}
  ): Promise<void> {
    this.sessionRevision += 1;
    const keepSharedState = options.keepSharedState ?? false;
    const clearStorage = !keepSharedState && (options.clearStorage ?? true);
    let storageFailure: unknown;
    if (keepSharedState) {
      // Nothing shared to clean up.
    } else if (clearStorage) {
      this.latestSessionExpiredEvent = undefined;
      try {
        this.storage.delete(this.storageKeys.session);
      } catch (error) {
        storageFailure = error;
      }
      try {
        this.storage.delete(this.storageKeys.sessionActivity);
      } catch {
        // Best effort: a leftover record names this credential, so later sessions ignore it.
      }
      try {
        this.clearPendingOidcRedirectAuth();
      } catch (error) {
        storageFailure ??= error;
      }
    } else {
      try {
        this.clearPendingOidcRedirectAuth();
      } catch (error) {
        storageFailure = error;
      }
    }
    this.activeWalletAccount = undefined;
    this.sessionExpiresAt = undefined;
    this.sessionAuth = undefined;
    this.sessionSignerCredentialId = undefined;
    this.sessionSignerKeyType = undefined;
    this.sessionExpiryBounds = undefined;
    this.activePendingWalletSelection = undefined;
    this.activeEmailAuthAttempt = undefined;
    this.lastCredentialRefreshAt = undefined;
    this.lastSessionActivityAt = undefined;
    this.lastSharedSessionActivity = undefined;
    this.credentialRefreshRetryDelayMs = CREDENTIAL_REFRESH_RETRY_MIN_MS;
    this.clearSessionExpiryTimer();
    this.cancelRestoredSessionRead?.();
    this.cancelRestoredSessionRead = undefined;
    if (!keepSharedState) await this.credentialSigner.clear?.();
    if (storageFailure !== undefined) {
      throw new OMSWalletStorageError({
        operation: options.operation,
        message: 'Wallet session cleanup failed',
        cause: storageFailure
      });
    }
  }

  private clearPendingOidcRedirectAuth(): void {
    this.redirectAuthStorage?.delete(this.storageKeys.redirectAuth);
  }

  async signMessage(params: SignMessageParams): Promise<string> {
    return this.runOperation(WalletOperation.signMessage, async () => {
      await this.requireActiveEthereumSession(WalletOperation.signMessage);
      const request: SignMessageRequest = {
        network: params.network.id.toString(),
        walletId: this.walletId,
        message: params.message
      };
      const response = await this.client.signMessage(request);
      return response.signature;
    });
  }

  async signSolanaMessage(params: SignSolanaMessageParams): Promise<string> {
    return this.runOperation(WalletOperation.signSolanaMessage, async () => {
      await this.requireActiveSolanaSession(WalletOperation.signSolanaMessage);
      const request: SignMessageRequest = {
        network: '',
        walletId: this.walletId,
        message: params.message
      };
      const response = await this.client.signMessage(request);
      return response.signature;
    });
  }

  async signTypedData(params: SignTypedDataParams): Promise<string> {
    return this.runOperation(WalletOperation.signTypedData, async () => {
      await this.requireActiveEthereumSession(WalletOperation.signTypedData);
      const request: SignTypedDataRequest = {
        network: params.network.id.toString(),
        walletId: this.walletId,
        typedData: normalizeJsonBigInts(params.typedData)
      };
      const response = await this.client.signTypedData(request);
      return response.signature;
    });
  }

  async isValidMessageSignature(params: IsValidMessageSignatureParams): Promise<boolean> {
    return this.runOperation(WalletOperation.isValidMessageSignature, async () => {
      const request: IsValidMessageSignatureRequest = {
        network: params.network?.id.toString(),
        networkFamily: GeneratedNetworkFamily.EVM,
        walletAddress: await this.signatureVerificationAddress(
          params.walletAddress,
          WalletType.Ethereum,
          'Ethereum',
          WalletOperation.isValidMessageSignature
        ),
        message: params.message,
        signature: params.signature
      };
      const response = await this.publicClient.isValidMessageSignature(request);
      return response.isValid;
    });
  }

  async isValidSolanaMessageSignature(
    params: IsValidSolanaMessageSignatureParams
  ): Promise<boolean> {
    return this.runOperation(WalletOperation.isValidSolanaMessageSignature, async () => {
      const request: IsValidMessageSignatureRequest = {
        networkFamily: GeneratedNetworkFamily.Solana,
        walletAddress: await this.signatureVerificationAddress(
          params.walletAddress,
          WalletType.Solana,
          'Solana',
          WalletOperation.isValidSolanaMessageSignature
        ),
        message: params.message,
        signature: params.signature
      };
      const response = await this.publicClient.isValidMessageSignature(request);
      return response.isValid;
    });
  }

  async isValidTypedDataSignature(params: IsValidTypedDataSignatureParams): Promise<boolean> {
    return this.runOperation(WalletOperation.isValidTypedDataSignature, async () => {
      const request: IsValidTypedDataSignatureRequest = {
        network: params.network?.id.toString(),
        networkFamily: GeneratedNetworkFamily.EVM,
        walletAddress: await this.signatureVerificationAddress(
          params.walletAddress,
          WalletType.Ethereum,
          'Ethereum',
          WalletOperation.isValidTypedDataSignature
        ),
        typedData: normalizeJsonBigInts(params.typedData),
        signature: params.signature
      };
      const response = await this.publicClient.isValidTypedDataSignature(request);
      return response.isValid;
    });
  }

  async signTronMessage(params: SignTronMessageParams): Promise<string> {
    return this.runOperation(WalletOperation.signTronMessage, async () => {
      await this.requireActiveTronSession(WalletOperation.signTronMessage);
      const request: SignMessageRequest = {
        network: '',
        walletId: this.walletId,
        message: params.message
      };
      const response = await this.client.signMessage(request);
      return response.signature;
    });
  }

  async signTronTypedData(params: SignTronTypedDataParams): Promise<string> {
    return this.runOperation(WalletOperation.signTronTypedData, async () => {
      await this.requireActiveTronSession(WalletOperation.signTronTypedData);
      const request: SignTypedDataRequest = {
        network: '',
        walletId: this.walletId,
        typedData: normalizeJsonBigInts(params.typedData)
      };
      const response = await this.client.signTypedData(request);
      return response.signature;
    });
  }

  async isValidTronMessageSignature(params: IsValidTronMessageSignatureParams): Promise<boolean> {
    return this.runOperation(WalletOperation.isValidTronMessageSignature, async () => {
      const request: IsValidMessageSignatureRequest = {
        networkFamily: GeneratedNetworkFamily.Tron,
        walletAddress: await this.signatureVerificationAddress(
          params.walletAddress,
          WalletType.Tron,
          'Tron',
          WalletOperation.isValidTronMessageSignature
        ),
        message: params.message,
        signature: params.signature
      };
      const response = await this.publicClient.isValidMessageSignature(request);
      return response.isValid;
    });
  }

  async isValidTronTypedDataSignature(
    params: IsValidTronTypedDataSignatureParams
  ): Promise<boolean> {
    return this.runOperation(WalletOperation.isValidTronTypedDataSignature, async () => {
      const request: IsValidTypedDataSignatureRequest = {
        networkFamily: GeneratedNetworkFamily.Tron,
        walletAddress: await this.signatureVerificationAddress(
          params.walletAddress,
          WalletType.Tron,
          'Tron',
          WalletOperation.isValidTronTypedDataSignature
        ),
        typedData: normalizeJsonBigInts(params.typedData),
        signature: params.signature
      };
      const response = await this.publicClient.isValidTypedDataSignature(request);
      return response.isValid;
    });
  }

  async sendTransaction(params: SendNativeTransactionParams): Promise<SendTransactionResponse>;
  async sendTransaction(params: SendDataTransactionParams): Promise<SendTransactionResponse>;
  async sendTransaction<
    const abi extends Abi | readonly unknown[],
    functionName extends ContractFunctionName<abi> | undefined = ContractFunctionName<abi>
  >(params: SendContractTransactionParams<abi, functionName>): Promise<SendTransactionResponse>;
  async sendTransaction(params: SendTransactionParams): Promise<SendTransactionResponse> {
    return this.runOperation(WalletOperation.sendTransaction, async () => {
      await this.requireActiveEthereumSession(WalletOperation.sendTransaction);
      const data =
        'abi' in params ? encodeFunctionData(params as EncodeFunctionDataParameters) : params.data;

      const request: PrepareEthereumTransactionRequest = {
        network: params.network.id.toString(),
        walletId: this.walletId,
        to: params.to,
        value: (params.value ?? 0n).toString(),
        data,
        mode: toGeneratedTransactionMode(params.mode ?? TransactionMode.Relayer)
      };

      const prepared = await this.client.prepareEthereumTransaction(request);
      return this.executePreparedTransaction({
        prepared,
        network: params.network,
        selectFeeOption: params.selectFeeOption,
        waitForStatus: params.waitForStatus,
        statusPolling: params.statusPolling
      });
    });
  }

  async sendSolanaTransfer(params: SendSolanaTransferParams): Promise<SendTransactionResponse> {
    return this.runOperation(WalletOperation.sendSolanaTransfer, async () => {
      await this.requireActiveSolanaSession(WalletOperation.sendSolanaTransfer);
      const request: PrepareSolanaTransferRequest = {
        network: params.network,
        walletId: this.walletId,
        asset: params.asset,
        recipient: { address: params.to },
        amount: params.amount.toString(),
        mode: toGeneratedTransactionMode(params.mode ?? TransactionMode.Relayer)
      };

      const prepared = await this.client.prepareSolanaTransfer(request);
      return this.executePreparedTransaction({
        prepared,
        network: params.network,
        selectFeeOption: params.selectFeeOption,
        waitForStatus: params.waitForStatus,
        statusPolling: params.statusPolling
      });
    });
  }

  async sendTronTransaction(params: SendTronTransactionParams): Promise<SendTransactionResponse> {
    return this.runOperation(WalletOperation.sendTronTransaction, async () => {
      await this.requireActiveTronSession(WalletOperation.sendTronTransaction);
      // `data` is forwarded as given: omitted means a TRX transfer, while any value (even '0x')
      // makes this a contract call.
      const request: PrepareTronTransactionRequest = {
        network: params.network,
        walletId: this.walletId,
        to: params.to,
        value: (params.value ?? 0n).toString(),
        ...(params.data === undefined ? {} : { data: params.data }),
        mode: toGeneratedTransactionMode(TransactionMode.Native)
      };

      const prepared = await this.client.prepareTronTransaction(request);
      return this.executePreparedTransaction({
        prepared,
        network: params.network,
        selectFeeOption: params.selectFeeOption,
        waitForStatus: params.waitForStatus,
        statusPolling: params.statusPolling
      });
    });
  }

  async callTronContract(params: CallTronContractParams): Promise<SendTransactionResponse> {
    return this.runOperation(WalletOperation.callTronContract, async () => {
      await this.requireActiveTronSession(WalletOperation.callTronContract);
      requireContractMethodName(params.method);
      const request: PrepareTronContractCallRequest = {
        network: params.network,
        walletId: this.walletId,
        contract: params.contractAddress,
        method: params.method,
        args: params.args,
        mode: toGeneratedTransactionMode(TransactionMode.Native)
      };

      const prepared = await this.client.prepareTronContractCall(request);
      return this.executePreparedTransaction({
        prepared,
        network: params.network,
        selectFeeOption: params.selectFeeOption,
        waitForStatus: params.waitForStatus,
        statusPolling: params.statusPolling
      });
    });
  }

  async callContract(params: {
    network: Network;
    contractAddress: Address;
    method: string;
    args?: Array<AbiArg>;
    mode?: TransactionMode;
    selectFeeOption?: FeeOptionSelector;
    waitForStatus?: boolean;
    statusPolling?: TransactionStatusPollingOptions;
  }): Promise<SendTransactionResponse> {
    return this.runOperation(WalletOperation.callContract, async () => {
      await this.requireActiveEthereumSession(WalletOperation.callContract);
      requireContractMethodName(params.method);
      const request: PrepareEthereumContractCallRequest = {
        network: params.network.id.toString(),
        walletId: this.walletId,
        contract: params.contractAddress,
        method: params.method,
        args: params.args,
        mode: toGeneratedTransactionMode(params.mode ?? TransactionMode.Relayer)
      };

      const prepared = await this.client.prepareEthereumContractCall(request);
      return this.executePreparedTransaction({
        prepared,
        network: params.network,
        selectFeeOption: params.selectFeeOption,
        waitForStatus: params.waitForStatus,
        statusPolling: params.statusPolling
      });
    });
  }

  async getTransactionStatus(params: { txnId: string }): Promise<TransactionStatusResponse> {
    return this.runOperation(WalletOperation.getTransactionStatus, async () =>
      fromGeneratedTransactionStatusResponse(
        await this.client.transactionStatus({ txnId: params.txnId } as TransactionStatusRequest)
      )
    );
  }

  async inspectRemoteCredential(params: {
    credentialId: string;
  }): Promise<RemoteCredentialMetadata> {
    return this.runOperation(WalletOperation.inspectRemoteCredential, async () => {
      const response = await this.publicClient.inspectCredential({
        scope: this.projectId,
        credentialId: params.credentialId
      });
      return fromGeneratedRemoteCredentialMetadata(response.metadata);
    });
  }

  async authorizeRemoteAccess(
    params: AuthorizeRemoteAccessParams
  ): Promise<AuthorizedRemoteAccess> {
    return this.runOperation(WalletOperation.authorizeRemoteAccess, async () => {
      await this.requireActiveEthereumSession(WalletOperation.authorizeRemoteAccess);
      const walletId = this.walletId;
      const request: AuthorizeRemoteAccessRequest = {
        credentialId: params.credentialId,
        walletId,
        grants: { entries: params.grants.map(toGeneratedSmartSessionGrant) },
        expiry: params.expiresAt,
        chainId: params.network.id.toString(),
        sessionId: params.sessionId
      };
      const response = await this.client.authorizeRemoteAccess(request);
      await this.requireSameActiveWalletSession(walletId, WalletOperation.authorizeRemoteAccess);
      return {
        walletId,
        sessionId: response.sessionId,
        expiresAt: response.expiry
      };
    });
  }

  async listAccess(params: ListAccessParams = {}): Promise<AccessGrant[]> {
    return this.runOperation(WalletOperation.listAccess, async () => {
      const grants: AccessGrant[] = [];
      for await (const page of this.listAccessPagesUnchecked(params, WalletOperation.listAccess)) {
        grants.push(...page.grants);
      }
      return grants;
    });
  }

  async listAccessPage(params: ListAccessPageParams = {}): Promise<AccessGrantPage> {
    return this.runOperation(WalletOperation.listAccessPage, async () => {
      await this.requireActiveSession(WalletOperation.listAccessPage);
      const walletId = this.walletId;
      return this.requestListAccessPage(
        walletId,
        params,
        params.cursor || undefined,
        WalletOperation.listAccessPage
      );
    });
  }

  async *listAccessPages(params: ListAccessParams = {}): AsyncIterable<AccessGrantPage> {
    const revision = this.sessionRevision;
    const hadActiveSession = this.activeWalletAccount !== undefined;
    try {
      yield* this.listAccessPagesUnchecked(params, WalletOperation.listAccessPages);
    } catch (error) {
      throw await this.operationError(
        error,
        WalletOperation.listAccessPages,
        revision,
        hadActiveSession
      );
    }
  }

  async getRemoteAccessSession(params: { sessionId: string }): Promise<RemoteAccessSession> {
    return this.runOperation(WalletOperation.getRemoteAccessSession, async () => {
      await this.requireActiveSession(WalletOperation.getRemoteAccessSession);
      if (!params.sessionId.trim()) throw new Error('sessionId is required');
      const walletId = this.walletId;
      const response = await this.client.getSession({ sessionId: params.sessionId });
      await this.requireSameActiveWalletSession(walletId, WalletOperation.getRemoteAccessSession);
      const session = fromGeneratedRemoteAccessSession(response.session);
      if (session.walletId !== walletId) {
        throw new Error('Session does not belong to the active wallet');
      }
      return session;
    });
  }

  async getRemoteAccessSessionUsage(params: {
    sessionId: string;
    network: Network;
  }): Promise<SmartSessionGrantUsage[]> {
    return this.runOperation(WalletOperation.getRemoteAccessSessionUsage, async () => {
      await this.requireActiveSession(WalletOperation.getRemoteAccessSessionUsage);
      if (!params.sessionId.trim()) throw new Error('sessionId is required');
      const walletId = this.walletId;
      const response = await this.client.getSessionUsage({
        sessionId: params.sessionId,
        network: params.network.id.toString()
      });
      await this.requireSameActiveWalletSession(
        walletId,
        WalletOperation.getRemoteAccessSessionUsage
      );
      return fromGeneratedSmartSessionGrantUsages(response.entries);
    });
  }

  async revokeAccess(params: RevokeAccessParams): Promise<void> {
    return this.runOperation(WalletOperation.revokeAccess, async () => {
      await this.requireActiveSession(WalletOperation.revokeAccess);
      const request: RevokeAccessRequest = {
        targetCredentialId: params.credentialId,
        walletId: this.walletId,
        sessionId: params.sessionId
      };

      await this.client.revokeAccess(request);
    });
  }

  /**
   * Requests a new wallet of the requested type from WaaS for the authenticated user. Does not
   * activate or persist it.
   */
  private async requestCreateWallet(type: WalletType, reference?: string): Promise<WalletAccount> {
    const params: CreateWalletRequest = {
      networkFamily: toGeneratedNetworkFamily(type),
      reference
    };
    const response = await this.client.createWallet(params);
    return fromGeneratedWallet(response.wallet);
  }

  private async getWalletImportRecipientKeyUnchecked(
    cipherSuite: WalletImportCipherSuite,
    operation: WalletOperation
  ): Promise<WalletImportRecipientKey> {
    await this.requireWalletSelectionOrActiveSession(operation);
    const client = this.requireWalletImportClient();
    const response = await client.getRecipientKey({
      purpose: GeneratedTransportPurpose.WalletImport,
      suite: toGeneratedWalletImportCipherSuite(cipherSuite)
    });
    await this.requireWalletSelectionOrActiveSession(operation);
    if (!response.keyId.trim() || !response.publicKey.trim()) {
      throw new Error('Wallet import recipient-key response is incomplete');
    }
    return {
      keyId: response.keyId,
      cipherSuite,
      publicKey: requireBase64(response.publicKey, 'recipient publicKey')
    };
  }

  private async requestImportWallet(params: ImportEncryptedWalletParams): Promise<WalletAccount> {
    const client = this.requireWalletImportClient();
    if (!params.keyMaterial.keyId.trim()) throw new Error('keyMaterial.keyId is required');
    const keyMaterial: HPKEPayload = {
      keyId: params.keyMaterial.keyId,
      suite: toGeneratedWalletImportCipherSuite(params.keyMaterial.cipherSuite),
      encapsulatedKey: requireBase64(
        params.keyMaterial.encapsulatedKey,
        'keyMaterial.encapsulatedKey'
      ),
      ciphertext: requireBase64(params.keyMaterial.ciphertext, 'keyMaterial.ciphertext')
    };
    const response = await client.importWallet({
      networkFamily: toGeneratedNetworkFamily(params.walletType),
      format: GeneratedKeyFormat.PrivateKey,
      keyMaterial,
      reference: params.reference
    });
    return fromGeneratedWallet(response.wallet);
  }

  private requireWalletImportClient(): WaasClient {
    if (!this.walletImportClient) {
      throw new Error('Wallet import is unavailable for this WaaS environment');
    }
    return this.walletImportClient;
  }

  /**
   * Requests an existing wallet by its server-side ID from WaaS. Does not activate or persist it.
   */
  private async requestUseWallet(walletId: string): Promise<WalletAccount> {
    const params: UseWalletRequest = { walletId };
    const response = await this.client.useWallet(params);
    return fromGeneratedWallet(response.wallet);
  }

  /**
   * Claims a preallocated wallet for the authenticated user. WaaS grants the session credential
   * access to it. Does not activate or persist it.
   */
  private async requestClaimWallet(walletId: string): Promise<WalletAccount> {
    const params: ClaimWalletRequest = { walletId };
    const response = await this.client.claimWallet(params);
    return fromGeneratedWallet(response.wallet);
  }

  /**
   * Activates `wallet` and persists the session. `inActiveSession`: another wallet of the active
   * session is replaced. An expiry read may have moved the expiry since `metadata` was captured, so
   * the session's current expiry, bounds, and last read are kept; only the wallet changes.
   */
  private activateWallet(
    wallet: WalletAccount,
    metadata: WalletSessionMetadata,
    operation?: WalletOperation,
    inActiveSession = false
  ): WalletActivationResult {
    const current = inActiveSession ? this.currentSessionMetadata() : undefined;
    const isSameSession =
      !!current &&
      !!this.activeWalletAccount &&
      normalizeCredentialId(current.signerCredentialId) ===
        normalizeCredentialId(metadata.signerCredentialId) &&
      current.signerKeyType === metadata.signerKeyType;
    this.persistSession(wallet, isSameSession && current ? current : metadata, operation);
    this.activePendingWalletSelection = undefined;
    return { wallet: cloneWalletAccount(wallet) };
  }

  private async completeWalletAuth(
    response: CompleteAuthResponse,
    sent: CompleteAuthSent,
    walletType: WalletType,
    walletSelection: WalletSelectionBehavior,
    auth: OMSWalletSessionAuth,
    operation: WalletOperation,
    guard?: WalletAuthCommitGuard
  ): Promise<CompleteWalletAuthResult | PendingWalletSelection> {
    this.activePendingWalletSelection = undefined;

    const metadata = await this.sessionMetadataFromAuthResponse(response, sent, auth);
    const wallets = await this.listAllWalletsFromAuthResponse(response);
    // CompleteAuth is the only place WaaS reports preallocated wallets; ListWallets omits them.
    const claimableWallets = (response.claimable ?? []).map(fromGeneratedWallet);
    const credential = fromGeneratedAccessGrant(response.credential);
    const candidateWallets = wallets.filter((wallet) => wallet.type === walletType);
    const requireCurrentAuth = () => guard?.validate();

    requireCurrentAuth();

    if (walletSelection === 'manual') {
      const selection = await this.createPendingWalletSelection(
        {
          walletType,
          wallets: candidateWallets,
          claimableWallets: claimableWallets.filter((wallet) => wallet.type === walletType),
          credential,
          metadata
        },
        requireCurrentAuth
      );
      return selection;
    }

    // An owned wallet wins; otherwise claim a preallocated wallet before creating a new one.
    const wallet = candidateWallets[0];
    const claimable = wallet
      ? undefined
      : claimableWallets.find((claimableWallet) => claimableWallet.type === walletType);
    const selectedWallet = wallet
      ? await this.requestUseWallet(wallet.id)
      : claimable
        ? await this.requestClaimWallet(claimable.id)
        : await this.requestCreateWallet(walletType);
    requireCurrentAuth();
    const activated = this.activateWallet(selectedWallet, metadata, operation);
    const resultWallets = wallet ? wallets : [...wallets, activated.wallet];

    return {
      wallet: activated.wallet,
      wallets: resultWallets,
      claimableWallets: claimable
        ? claimableWallets.filter((claimableWallet) => claimableWallet.id !== claimable.id)
        : claimableWallets,
      credential
    };
  }

  private async completeEmailAuthAttempt(
    attempt: ActiveEmailAuthAttempt,
    params: EmailAuthCompletionParams
  ): Promise<CompleteEmailAuthResult | PendingWalletSelection> {
    this.requireActiveEmailAuthAttempt(attempt, WalletOperation.completeEmailAuth);
    const answer = await RequestUtils.hashEmailAuthAnswer(attempt.challenge, params.code);
    this.requireActiveEmailAuthAttempt(attempt, WalletOperation.completeEmailAuth);

    const request: CompleteAuthRequest = {
      identityType: IdentityType.Email,
      authMode: GeneratedAuthMode.OTP,
      verifier: attempt.verifier,
      answer,
      lifetime: attempt.sessionLifetimeSeconds
    };
    const sentAt = Date.now();
    const response = await this.client.completeAuth(request);
    this.requireActiveEmailAuthAttempt(attempt, WalletOperation.completeEmailAuth);
    const result = await this.completeWalletAuth(
      response,
      { sentAt, lifetimeSeconds: attempt.sessionLifetimeSeconds },
      params.walletType,
      params.walletSelection,
      this.emailSessionAuthFromResponse(response, attempt.email),
      WalletOperation.completeEmailAuth,
      {
        validate: () =>
          this.requireActiveEmailAuthAttempt(attempt, WalletOperation.completeEmailAuth)
      }
    );
    this.clearEmailAuthAttempt(attempt);
    return result;
  }

  private async *listAccessPagesUnchecked(
    params: ListAccessParams,
    operation: WalletOperation
  ): AsyncIterable<AccessGrantPage> {
    await this.requireActiveSession(operation);
    const walletId = this.walletId;

    let cursor: string | undefined;
    do {
      const page = await this.requestListAccessPage(walletId, params, cursor, operation);
      cursor = page.page?.cursor;
      yield page;
    } while (cursor);
  }

  private async requestListAccessPage(
    walletId: string,
    params: ListAccessParams,
    cursor: string | undefined,
    operation: WalletOperation
  ): Promise<AccessGrantPage> {
    await this.requireSameActiveWalletSession(walletId, operation);
    const request: ListAccessRequest = {
      walletId,
      page: this.buildListAccessPage(params.pageSize, cursor),
      type: this.toGeneratedCredentialType(params.type)
    };
    const response = await this.client.listAccess(request);
    await this.requireSameActiveWalletSession(walletId, operation);

    const grants = response.credentials.map(fromGeneratedAccessGrant);
    const limit = response.page?.limit;
    const nextCursor = response.page?.cursor || undefined;
    if (limit === undefined && nextCursor === undefined) return { grants };
    return {
      grants,
      page: {
        ...(limit === undefined ? {} : { limit }),
        ...(nextCursor === undefined ? {} : { cursor: nextCursor })
      }
    };
  }

  private buildListAccessPage(
    pageSize: number | undefined,
    cursor: string | undefined
  ): ListAccessRequest['page'] | undefined {
    if (pageSize === undefined && cursor === undefined) {
      return undefined;
    }

    return {
      limit: pageSize,
      cursor
    };
  }

  private async listAllWallets(): Promise<Array<WalletAccount>> {
    const wallets: Array<WalletAccount> = [];
    let cursor: string | undefined;
    do {
      const page = cursor ? { cursor } : undefined;
      const request: ListWalletsRequest = page ? { page } : {};
      const response = await this.client.listWallets(request);
      wallets.push(...response.wallets.map(fromGeneratedWallet));
      cursor = response.page?.cursor || undefined;
    } while (cursor);
    return wallets;
  }

  private async listAllWalletsFromAuthResponse(
    response: CompleteAuthResponse
  ): Promise<Array<WalletAccount>> {
    const wallets = response.wallets.map(fromGeneratedWallet);
    let cursor = response.page?.cursor || undefined;
    while (cursor) {
      const nextPage = await this.client.listWallets({ page: { cursor } });
      wallets.push(...nextPage.wallets.map(fromGeneratedWallet));
      cursor = nextPage.page?.cursor || undefined;
    }
    return wallets;
  }

  private toGeneratedCredentialType(type: ListAccessParams['type']): CredentialType | undefined {
    if (type === undefined) {
      return undefined;
    }
    return type === 'direct' ? CredentialType.Direct : CredentialType.Remote;
  }

  /** Saves wallet metadata. The non-extractable credential key is owned by the signer. */
  private persistSession(
    wallet: WalletAccount,
    metadata: WalletSessionMetadata,
    operation?: WalletOperation
  ): void {
    const record: StoredSessionRecord = {
      version: 2,
      scope: this.sessionScope(),
      wallet: cloneWalletAccount(wallet),
      expiresAt: metadata.expiresAt,
      auth: cloneSessionAuth(metadata.auth),
      signerCredentialId: metadata.signerCredentialId,
      signerKeyType: metadata.signerKeyType,
      ...(metadata.expiryBounds
        ? {
            idleWindowMs: metadata.expiryBounds.idleWindowMs,
            expiryCeiling: new Date(metadata.expiryBounds.expiryCeilingMs).toISOString()
          }
        : {})
    };
    // Sign-in reads the expiry; activating another wallet keeps the session's last read.
    const isActiveSessionExpiry =
      this.activeWalletAccount !== undefined && this.sessionExpiresAt === metadata.expiresAt;
    try {
      this.storage.set(this.storageKeys.session, JSON.stringify(record));
    } catch (error) {
      throw new OMSWalletStorageError({
        operation,
        message: 'Wallet session persistence failed',
        cause: error
      });
    }

    this.latestSessionExpiredEvent = undefined;
    this.activeWalletAccount = cloneWalletAccount(wallet);
    this.sessionExpiresAt = metadata.expiresAt;
    this.sessionAuth = cloneSessionAuth(metadata.auth);
    this.sessionSignerCredentialId = metadata.signerCredentialId;
    this.sessionSignerKeyType = metadata.signerKeyType;
    this.sessionExpiryBounds = metadata.expiryBounds && { ...metadata.expiryBounds };
    if (!isActiveSessionExpiry) this.lastCredentialRefreshAt = metadata.signInSentAt ?? Date.now();
    this.scheduleSessionExpiry(this.sessionFromMetadata(this.activeWalletAccount, metadata));
  }

  private loadStoredSessionRecord(): LoadedSessionRecord | undefined {
    const serialized = this.storage.get(this.storageKeys.session);
    if (!serialized) return undefined;

    try {
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      const scope = parsed.scope as Record<string, unknown> | undefined;
      const auth = normalizeSessionAuth(parsed.auth);
      const signerCredentialId = parsed.signerCredentialId;
      const signerKeyType = parsed.signerKeyType;
      const wallet = parseStoredWalletAccount(parsed.wallet);
      // Version 1 records (SDK 0.3.x) carry no wallet type; they are discarded and the user signs in again.
      if (
        parsed.version !== 2 ||
        !wallet ||
        typeof parsed.expiresAt !== 'string' ||
        typeof signerCredentialId !== 'string' ||
        !isCredentialSigningAlgorithm(signerKeyType) ||
        !scope ||
        typeof scope.projectId !== 'string' ||
        typeof scope.walletApiUrl !== 'string' ||
        typeof scope.indexerGatewayUrl !== 'string' ||
        !auth
      ) {
        this.storage.delete(this.storageKeys.session);
        return undefined;
      }

      const expectedScope = this.sessionScope();
      if (
        scope.projectId !== expectedScope.projectId ||
        scope.walletApiUrl !== expectedScope.walletApiUrl ||
        scope.indexerGatewayUrl !== expectedScope.indexerGatewayUrl
      ) {
        this.storage.delete(this.storageKeys.session);
        return undefined;
      }

      // Records without the expiry bounds (pre-release 0.4.0 builds) are discarded too.
      const expiryBounds = storedSessionExpiryBounds(parsed);
      if (!expiryBounds) {
        this.storage.delete(this.storageKeys.session);
        return undefined;
      }
      return {
        serialized,
        record: {
          version: 2,
          scope: expectedScope,
          wallet,
          expiresAt: parsed.expiresAt,
          auth,
          signerCredentialId,
          signerKeyType,
          idleWindowMs: expiryBounds.idleWindowMs,
          expiryCeiling: new Date(expiryBounds.expiryCeilingMs).toISOString()
        }
      };
    } catch {
      this.storage.delete(this.storageKeys.session);
      return undefined;
    }
  }

  private sessionScope(): StoredSessionRecord['scope'] {
    return {
      projectId: this.projectId,
      walletApiUrl: this.environment.walletApiUrl,
      indexerGatewayUrl: this.environment.indexerGatewayUrl
    };
  }

  private currentSessionMetadata(): WalletSessionMetadata | undefined {
    if (
      !this.sessionExpiresAt ||
      !this.sessionAuth ||
      !this.sessionSignerCredentialId ||
      !this.sessionSignerKeyType
    )
      return undefined;
    return {
      expiresAt: this.sessionExpiresAt,
      auth: cloneSessionAuth(this.sessionAuth),
      signerCredentialId: this.sessionSignerCredentialId,
      signerKeyType: this.sessionSignerKeyType,
      ...(this.sessionExpiryBounds ? { expiryBounds: { ...this.sessionExpiryBounds } } : {})
    };
  }

  private async activeWalletActivationContext(
    operation: WalletOperation
  ): Promise<ActiveWalletActivationContext> {
    await this.requireActiveSession(operation);
    const metadata = this.currentSessionMetadata();
    if (!metadata) {
      throw new OMSWalletSessionError({
        operation,
        message: 'No active wallet session'
      });
    }
    return {
      walletId: this.walletId,
      metadata
    };
  }

  private async walletImportActivationContext(
    walletType: WalletType,
    operation: WalletOperation
  ): Promise<WalletImportActivationContext> {
    const pending = this.activePendingWalletSelection;
    if (pending) {
      if (pending.walletType !== walletType) {
        throw new Error(`Pending wallet selection requires a ${pending.walletType} wallet`);
      }
      return {
        type: 'pending',
        selectionId: pending.id,
        metadata: pending.metadata
      };
    }

    const active = await this.activeWalletActivationContext(operation);
    return { type: 'active', ...active };
  }

  private async runWalletImportActivation<T>(
    context: WalletImportActivationContext,
    operation: WalletOperation,
    action: () => Promise<T>
  ): Promise<T> {
    if (context.type === 'active') {
      return action();
    }

    const pending = this.activePendingWalletSelection;
    if (!pending || pending.id !== context.selectionId) {
      throw new OMSWalletSelectionError({
        code: 'OMS_WALLET_SELECTION_STALE',
        operation,
        message: 'Pending wallet selection is no longer active'
      });
    }
    return this.runPendingWalletSelectionAction(pending, operation, action);
  }

  private async requireWalletImportActivationContextStillActive(
    context: WalletImportActivationContext,
    operation: WalletOperation
  ): Promise<void> {
    if (context.type === 'active') {
      await this.requireActiveWalletActivationContextStillActive(context, operation);
      return;
    }
    const pending = this.activePendingWalletSelection;
    if (!pending || pending.id !== context.selectionId) {
      throw new OMSWalletSelectionError({
        code: 'OMS_WALLET_SELECTION_STALE',
        operation,
        message: 'Pending wallet selection is no longer active'
      });
    }
    await this.requireActivePendingWalletSelection(pending, operation);
  }

  private async requireActiveWalletActivationContextStillActive(
    context: ActiveWalletActivationContext,
    operation: WalletOperation
  ): Promise<void> {
    await this.requireSameActiveWalletSession(context.walletId, operation);
  }

  private async requireSameActiveWalletSession(
    walletId: string,
    operation: WalletOperation
  ): Promise<void> {
    await this.requireActiveSession(operation);
    if (this.walletId !== walletId) {
      throw new OMSWalletSessionError({
        operation,
        message: 'Active wallet session changed'
      });
    }
  }

  private async requireWalletSelectionOrActiveSession(operation: WalletOperation): Promise<void> {
    if (this.activePendingWalletSelection) {
      await this.requireActivePendingWalletSelection(this.activePendingWalletSelection, operation);
      return;
    }

    if (this.walletId) {
      await this.requireActiveSession(operation);
      return;
    }

    throw new OMSWalletSessionError({
      operation,
      message: 'No authenticated wallet session'
    });
  }

  private currentEmailAuthAttempt(operation: WalletOperation): ActiveEmailAuthAttempt {
    if (!this.activeEmailAuthAttempt) {
      throw new OMSWalletSessionError({
        operation,
        message: 'No pending email auth attempt'
      });
    }

    return this.activeEmailAuthAttempt;
  }

  private requireActiveEmailAuthAttempt(
    attempt: ActiveEmailAuthAttempt,
    operation: WalletOperation
  ): void {
    if (this.activeEmailAuthAttempt !== attempt) {
      throw new OMSWalletSessionError({
        operation,
        message: 'Email auth attempt is no longer active'
      });
    }
  }

  private clearEmailAuthAttempt(attempt: ActiveEmailAuthAttempt | undefined): void {
    if (attempt && this.activeEmailAuthAttempt === attempt) {
      this.activeEmailAuthAttempt = undefined;
    }
  }

  private async createPendingWalletSelection(
    params: {
      walletType: WalletType;
      wallets: Array<WalletAccount>;
      claimableWallets: Array<WalletAccount>;
      credential: WalletCredential;
      metadata: WalletSessionMetadata;
    },
    beforeCommit?: () => void
  ): Promise<PendingWalletSelection> {
    const signerCredentialId = await this.credentialSigner.credentialId();
    beforeCommit?.();
    const selectionSession: ActivePendingWalletSelection = {
      id: `pending-${this.nextPendingWalletSelectionId++}`,
      inFlight: false,
      signerCredentialId,
      signerKeyType: this.credentialSigner.signingAlgorithm,
      walletType: params.walletType,
      metadata: params.metadata
    };
    this.activePendingWalletSelection = selectionSession;
    this.scheduleSessionExpiry(this.sessionFromMetadata(undefined, params.metadata));

    const wallets = params.wallets.map((wallet) => ({ ...wallet }));
    const claimableWallets = params.claimableWallets.map((wallet) => ({ ...wallet }));
    const credential = { ...params.credential };

    return new PendingWalletSelectionImpl(
      params.walletType,
      wallets,
      claimableWallets,
      credential,
      async (walletId) => {
        const operation = WalletOperation.pendingWalletSelectionSelectWallet;
        await this.requireActivePendingWalletSelection(selectionSession, operation);
        const wallet = await this.requestUseWallet(walletId);
        await this.requireActivePendingWalletSelection(selectionSession, operation);
        return this.activateWallet(wallet, selectionSession.metadata, operation);
      },
      async (reference) => {
        const operation = WalletOperation.pendingWalletSelectionCreateAndSelectWallet;
        await this.requireActivePendingWalletSelection(selectionSession, operation);
        const wallet = await this.requestCreateWallet(selectionSession.walletType, reference);
        await this.requireActivePendingWalletSelection(selectionSession, operation);
        return this.activateWallet(wallet, selectionSession.metadata, operation);
      },
      async (walletId) => {
        const operation = WalletOperation.pendingWalletSelectionClaimAndSelectWallet;
        await this.requireActivePendingWalletSelection(selectionSession, operation);
        const wallet = await this.requestClaimWallet(walletId);
        await this.requireActivePendingWalletSelection(selectionSession, operation);
        return this.activateWallet(wallet, selectionSession.metadata, operation);
      },
      (operation, action) =>
        this.runPendingWalletSelectionAction(selectionSession, operation, action)
    );
  }

  private async runPendingWalletSelectionAction<T>(
    selectionSession: ActivePendingWalletSelection,
    operation: WalletOperation,
    action: () => Promise<T>
  ): Promise<T> {
    if (selectionSession.inFlight) {
      throw new OMSWalletSelectionError({
        code: 'OMS_WALLET_SELECTION_IN_FLIGHT',
        operation,
        message: 'Pending wallet selection already has an action in flight'
      });
    }

    await this.requireActivePendingWalletSelection(selectionSession, operation);
    if (selectionSession.inFlight) {
      throw new OMSWalletSelectionError({
        code: 'OMS_WALLET_SELECTION_IN_FLIGHT',
        operation,
        message: 'Pending wallet selection already has an action in flight'
      });
    }

    selectionSession.inFlight = true;
    try {
      return await action();
    } catch (error) {
      throw toOMSWalletError(error, operation);
    } finally {
      selectionSession.inFlight = false;
    }
  }

  private async requireActivePendingWalletSelection(
    selectionSession: ActivePendingWalletSelection,
    operation: WalletOperation
  ): Promise<void> {
    if (this.activePendingWalletSelection?.id !== selectionSession.id) {
      throw new OMSWalletSelectionError({
        code: 'OMS_WALLET_SELECTION_STALE',
        operation,
        message: 'Pending wallet selection is no longer active'
      });
    }

    const session = this.sessionFromMetadata(undefined, selectionSession.metadata);
    if (this.isSessionExpired(session)) {
      await this.expireSession(session);
      throw new OMSWalletSessionError({
        code: 'OMS_SESSION_EXPIRED',
        operation,
        message: 'Wallet session expired'
      });
    }

    if (this.credentialSigner.hasCredential && !(await this.credentialSigner.hasCredential())) {
      this.activePendingWalletSelection = undefined;
      throw new OMSWalletSessionError({
        operation,
        message: 'No active credential'
      });
    }

    const signerCredentialId = await this.credentialSigner.credentialId();
    if (
      normalizeCredentialId(signerCredentialId) !==
        normalizeCredentialId(selectionSession.signerCredentialId) ||
      this.credentialSigner.signingAlgorithm !== selectionSession.signerKeyType
    ) {
      throw new OMSWalletSelectionError({
        code: 'OMS_WALLET_SELECTION_STALE',
        operation,
        message: 'Pending wallet selection is no longer active'
      });
    }

    if (this.activePendingWalletSelection?.id !== selectionSession.id) {
      throw new OMSWalletSelectionError({
        code: 'OMS_WALLET_SELECTION_STALE',
        operation,
        message: 'Pending wallet selection is no longer active'
      });
    }
  }

  private async sessionMetadataFromAuthResponse(
    response: CompleteAuthResponse,
    sent: CompleteAuthSent,
    auth: OMSWalletSessionAuth
  ): Promise<WalletSessionMetadata> {
    const expiryBounds = signInExpiryBounds(response.credential.expiresAt, sent);
    return {
      expiresAt: response.credential.expiresAt,
      auth,
      signerCredentialId: await this.credentialSigner.credentialId(),
      signerKeyType: this.credentialSigner.signingAlgorithm,
      ...(expiryBounds ? { expiryBounds } : {}),
      signInSentAt: sent.sentAt
    };
  }

  private emailSessionAuthFromResponse(
    response: CompleteAuthResponse,
    requestedEmail: string
  ): OMSWalletEmailSessionAuth {
    return {
      type: 'email',
      email: response.email ?? requestedEmail
    };
  }

  private oidcIdTokenSessionAuthFromParams(
    params: SignInWithOidcIdTokenParams,
    response: CompleteAuthResponse
  ): OMSWalletOidcSessionAuth {
    const issuer = response.identity.iss || params.issuer;
    return {
      type: 'oidc',
      flow: 'id-token',
      issuer,
      provider: params.provider ?? builtInOidcProviderForIssuer(issuer),
      providerLabel: params.providerLabel ?? builtInOidcProviderLabelForIssuer(issuer),
      email: response.email
    };
  }

  private oidcRedirectSessionAuthFromPending(
    pending: PendingOidcRedirectAuth,
    response: CompleteAuthResponse
  ): OMSWalletOidcSessionAuth {
    const issuer = response.identity.iss || pending.issuer;
    return {
      type: 'oidc',
      flow: 'redirect',
      issuer,
      provider: pending.provider ?? builtInOidcProviderForIssuer(issuer),
      providerLabel: pending.providerLabel ?? builtInOidcProviderLabelForIssuer(issuer),
      email: response.email
    };
  }

  private resolveOidcScopes(provider: ResolvedOidcProviderConfig): string[] {
    return provider.scopes ? [...provider.scopes] : [];
  }

  private resolveOidcAuthMode(provider: ResolvedOidcProviderConfig): OidcAuthMode {
    return provider.authMode ?? AuthMode.AuthCodePKCE;
  }

  private sessionProviderFromOidcProvider(
    provider: ResolvedOidcProviderConfig
  ): string | undefined {
    return provider.provider ?? builtInOidcProviderForIssuer(provider.issuer);
  }

  private sessionProviderLabelFromOidcProvider(
    provider: ResolvedOidcProviderConfig
  ): string | undefined {
    return provider.providerLabel ?? builtInOidcProviderLabelForIssuer(provider.issuer);
  }

  private derivedOmsRelayRedirectUri(relayProvider: 'google' | 'apple'): string {
    return `${this.environment.walletApiUrl.replace(/\/+$/, '')}/auth/waas/callback/${relayProvider}`;
  }

  private requireRedirectAuthStorage(): StorageManager {
    if (!this.redirectAuthStorage) {
      throw new Error('OIDC redirect auth requires redirectAuthStorage or browser sessionStorage');
    }
    return this.redirectAuthStorage;
  }

  private savePendingOidcRedirectAuth(
    storage: StorageManager,
    pending: PendingOidcRedirectAuth
  ): void {
    try {
      storage.set(this.storageKeys.redirectAuth, JSON.stringify(pending));
    } catch (error) {
      throw new OMSWalletStorageError({
        operation: WalletOperation.startOidcRedirectAuth,
        message: 'OIDC redirect auth state persistence failed',
        cause: error
      });
    }
  }

  private loadPendingOidcRedirectAuth(storage: StorageManager): PendingOidcRedirectAuth {
    const stored = storage.get(this.storageKeys.redirectAuth);
    if (!stored) {
      throw new Error('No pending OIDC redirect auth found');
    }

    try {
      const parsed = JSON.parse(stored) as Partial<PendingOidcRedirectAuth>;
      const signerKeyType = parsed.signerKeyType;
      if (
        typeof parsed.verifier !== 'string' ||
        typeof parsed.nonce !== 'string' ||
        !isOidcAuthMode(parsed.authMode) ||
        !isWalletType(parsed.walletType) ||
        typeof parsed.signerCredentialId !== 'string' ||
        !isCredentialSigningAlgorithm(signerKeyType) ||
        typeof parsed.expectedCallbackUri !== 'string' ||
        typeof parsed.issuer !== 'string' ||
        typeof parsed.projectId !== 'string' ||
        (parsed.consumed !== undefined && typeof parsed.consumed !== 'boolean')
      ) {
        throw new Error('Pending OIDC redirect auth is invalid');
      }

      return {
        verifier: parsed.verifier,
        nonce: parsed.nonce,
        authMode: parsed.authMode,
        provider: typeof parsed.provider === 'string' ? parsed.provider : undefined,
        providerLabel: typeof parsed.providerLabel === 'string' ? parsed.providerLabel : undefined,
        walletType: parsed.walletType,
        walletSelection: isWalletSelectionBehavior(parsed.walletSelection)
          ? parsed.walletSelection
          : undefined,
        sessionLifetimeSeconds:
          typeof parsed.sessionLifetimeSeconds === 'number'
            ? parsed.sessionLifetimeSeconds
            : undefined,
        signerCredentialId: parsed.signerCredentialId,
        signerKeyType,
        expectedCallbackUri: parsed.expectedCallbackUri,
        issuer: parsed.issuer,
        projectId: parsed.projectId,
        consumed: parsed.consumed
      };
    } catch (error) {
      throw new Error('Pending OIDC redirect auth is invalid', { cause: error });
    }
  }

  private markPendingOidcRedirectAuthConsumed(
    storage: StorageManager,
    pending: PendingOidcRedirectAuth
  ): void {
    try {
      storage.set(this.storageKeys.redirectAuth, JSON.stringify({ ...pending, consumed: true }));
    } catch (error) {
      throw new OMSWalletStorageError({
        operation: WalletOperation.completeOidcRedirectAuth,
        message: 'OIDC redirect auth state consumption failed',
        cause: error
      });
    }
  }

  private validateOidcState(encodedState: string, pending: PendingOidcRedirectAuth): void {
    const state = decodeOidcState(encodedState);
    if (state.nonce !== pending.nonce) {
      throw new Error('OIDC state nonce mismatch');
    }
    if (state.scope !== pending.projectId) {
      throw new Error('OIDC state scope mismatch');
    }
    if (state.redirect_uri !== undefined && state.redirect_uri !== pending.expectedCallbackUri) {
      throw new Error('OIDC state redirect_uri mismatch');
    }
  }

  private async validatePendingOidcRedirectSigner(
    pending: PendingOidcRedirectAuth,
    operation: WalletOperation
  ): Promise<void> {
    if (this.credentialSigner.hasCredential && !(await this.credentialSigner.hasCredential())) {
      throw new OMSWalletSessionError({
        operation,
        message: 'No active credential'
      });
    }

    const signerCredentialId = await this.credentialSigner.credentialId();
    if (
      normalizeCredentialId(signerCredentialId) !==
        normalizeCredentialId(pending.signerCredentialId) ||
      this.credentialSigner.signingAlgorithm !== pending.signerKeyType
    ) {
      throw new OMSWalletSessionError({
        operation,
        message: 'OIDC redirect auth signer mismatch'
      });
    }
  }

  private replaceOidcCallbackUrl(callbackUrl: string, replaceUrl?: (url: string) => void): void {
    const cleanUrl = cleanOidcCallbackUrl(callbackUrl);
    if (replaceUrl) {
      replaceUrl(cleanUrl);
      return;
    }

    if (typeof window === 'undefined' || !window.history?.replaceState) {
      throw new Error('cleanUrl requires replaceUrl or browser history support');
    }

    window.history.replaceState({}, '', cleanUrl);
  }

  private browserCurrentUrl(operation: string, requiredParam: string): string {
    if (typeof window === 'undefined') {
      throw new Error(`${operation} requires ${requiredParam} outside a browser`);
    }
    return window.location.href;
  }

  private browserAssignUrl(): (url: string) => void {
    if (typeof window === 'undefined') {
      throw new Error('signInWithOidcRedirect requires assignUrl outside a browser');
    }
    return (url: string) => window.location.assign(url);
  }

  private async executePreparedTransaction(params: {
    prepared: PrepareResponse;
    network?: Network | SolanaNetwork | TronNetwork;
    selectFeeOption?: FeeOptionSelector;
    waitForStatus?: boolean;
    statusPolling?: TransactionStatusPollingOptions;
  }): Promise<SendTransactionResponse> {
    if (params.waitForStatus !== false) {
      this.validateTransactionStatusPollingOptions(params.statusPolling);
    }
    const feeOption = await this.selectFeeOption({
      feeOptions: params.prepared.feeOptions,
      sponsored: params.prepared.sponsored,
      network: params.network,
      selectFeeOption: params.selectFeeOption
    });
    const request: ExecuteRequest = { txnId: params.prepared.txnId };
    if (feeOption) {
      request.feeOption = toGeneratedFeeOptionSelection(feeOption);
    }

    let executed: ExecuteResponse;
    const revision = this.sessionRevision;
    // Records whether the Execute request reached `fetch`; it aborts with nothing else.
    const executeSignal = new AbortController().signal;
    try {
      executed = await this.client.execute(request, undefined, executeSignal);
    } catch (error) {
      const sdkError = toOMSWalletError(error, WalletOperation.execute);
      if (!wasRequestSent(executeSignal)) {
        // The request never left this client: it timed out at a request gate or while it was
        // signed, or signing failed. Nothing was submitted, so report the request failure as is.
        throw sdkError;
      }
      if (isCredentialEndedError(sdkError) && this.rejectedSessionCredentialRevision === revision) {
        // WaaS rejected the session credential before running Execute, so nothing was submitted;
        // the operation maps this to `OMS_SESSION_EXPIRED` and ends the session.
        throw error;
      }
      if (sdkError.upstreamError?.service === 'waas' && sdkError.upstreamError.code === '7314') {
        // TransactionSimulationFailed: the relayer refused to dispatch a reverting transaction and
        // WaaS closed it as failed, so the outcome is known; report the request failure as is.
        throw sdkError;
      }
      if (
        sdkError.upstreamError?.service === 'waas' &&
        EXECUTE_REFUSED_BEFORE_SUBMISSION_CODES.has(sdkError.upstreamError.code ?? '')
      ) {
        // WaaS refused the Execute before submitting anything: its credential middleware
        // (InvalidSignature 7201, UsageLimitExceeded 7205, PreconditionFailed 7206 after the
        // stale-nonce resends, Unauthorized 7207 for a revoked credential), or the handler's checks
        // before submission (Unauthorized 7207). Report the request failure as is.
        throw sdkError;
      }
      if (
        typeof params.network === 'string' &&
        isTronNetwork(params.network) &&
        sdkError.upstreamError?.service === 'waas' &&
        TRON_EXECUTE_REFUSED_BEFORE_SUBMISSION_CODES.has(sdkError.upstreamError.code ?? '')
      ) {
        // A Tron Execute refused while WaaS priced it again, before anything was broadcast.
        throw sdkError;
      }
      throw new OMSWalletTransactionError({
        code: 'OMS_TRANSACTION_EXECUTION_UNCONFIRMED',
        operation: WalletOperation.execute,
        txnId: params.prepared.txnId,
        status: sdkError.status,
        retryable: false,
        upstreamError: sdkError.upstreamError,
        cause: sdkError,
        message: 'Transaction execution failed before status could be confirmed'
      });
    }

    if (params.waitForStatus === false) {
      return {
        txnId: params.prepared.txnId,
        status: fromGeneratedTransactionStatus(executed.status),
        statusResolution: 'not-requested'
      };
    }

    let polledStatus: PolledTransactionStatus;
    try {
      polledStatus = await this.waitForTransactionStatus(
        params.prepared.txnId,
        executed.status,
        params.statusPolling
      );
    } catch (error) {
      const sdkError = toOMSWalletError(error, WalletOperation.transactionStatus);
      throw new OMSWalletTransactionError({
        operation: WalletOperation.transactionStatus,
        txnId: params.prepared.txnId,
        status: sdkError.status,
        retryable: true,
        upstreamError: sdkError.upstreamError,
        cause: sdkError,
        message: 'Transaction was submitted, but status polling failed'
      });
    }

    return {
      txnId: params.prepared.txnId,
      status: polledStatus.response.status,
      txnHash: polledStatus.response.txnHash,
      statusResolution: polledStatus.resolution
    };
  }

  private async selectFeeOption(params: {
    feeOptions: GeneratedFeeOption[];
    sponsored: boolean;
    network?: Network | SolanaNetwork | TronNetwork;
    selectFeeOption?: FeeOptionSelector;
  }): Promise<FeeOptionSelection | undefined> {
    if (params.sponsored) {
      await params.selectFeeOption?.([]);
      return undefined;
    }

    if (params.feeOptions.length === 0) {
      throw new Error('No fee options available for unsponsored transaction');
    }

    const feeOptions = params.feeOptions.map(fromGeneratedFeeOption);
    if (!params.selectFeeOption) {
      return this.defaultFeeOptionSelection(feeOptions);
    }

    const options = params.network
      ? await this.enrichFeeOptionsWithBalances(params.network, feeOptions)
      : feeOptions.map((feeOption, index) => ({
          feeOption,
          selection: feeOptionSelection(feeOption, index)
        }));
    const selected = await params.selectFeeOption(options);
    if (!selected) {
      throw new Error('No fee option selected for unsponsored transaction');
    }
    return selected;
  }

  private async enrichFeeOptionsWithBalances(
    network: Network | SolanaNetwork | TronNetwork,
    feeOptions: FeeOption[]
  ): Promise<FeeOptionWithBalance[]> {
    if (typeof network === 'string') {
      return isTronNetwork(network)
        ? this.enrichTronFeeOptionsWithBalances(network, feeOptions)
        : this.enrichSolanaFeeOptionsWithBalances(network, feeOptions);
    }

    const walletAddress = this.activeWalletAccount?.address;
    if (!walletAddress) {
      throw new Error('No active wallet session');
    }

    const contractAddresses = Array.from(
      new Set(
        feeOptions
          .map((option) => this.normalizeAddress(option.token.contractAddress))
          .filter((address): address is string => Boolean(address))
      )
    );
    const balances = await this.indexerClient
      .getBalances({
        networks: [network],
        contractAddresses,
        walletAddress,
        includeMetadata: false
      })
      .catch(() => undefined);
    const nativeBalance = feeOptions.some((option) => this.isNativeToken(option))
      ? balances?.nativeBalances.find((balance) => balance.chainId === network.id)
      : undefined;
    const tokenBalances = new Map<string, TokenBalance | undefined>(
      contractAddresses.map((contractAddress) => [
        contractAddress,
        balances?.balances.find(
          (balance) => this.normalizeAddress(balance.contractAddress) === contractAddress
        )
      ])
    );

    return feeOptions.map((feeOption, index) => {
      const balance = this.isNativeToken(feeOption)
        ? nativeBalance
        : tokenBalances.get(this.normalizeAddress(feeOption.token.contractAddress) ?? '');
      const decimals = this.balanceDecimals(feeOption);

      return {
        feeOption,
        selection: feeOptionSelection(feeOption, index),
        balance,
        available: this.formatTokenAmount(balance?.balance, decimals),
        availableRaw: balance?.balance,
        decimals
      };
    });
  }

  private enrichSolanaFeeOptionsWithBalances(
    network: SolanaNetwork,
    feeOptions: FeeOption[]
  ): Promise<FeeOptionWithBalance[]> {
    return this.enrichGatewayFeeOptionsWithBalances(
      feeOptions,
      async (walletAddress, tokenAddresses, omitNativeBalances) => {
        const result = await this.indexerClient.getSolanaBalances({
          networks: [network],
          walletAddress,
          mintAddresses: tokenAddresses,
          includeMetadata: false,
          omitNativeBalances
        });
        return result.balances
          .filter((balance) => balance.network === network)
          .map((balance) => ({ ...balance, tokenAddress: balance.mintAddress }));
      }
    );
  }

  private enrichTronFeeOptionsWithBalances(
    network: TronNetwork,
    feeOptions: FeeOption[]
  ): Promise<FeeOptionWithBalance[]> {
    return this.enrichGatewayFeeOptionsWithBalances(
      feeOptions,
      async (walletAddress, tokenAddresses, omitNativeBalances) => {
        const result = await this.indexerClient.getTronBalances({
          networks: [network],
          walletAddress,
          contractAddresses: tokenAddresses,
          includeMetadata: false,
          omitNativeBalances
        });
        return result.balances
          .filter((balance) => balance.network === network)
          .map((balance) => ({ ...balance, tokenAddress: balance.contractAddress }));
      }
    );
  }

  /**
   * Shared by the Solana and Tron families: `fetchBalances` returns the network's balances, with
   * `tokenAddress` set to the mint or contract address of fungible-token entries.
   */
  private async enrichGatewayFeeOptionsWithBalances(
    feeOptions: FeeOption[],
    fetchBalances: (
      walletAddress: string,
      tokenAddresses: string[],
      omitNativeBalances: boolean
    ) => Promise<
      Array<{
        assetType: 'native' | 'fungible-token';
        tokenAddress: string | undefined;
        balance: string;
        decimals: number;
      }>
    >
  ): Promise<FeeOptionWithBalance[]> {
    const walletAddress = this.activeWalletAccount?.address;
    if (!walletAddress) {
      throw new Error('No active wallet session');
    }

    const tokenAddresses = Array.from(
      new Set(
        feeOptions
          .filter((option) => !this.isNativeToken(option))
          .map((option) => option.token.contractAddress?.trim())
          .filter((address): address is string => Boolean(address))
      )
    );
    const balances = await fetchBalances(
      walletAddress,
      tokenAddresses,
      !feeOptions.some((option) => this.isNativeToken(option))
    ).catch(() => undefined);
    const nativeBalance = balances?.find((balance) => balance.assetType === 'native');
    const balancesByToken = new Map(
      balances
        ?.filter((balance) => balance.assetType === 'fungible-token')
        .map((balance) => [balance.tokenAddress, balance]) ?? []
    );

    return feeOptions.map((feeOption, index) => {
      const balance = this.isNativeToken(feeOption)
        ? nativeBalance
        : balancesByToken.get(feeOption.token.contractAddress?.trim() ?? '');
      const decimals = balance?.decimals ?? feeOption.token.decimals;

      return {
        feeOption,
        selection: feeOptionSelection(feeOption, index),
        available: this.formatTokenAmount(balance?.balance, decimals),
        availableRaw: balance?.balance,
        decimals
      };
    });
  }

  private defaultFeeOptionSelection(feeOptions: FeeOption[]): FeeOptionSelection {
    return feeOptionSelection(feeOptions[0], 0);
  }

  private async waitForTransactionStatus(
    txnId: string,
    fallbackStatus: ExecuteResponse['status'],
    options: TransactionStatusPollingOptions = {}
  ): Promise<PolledTransactionStatus> {
    const timeoutMs = options.timeoutMs ?? this.transactionStatusPollTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    let lastStatus: TransactionStatusResponse = {
      status: fromGeneratedTransactionStatus(fallbackStatus)
    };
    let completedPolls = 0;

    do {
      if (completedPolls > 0 && Date.now() >= deadline) {
        return { response: lastStatus, resolution: 'timed-out' };
      }
      lastStatus = fromGeneratedTransactionStatusResponse(
        await this.client.transactionStatus({ txnId } as TransactionStatusRequest)
      );
      completedPolls += 1;
      if (
        lastStatus.status === TransactionStatus.Executed ||
        lastStatus.status === TransactionStatus.Failed ||
        lastStatus.txnHash
      ) {
        return { response: lastStatus, resolution: 'resolved' };
      }
      const pollDelayMs = this.transactionStatusPollDelayMs(completedPolls, options);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return { response: lastStatus, resolution: 'timed-out' };
      }
      await this.delay(Math.min(pollDelayMs, remainingMs));
    } while (true);
  }

  private transactionStatusPollDelayMs(
    completedPolls: number,
    options: TransactionStatusPollingOptions = {}
  ): number {
    const fastPollCount = options.fastPollCount ?? this.fastTransactionStatusPollCount;
    return completedPolls < fastPollCount
      ? (options.fastIntervalMs ?? this.fastTransactionStatusPollIntervalMs)
      : (options.intervalMs ?? this.transactionStatusPollIntervalMs);
  }

  private validateTransactionStatusPollingOptions(
    options: TransactionStatusPollingOptions = {}
  ): void {
    this.requireFinitePollingNumber('timeoutMs', options.timeoutMs, { minimum: 0 });
    this.requireFinitePollingNumber('intervalMs', options.intervalMs, {
      minimum: 0,
      exclusive: true
    });
    this.requireFinitePollingNumber('fastIntervalMs', options.fastIntervalMs, {
      minimum: 0,
      exclusive: true
    });
    this.requireFinitePollingNumber('fastPollCount', options.fastPollCount, {
      minimum: 0,
      integer: true
    });
  }

  private requireFinitePollingNumber(
    name: string,
    value: number | undefined,
    constraints: { minimum: number; exclusive?: boolean; integer?: boolean }
  ): void {
    if (value === undefined) return;
    const belowMinimum = constraints.exclusive
      ? value <= constraints.minimum
      : value < constraints.minimum;
    if (
      !Number.isFinite(value) ||
      belowMinimum ||
      (constraints.integer && !Number.isInteger(value))
    ) {
      const comparison = constraints.exclusive ? 'greater than' : 'at least';
      const integer = constraints.integer ? ' integer' : '';
      throw new Error(
        `${name} must be a finite${integer} value ${comparison} ${constraints.minimum}`
      );
    }
  }

  private async requireActiveSession(
    operation: WalletOperation,
    { requireCredential = true }: { requireCredential?: boolean } = {}
  ): Promise<void> {
    const session = this.activeSessionSnapshot();
    if (!session) {
      throw new OMSWalletSessionError({
        operation,
        message: 'No active wallet session'
      });
    }
    if (this.isSessionExpired(session)) {
      await this.refreshLocallyExpiredSession(operation);
    }
    if (!requireCredential) return;

    const revision = this.sessionRevision;
    if (!(await this.sessionSignerMatches())) {
      // An expiry refresh may have found the mismatch and cleared the session meanwhile.
      if (this.sessionRevision === revision) await this.clearSessionWithMismatchedSigner(operation);
      throw new OMSWalletSessionError({
        operation,
        message: 'No active wallet session'
      });
    }
  }

  /**
   * Whether the credential signer still holds the key the session signed in with. The key can be
   * removed or replaced outside this client, for example by a sign-in in another tab.
   */
  private async sessionSignerMatches(): Promise<boolean> {
    if (this.credentialSigner.hasCredential && !(await this.credentialSigner.hasCredential())) {
      return false;
    }

    const signerCredentialId: unknown = await this.credentialSigner.credentialId();
    // A custom signer may report no credential: that is not the session's key.
    if (typeof signerCredentialId !== 'string' || !signerCredentialId) return false;
    return (
      !!this.sessionSignerCredentialId &&
      !!this.sessionSignerKeyType &&
      normalizeCredentialId(signerCredentialId) ===
        normalizeCredentialId(this.sessionSignerCredentialId) &&
      this.credentialSigner.signingAlgorithm === this.sessionSignerKeyType
    );
  }

  /**
   * Clears a session whose signer no longer holds its key. When the stored session now belongs to the
   * signer's key, a sign-in elsewhere (another tab) replaced this session, so only this client's
   * state is dropped and the newer session keeps its stored record and key.
   */
  private async clearSessionWithMismatchedSigner(operation?: WalletOperation): Promise<void> {
    const revision = this.sessionRevision;
    const keepSharedState = await this.isSessionReplacedElsewhere();
    // Another caller may have cleared the session while the stored record was checked.
    if (this.sessionRevision !== revision) return;
    await this.clearSession({ operation, keepSharedState });
  }

  private async isSessionReplacedElsewhere(): Promise<boolean> {
    try {
      const stored = this.loadStoredSessionRecord()?.record;
      if (
        !stored ||
        normalizeCredentialId(stored.signerCredentialId) ===
          normalizeCredentialId(this.sessionSignerCredentialId ?? '')
      ) {
        return false;
      }
      if (this.credentialSigner.hasCredential && !(await this.credentialSigner.hasCredential())) {
        return false;
      }
      return (
        normalizeCredentialId(await this.credentialSigner.credentialId()) ===
          normalizeCredentialId(stored.signerCredentialId) &&
        this.credentialSigner.signingAlgorithm === stored.signerKeyType
      );
    } catch {
      return false;
    }
  }

  private async requireActiveEthereumSession(operation: WalletOperation): Promise<void> {
    await this.requireActiveWalletType(WalletType.Ethereum, 'Ethereum', operation);
  }

  private async requireActiveSolanaSession(operation: WalletOperation): Promise<void> {
    await this.requireActiveWalletType(WalletType.Solana, 'Solana', operation);
  }

  private async requireActiveTronSession(operation: WalletOperation): Promise<void> {
    await this.requireActiveWalletType(WalletType.Tron, 'Tron', operation);
  }

  private async requireActiveWalletType(
    type: WalletType,
    label: string,
    operation: WalletOperation,
    options?: { requireCredential?: boolean }
  ): Promise<WalletAccount> {
    await this.requireActiveSession(operation, options);
    if (this.activeWalletAccount?.type !== type) {
      throw new Error(`An active ${label} wallet is required`);
    }
    return this.activeWalletAccount;
  }

  /**
   * Returns the address a signature is verified against: `walletAddress` when given (no session is
   * needed for the public verification request), otherwise the active wallet's address. A given
   * but empty or whitespace-only `walletAddress` is rejected rather than treated as omitted.
   */
  private async signatureVerificationAddress(
    walletAddress: string | undefined,
    type: WalletType,
    label: string,
    operation: WalletOperation
  ): Promise<string> {
    if (walletAddress !== undefined && walletAddress !== null) {
      if (!walletAddress.trim()) {
        throw new OMSWalletValidationError({
          operation,
          message: 'walletAddress must not be empty'
        });
      }
      return walletAddress;
    }

    // The public verification request needs no credential, only the active wallet's address.
    const wallet = await this.requireActiveWalletType(type, label, operation, {
      requireCredential: false
    });
    return wallet.address;
  }

  private isNativeToken(feeOption: FeeOption): boolean {
    return (
      feeOption.token.type.toLowerCase() === 'native' ||
      (!feeOption.token.contractAddress && !feeOption.token.tokenId)
    );
  }

  private balanceDecimals(feeOption: FeeOption): number | undefined {
    return feeOption.token.decimals ?? (this.isNativeToken(feeOption) ? 18 : undefined);
  }

  private normalizeAddress(address: string | undefined): string | undefined {
    return address?.trim().toLowerCase() || undefined;
  }

  private formatTokenAmount(
    value: string | undefined,
    decimals: number | undefined
  ): string | undefined {
    if (value === undefined || decimals === undefined) {
      return value;
    }

    try {
      const raw = BigInt(value);
      const divisor = 10n ** BigInt(decimals);
      const whole = raw / divisor;
      const fraction = (raw % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
      return fraction ? `${whole}.${fraction}` : whole.toString();
    } catch {
      return value;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private activeSessionSnapshot(): SessionSnapshot | undefined {
    if (!this.activeWalletAccount || !this.sessionExpiresAt || !this.sessionAuth) return undefined;
    return {
      wallet: cloneWalletAccount(this.activeWalletAccount),
      expiresAt: this.sessionExpiresAt,
      auth: { ...this.sessionAuth }
    };
  }

  private isSessionExpired(session: SessionSnapshot): boolean {
    const expiresAtMs = Date.parse(session.expiresAt);
    return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
  }

  private sessionFromMetadata(
    wallet: WalletAccount | undefined,
    metadata: WalletSessionMetadata
  ): SessionSnapshot {
    return {
      wallet: wallet ? cloneWalletAccount(wallet) : undefined,
      expiresAt: metadata.expiresAt,
      auth: { ...metadata.auth }
    };
  }

  private async expireSession(session: SessionSnapshot): Promise<void> {
    this.expiredSessionRevision = this.sessionRevision;
    try {
      await this.clearSession({ clearStorage: false });
    } catch {
      // Expiry notification should not depend on credential cleanup succeeding.
    }
    this.notifySessionExpired(sessionExpiredEvent(session));
  }

  private scheduleSessionExpiry(session: SessionSnapshot): void {
    this.clearSessionExpiryTimer();

    const expiresAtMs = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAtMs)) return;

    this.scheduleSessionExpiryCheck(session, expiresAtMs - Date.now());
  }

  private scheduleSessionExpiryCheck(session: SessionSnapshot, delayMs: number): void {
    this.clearSessionExpiryTimer();
    const timer = setTimeout(
      () => {
        this.sessionExpiryTimer = undefined;
        void this.expireSessionFromTimer(session);
      },
      Math.min(Math.max(0, delayMs), MAX_SESSION_EXPIRY_TIMER_MS)
    );
    this.sessionExpiryTimer = timer;
    const unrefTimer = timer as { unref?: () => void };
    unrefTimer.unref?.();
  }

  private clearSessionExpiryTimer(): void {
    if (!this.sessionExpiryTimer) return;
    clearTimeout(this.sessionExpiryTimer);
    this.sessionExpiryTimer = undefined;
  }

  private async expireSessionFromTimer(session: SessionSnapshot): Promise<void> {
    if (!this.isCurrentSessionSnapshot(session)) return;
    if (!this.isSessionExpired(session)) {
      this.scheduleSessionExpiry(session);
      return;
    }
    if (!session.wallet) {
      await this.expireSession(session);
      return;
    }
    if (!this.isCredentialRefreshUnsupported()) {
      // Reading the expiry extends an active credential, so ask only once the session would have
      // ended on the server.
      const checkAt = this.sessionExpiryCheckAt(session);
      if (Date.now() < checkAt) {
        this.scheduleSessionExpiryCheck(session, checkAt - Date.now());
        return;
      }
    }

    // The server may have extended the credential since the expiry was last read. This read is sent
    // only once past the bound on the server expiry, so it is not recorded as activity: if it
    // reaches WaaS, the credential has ended there and nothing moves. Counting it would put the
    // next check (a retry when WaaS is unreachable) an idle window later.
    const revision = this.sessionRevision;
    const result = await this.refreshSessionCredential('timer');
    const current = this.activeSessionSnapshot();
    if (this.sessionRevision !== revision || !current) return;
    if (result.outcome === 'refreshed' && !this.isSessionExpired(current)) return;
    if (result.outcome === 'unavailable') {
      // Offline at expiry keeps the session; check again later.
      const delayMs = this.credentialRefreshRetryDelayMs;
      this.credentialRefreshRetryDelayMs = Math.min(delayMs * 2, CREDENTIAL_REFRESH_RETRY_MAX_MS);
      this.scheduleSessionExpiryCheck(current, delayMs);
      return;
    }
    await this.expireSession(current);
  }

  /**
   * When the expiry timer may ask WaaS about a locally expired session, in epoch ms. Reading the
   * expiry extends an active credential, so the check waits until the session would have ended on
   * the server, plus a grace period for latency. `L` is the local expiry, `C` the completion of the
   * last successful read in this client (or the sign-in request's send), and `A` the completion of
   * the last session-signed request of any tab (reads included, except the timer's own checks):
   *
   * - No request since the last read (`A <= C`): `L`.
   * - Otherwise, with the idle window `I` and ceiling `N` derived at sign-in:
   *   `max(L, min(A + I, N))`. A session-signed request moves the server expiry toward
   *   `min(t + I, N)` and never past it (WaaS skips small moves, which only keeps it lower), so
   *   after the last request, done by `A`, the server expiry is at most `min(A + I, N)`. It never
   *   moves earlier, so it is at least `L`, which the server reported. With a lifetime shorter than
   *   the idle window, the expiry is `N` from sign-in and activity cannot move it.
   * - Without `I` and `N` (a sign-in response without a usable expiry; restored sessions always
   *   have them): `L + max(0, A - C) + 6 hours`, or `L + 6 hours` without a read, allowing for the
   *   6-hour dampening as well.
   */
  private sessionExpiryCheckAt(session: SessionSnapshot): number {
    const expiresAtMs = Date.parse(session.expiresAt);
    const readAt = this.lastCredentialRefreshAt;
    const activityAt = this.latestSessionActivityAt();
    const bounds = this.sessionExpiryBounds;
    if (!bounds) {
      const activitySinceRead =
        readAt !== undefined && activityAt !== undefined ? Math.max(0, activityAt - readAt) : 0;
      return (
        expiresAtMs +
        activitySinceRead +
        SERVER_EXPIRY_SLIDE_DAMPENING_MS +
        SESSION_EXPIRY_CHECK_GRACE_MS
      );
    }
    if (activityAt === undefined || (readAt !== undefined && activityAt <= readAt)) {
      return expiresAtMs + SESSION_EXPIRY_CHECK_GRACE_MS;
    }
    const serverExpiryBound = Math.min(activityAt + bounds.idleWindowMs, bounds.expiryCeilingMs);
    return Math.max(expiresAtMs, serverExpiryBound) + SESSION_EXPIRY_CHECK_GRACE_MS;
  }

  /**
   * The last session-signed request of this client or, through the shared activity record, of
   * another client (tab) signing with the same credential key, in epoch ms.
   */
  private latestSessionActivityAt(): number | undefined {
    const ownActivityAt = this.lastSessionActivityAt;
    const sharedActivityAt = this.sharedSessionActivityAt();
    if (sharedActivityAt === undefined) return ownActivityAt;
    return ownActivityAt === undefined
      ? sharedActivityAt
      : Math.max(ownActivityAt, sharedActivityAt);
  }

  /** Reads the shared activity record; undefined when absent, malformed, or for another credential. */
  private sharedSessionActivityAt(): number | undefined {
    const signerCredentialId = this.sessionSignerCredentialId;
    if (!signerCredentialId) return undefined;
    try {
      const serialized = this.storage.get(this.storageKeys.sessionActivity);
      if (!serialized) return undefined;
      const parsed = JSON.parse(serialized) as Record<string, unknown> | null;
      if (
        !parsed ||
        typeof parsed.signerCredentialId !== 'string' ||
        normalizeCredentialId(parsed.signerCredentialId) !==
          normalizeCredentialId(signerCredentialId) ||
        typeof parsed.at !== 'number' ||
        !Number.isFinite(parsed.at)
      ) {
        return undefined;
      }
      return parsed.at;
    } catch {
      return undefined;
    }
  }

  /**
   * Records a session-signed request completed at `at` (epoch ms), for this client and, through shared
   * storage, for other clients (tabs) signing with the same credential key. Best effort: a storage
   * failure never fails the request.
   */
  private recordSessionActivity(at: number): void {
    this.lastSessionActivityAt = at;
    const signerCredentialId = this.sessionSignerCredentialId;
    if (!signerCredentialId) return;
    const written = this.lastSharedSessionActivity;
    if (written && written.signerCredentialId === signerCredentialId && written.at >= at) return;
    try {
      this.storage.set(
        this.storageKeys.sessionActivity,
        JSON.stringify({ signerCredentialId, at })
      );
      this.lastSharedSessionActivity = { signerCredentialId, at };
    } catch {
      // Other tabs only lose this request's time; this client still has it.
    }
  }

  /**
   * Refreshes a session found expired before an operation. Returns when WaaS extended it; throws
   * `OMS_SESSION_EXPIRED` when it ended (or the server cannot extend it), or the request error when
   * WaaS was unreachable, leaving the session in place.
   */
  private async refreshLocallyExpiredSession(operation: WalletOperation): Promise<void> {
    const revision = this.sessionRevision;
    const result = await this.refreshSessionCredential('operation');
    const current = this.activeSessionSnapshot();
    const isSameSession = this.sessionRevision === revision && !!current;
    if (result.outcome === 'refreshed' && isSameSession && !this.isSessionExpired(current)) return;
    if (result.outcome === 'signerMismatch') {
      throw new OMSWalletSessionError({
        operation,
        message: 'No active wallet session'
      });
    }
    if (result.outcome === 'unavailable' && isSameSession) {
      throw toOMSWalletError(result.error, operation);
    }
    if (isSameSession) {
      await this.expireSession(current);
    }
    throw new OMSWalletSessionError({
      code: 'OMS_SESSION_EXPIRED',
      operation,
      message: 'Wallet session expired',
      // Server-reported and local expiry share one shape: the WaaS error is kept only as `cause`.
      ...(result.outcome === 'ended' ? { cause: result.error } : {})
    });
  }

  /**
   * Reads the active session credential's current expiry from WaaS. Concurrent callers share one
   * request, and a result is applied only while the same session is current. Never rejects.
   * `origin` is the caller that starts the read: see `CredentialReadOrigin`.
   */
  private refreshSessionCredential(
    origin: CredentialReadOrigin = 'background'
  ): Promise<CredentialRefreshResult> {
    if (!this.activeWalletAccount) return Promise.resolve({ outcome: 'stale' });
    if (this.isCredentialRefreshUnsupported()) return Promise.resolve({ outcome: 'unsupported' });
    const revision = this.sessionRevision;
    if (this.credentialRefresh?.revision === revision) return this.credentialRefresh.promise;

    const promise = this.requestCredentialRefresh(revision, origin);
    const refresh = { revision, promise };
    this.credentialRefresh = refresh;
    void promise.finally(() => {
      if (this.credentialRefresh === refresh) this.credentialRefresh = undefined;
    });
    return promise;
  }

  private async requestCredentialRefresh(
    revision: number,
    origin: CredentialReadOrigin
  ): Promise<CredentialRefreshResult> {
    const signerCredentialId = this.sessionSignerCredentialId;
    const isCurrent = () =>
      this.sessionRevision === revision &&
      !!this.activeWalletAccount &&
      this.sessionSignerCredentialId === signerCredentialId;

    let signerMatches: boolean;
    try {
      signerMatches = await this.sessionSignerMatches();
    } catch (error) {
      return isCurrent() ? { outcome: 'unavailable', error } : { outcome: 'stale' };
    }
    if (!isCurrent()) return { outcome: 'stale' };
    if (!signerMatches) {
      // The session cannot sign its requests any more: clear it without asking WaaS.
      const session = this.activeSessionSnapshot();
      try {
        await this.clearSessionWithMismatchedSigner();
      } catch {
        // The session is cleared in memory even when storage or credential cleanup fails.
      }
      if (origin !== 'operation' && session && !this.activeWalletAccount) {
        // No operation reports this, so tell listeners the session ended, as a local expiry does.
        this.notifySessionExpired({
          ...sessionExpiredEvent(session),
          expiredAt: this.isSessionExpired(session) ? session.expiresAt : new Date().toISOString()
        });
      }
      return { outcome: 'signerMismatch' };
    }

    let expiresAt: unknown;
    let readAt = Date.now();
    try {
      // The read fetch takes this synchronously when `getCredential` calls it.
      this.nextCredentialReadRecordsActivity = origin !== 'timer';
      const response = await this.credentialClient.getCredential();
      // The read fetch records its completion also as session activity, so a successful read with no
      // later request leaves the activity no later than the read.
      readAt = this.lastCredentialReadCompletedAt ?? readAt;
      expiresAt = response.credential?.expiresAt;
    } catch (error) {
      if (isBadRouteError(error)) {
        this.credentialRefreshUnsupportedUntil =
          Date.now() + CREDENTIAL_REFRESH_UNSUPPORTED_RETRY_MS;
        return { outcome: isCurrent() ? 'unsupported' : 'stale' };
      }
      if (!isCurrent()) return { outcome: 'stale' };
      // GetCredential involves no wallet, so `Unauthorized` (7207) means the credential was revoked.
      if (isCredentialEndedError(error) || isUnauthorizedError(error)) {
        const session = this.activeSessionSnapshot();
        if (session) await this.expireSession(session);
        return { outcome: 'ended', error };
      }
      return { outcome: 'unavailable', error };
    }

    if (!isCurrent()) return { outcome: 'stale' };
    if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) {
      return {
        outcome: 'unavailable',
        error: new OMSWalletResponseError({ message: 'Credential expiry response is invalid' })
      };
    }
    this.applyRefreshedSessionExpiry(expiresAt, readAt);
    return { outcome: 'refreshed' };
  }

  /** Applies an expiry read by a `GetCredential` request completed at `readAt` (epoch ms). */
  private applyRefreshedSessionExpiry(expiresAt: string, readAt: number): void {
    const wallet = this.activeWalletAccount;
    const metadata = this.currentSessionMetadata();
    if (!wallet || !metadata) return;
    this.credentialRefreshRetryDelayMs = CREDENTIAL_REFRESH_RETRY_MIN_MS;
    const refreshed: WalletSessionMetadata = { ...metadata, expiresAt };
    try {
      this.persistRefreshedSessionExpiry(wallet, refreshed);
    } catch {
      // Storage failed: keep the refreshed expiry in memory; the stored record keeps the old one.
      this.sessionExpiresAt = expiresAt;
      this.scheduleSessionExpiry(this.sessionFromMetadata(wallet, refreshed));
    }
    this.lastCredentialRefreshAt = readAt;
  }

  /**
   * Stores a refreshed expiry. Clients (tabs) signing with the same key share the stored record,
   * and another one may have activated another wallet in it since this client last wrote it, so
   * only its expiry changes; this client keeps its own wallet. A record of another credential
   * belongs to a newer session elsewhere and is left alone. Throws when storage fails.
   */
  private persistRefreshedSessionExpiry(
    wallet: WalletAccount,
    refreshed: WalletSessionMetadata
  ): void {
    const stored = this.loadStoredSessionRecord()?.record;
    if (!stored) {
      this.persistSession(wallet, refreshed);
      return;
    }
    if (
      normalizeCredentialId(stored.signerCredentialId) ===
      normalizeCredentialId(refreshed.signerCredentialId)
    ) {
      const record: StoredSessionRecord = { ...stored, expiresAt: refreshed.expiresAt };
      this.storage.set(this.storageKeys.session, JSON.stringify(record));
    }
    this.latestSessionExpiredEvent = undefined;
    this.sessionExpiresAt = refreshed.expiresAt;
    this.scheduleSessionExpiry(this.sessionFromMetadata(wallet, refreshed));
  }

  /**
   * Signs a session request once no expiry read is in flight, records when it completed (WaaS can
   * extend the credential whatever the outcome), and counts it while in flight.
   */
  private sessionRequestFetch(fetch: Fetch): Fetch {
    return async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal ?? undefined;
      while (this.credentialReadInFlight) await untilAborted(this.credentialReadInFlight, signal);
      this.signedSessionRequestsInFlight += 1;
      let inFlight = true;
      const finish = () => {
        if (!inFlight) return;
        inFlight = false;
        // Recorded at completion: a request can reach WaaS, and extend the credential, any time
        // until then.
        this.recordSessionActivity(Date.now());
        this.signedSessionRequestsInFlight -= 1;
        if (this.signedSessionRequestsInFlight === 0) {
          for (const resume of this.signedSessionRequestsIdleWaiters.splice(0)) resume();
        }
      };
      // Aborted before it was sent, the request can no longer reach WaaS, so it stops holding up
      // expiry reads even while a slow signer is still finishing.
      const finishIfNotSent = () => {
        if (signal && !wasRequestSent(signal)) finish();
      };
      signal?.addEventListener('abort', finishIfNotSent, { once: true });
      try {
        return await fetch(input, init);
      } finally {
        signal?.removeEventListener('abort', finishIfNotSent);
        finish();
      }
    };
  }

  /** Signs an expiry read once no other signed session request or read is in flight. */
  private credentialReadFetch(fetch: Fetch): Fetch {
    return async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
      const recordsActivity = this.nextCredentialReadRecordsActivity;
      this.nextCredentialReadRecordsActivity = true;
      const signal = init?.signal ?? undefined;
      while (this.signedSessionRequestsInFlight > 0 || this.credentialReadInFlight) {
        await untilAborted(
          this.credentialReadInFlight ??
            new Promise<void>((resume) => this.signedSessionRequestsIdleWaiters.push(resume)),
          signal
        );
      }
      let release!: () => void;
      this.credentialReadInFlight = new Promise<void>((resolve) => (release = resolve));
      let inFlight = true;
      const finish = () => {
        if (!inFlight) return;
        inFlight = false;
        // A read is session activity too: WaaS extends an active credential when it receives it.
        // Reads never overlap other session requests, so a successful read's completion is also
        // when its expiry was current.
        const completedAt = Date.now();
        this.lastCredentialReadCompletedAt = completedAt;
        if (recordsActivity) this.recordSessionActivity(completedAt);
        this.credentialReadInFlight = undefined;
        release();
      };
      // As for session requests: a read aborted before it was sent releases the requests waiting
      // for it.
      const finishIfNotSent = () => {
        if (signal && !wasRequestSent(signal)) finish();
      };
      signal?.addEventListener('abort', finishIfNotSent, { once: true });
      try {
        return await fetch(input, init);
      } finally {
        signal?.removeEventListener('abort', finishIfNotSent);
        finish();
      }
    };
  }

  /**
   * Wraps the fetch of the clients that sign with the session credential. After a successful session
   * request it starts a background expiry refresh once the last read (sign-in or refresh) is at
   * least 6 hours old, and it records when WaaS rejects the session credential, so
   * only those rejections end the session (public requests can return 7202 for other credentials).
   */
  private sessionActivityFetch(fetch: Fetch): Fetch {
    return async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
      const revision = this.sessionRevision;
      const hadActiveSession = this.activeWalletAccount !== undefined;
      const response = await fetch(input, init);
      if (!hadActiveSession) return response;
      if (response.ok) {
        if (this.sessionRevision === revision) this.refreshSessionCredentialIfDue();
        return response;
      }
      const errorCode = await waasErrorCode(response);
      if (errorCode === 7202 || errorCode === 7203) {
        this.rejectedSessionCredentialRevision = revision;
      } else if (errorCode === 7207 && this.sessionRevision === revision) {
        // Unauthorized: a wallet access error, or a revoked credential. `GetCredential` involves no
        // wallet, so it tells them apart: it fails with 7207 and ends the session only when the
        // credential was revoked. One read in flight at a time is shared.
        void this.refreshSessionCredential('background');
      }
      return response;
    };
  }

  private isCredentialRefreshUnsupported(): boolean {
    const until = this.credentialRefreshUnsupportedUntil;
    return until !== undefined && Date.now() < until;
  }

  private refreshSessionCredentialIfDue(): void {
    if (!this.activeWalletAccount || this.isCredentialRefreshUnsupported()) return;
    const lastRefreshAt = this.lastCredentialRefreshAt;
    if (
      lastRefreshAt !== undefined &&
      Date.now() - lastRefreshAt < CREDENTIAL_REFRESH_INTERVAL_MS
    ) {
      return;
    }
    void this.refreshSessionCredential('background');
  }

  private isCurrentSessionSnapshot(session: SessionSnapshot): boolean {
    if (session.wallet) {
      return (
        this.activeWalletAccount?.id === session.wallet.id &&
        this.sessionExpiresAt === session.expiresAt
      );
    }

    return (
      !!this.activePendingWalletSelection &&
      this.activePendingWalletSelection.metadata.expiresAt === session.expiresAt
    );
  }

  private scheduleStoredSessionExpiryNotification(snapshot: StoredSessionSnapshot): void {
    const session = snapshot.session;
    void Promise.resolve()
      .then(async () => {
        if (!this.matchesStoredSessionSnapshot(snapshot)) return;

        try {
          await this.credentialSigner.clear?.();
        } catch {
          // Expiry replay should still happen if credential cleanup fails.
        }

        if (!this.matchesStoredSessionSnapshot(snapshot)) return;

        this.notifySessionExpired(sessionExpiredEvent(session));
      })
      .catch(() => {});
  }

  private matchesStoredSessionSnapshot(snapshot: StoredSessionSnapshot): boolean {
    return this.storage.get(this.storageKeys.session) === snapshot.serializedRecord;
  }

  private notifySessionExpired(event: OMSWalletSessionExpiredEvent): void {
    const eventSnapshot = cloneSessionExpiredEvent(event);
    this.latestSessionExpiredEvent = eventSnapshot;

    this.dispatchingSessionExpiredEvent = true;
    try {
      for (const listener of Array.from(this.sessionExpiredListeners)) {
        this.callSessionExpiredListener(listener, cloneSessionExpiredEvent(eventSnapshot));
      }
    } finally {
      this.dispatchingSessionExpiredEvent = false;
    }
  }

  private callSessionExpiredListener(
    listener: OMSWalletSessionExpiredListener,
    event: OMSWalletSessionExpiredEvent
  ): void {
    try {
      const result = listener(event);
      if (isPromiseLike(result)) {
        void result.catch(() => {});
      }
    } catch {
      // User callbacks must not change the SDK operation error.
    }
  }

  private loginHintForProvider(
    provider: ResolvedOidcProviderConfig,
    loginHint: string | undefined
  ): string | undefined {
    return provider.issuer === GOOGLE_ISSUER ? loginHint : undefined;
  }

  private sessionLifetimeSeconds(value: number | undefined, operation: WalletOperation): number {
    const lifetime = value ?? DEFAULT_SESSION_LIFETIME_SECONDS;
    if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > MAX_SESSION_LIFETIME_SECONDS) {
      throw new Error(
        `${operation} requires sessionLifetimeSeconds to be an integer between 1 and ${MAX_SESSION_LIFETIME_SECONDS}`
      );
    }
    return lifetime;
  }

  private requireCurrentSessionRevision(revision: number, operation: WalletOperation): void {
    if (this.sessionRevision !== revision) {
      throw new OMSWalletSessionError({
        operation,
        message: 'Wallet session changed while auth was in flight'
      });
    }
  }

  private async runOperation<T>(operation: WalletOperation, action: () => Promise<T>): Promise<T> {
    const revision = this.sessionRevision;
    const hadActiveSession = this.activeWalletAccount !== undefined;
    try {
      return await action();
    } catch (error) {
      throw await this.operationError(error, operation, revision, hadActiveSession);
    }
  }

  /**
   * Maps an operation failure. When WaaS rejected a request signed with the active session's
   * credential as not found or expired, the session ends like a local expiry and the operation fails with
   * `OMS_SESSION_EXPIRED`. A rejected Execute is mapped the same way (it never ran); status-polling
   * errors after a submitted transaction keep their shape so `txnId` is not lost.
   */
  private async operationError(
    error: unknown,
    operation: WalletOperation,
    revision: number,
    hadActiveSession: boolean
  ): Promise<OMSWalletError> {
    const sdkError = toOMSWalletError(error, operation);
    if (
      !hadActiveSession ||
      !isCredentialEndedError(sdkError) ||
      this.rejectedSessionCredentialRevision !== revision
    ) {
      return sdkError;
    }

    const session = this.activeSessionSnapshot();
    if (this.sessionRevision === revision && session) {
      await this.expireSession(session);
    } else if (this.expiredSessionRevision !== revision) {
      // The session changed for another reason (sign-out or a new sign-in) while in flight.
      return sdkError;
    }
    if (
      sdkError instanceof OMSWalletSessionError ||
      sdkError instanceof OMSWalletTransactionError
    ) {
      return sdkError;
    }
    return new OMSWalletSessionError({
      code: 'OMS_SESSION_EXPIRED',
      operation,
      message: 'Wallet session expired',
      // Server-reported and local expiry share one shape: the WaaS error is kept only as `cause`.
      cause: error
    });
  }
}

function defaultRedirectAuthStorage(): StorageManager | undefined {
  return SessionStorageManager.isAvailable() ? new SessionStorageManager() : undefined;
}

function createApiKeyFetch(publishableKey: () => string): Fetch {
  return async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
    const existingHeaders = (init?.headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {
      ...existingHeaders,
      'Api-Key': publishableKey()
    };

    return globalThis.fetch(input, { ...init, headers });
  };
}

// Mirrors the wallet service: it builds the signature from the arg types and accepts a bare name.
const contractMethodNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function requireContractMethodName(method: string): void {
  if (!contractMethodNamePattern.test(method)) {
    throw new Error(
      `method must be a function name such as 'transfer', not a signature; got '${method}'`
    );
  }
}

function isTronNetwork(network: SolanaNetwork | TronNetwork): network is TronNetwork {
  return (Object.values(TronNetworks) as string[]).includes(network);
}

function isWalletType(value: unknown): value is WalletType {
  return typeof value === 'string' && Object.values(WalletType).includes(value as WalletType);
}

function isOidcAuthMode(value: unknown): value is OidcAuthMode {
  return value === AuthMode.AuthCode || value === AuthMode.AuthCodePKCE;
}

function isCredentialSigningAlgorithm(value: unknown): value is CredentialSigningAlgorithm {
  return value === 'ecdsa-p256-sha256' || value === 'ecdsa-p256k-eip191';
}

function isWalletSelectionBehavior(value: unknown): value is WalletSelectionBehavior {
  return value === 'automatic' || value === 'manual';
}

function sameEmailAuthCompletionParams(
  left: EmailAuthCompletionParams,
  right: EmailAuthCompletionParams
): boolean {
  return (
    left.code === right.code &&
    left.walletType === right.walletType &&
    left.walletSelection === right.walletSelection
  );
}

function normalizeCredentialId(value: string): string {
  return value.trim().toLowerCase();
}

/** Whether a failed WaaS response is `KeyNotFound` (7202) or `KeyExpired` (7203). */
/** The WaaS error code of a failed response, or undefined when its body has none. */
async function waasErrorCode(response: Response): Promise<number | undefined> {
  try {
    const body = (await response.clone().json()) as { code?: unknown } | null;
    return typeof body?.code === 'number' ? body.code : undefined;
  } catch {
    return undefined;
  }
}

function isPromiseLike(value: unknown): value is Promise<void> {
  return !!value && typeof (value as { catch?: unknown }).catch === 'function';
}

function cloneSessionAuth(auth: OMSWalletSessionAuth): OMSWalletSessionAuth;
function cloneSessionAuth(auth: undefined): undefined;
function cloneSessionAuth(auth: OMSWalletSessionAuth | undefined): OMSWalletSessionAuth | undefined;
function cloneSessionAuth(
  auth: OMSWalletSessionAuth | undefined
): OMSWalletSessionAuth | undefined {
  return auth ? { ...auth } : undefined;
}

function cloneWalletAccount<T extends WalletAccount>(wallet: T): T {
  return { ...wallet };
}

function sessionExpiredEvent(session: SessionSnapshot): OMSWalletSessionExpiredEvent {
  return {
    wallet: session.wallet ? cloneWalletAccount(session.wallet) : undefined,
    session: { expiresAt: session.expiresAt, auth: { ...session.auth } },
    expiredAt: session.expiresAt
  };
}

/** The parts of a browser `Document` that `whenInForeground` uses. */
interface ForegroundDocument {
  visibilityState?: string;
  prerendering?: boolean;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

/**
 * Runs `action` now when the page is visible and not prerendering, or outside a browser (no
 * `document`); otherwise once, when both hold. Returns a function that cancels a pending wait.
 */
function whenInForeground(action: () => void): (() => void) | undefined {
  const doc = (globalThis as { document?: ForegroundDocument }).document;
  const isForeground = () => doc?.visibilityState === 'visible' && !doc.prerendering;
  if (!doc?.addEventListener || isForeground()) {
    action();
    return undefined;
  }
  const cancel = () => {
    doc.removeEventListener?.('visibilitychange', onChange);
    doc.removeEventListener?.('prerenderingchange', onChange);
  };
  const onChange = () => {
    if (!isForeground()) return;
    cancel();
    action();
  };
  doc.addEventListener('visibilitychange', onChange);
  doc.addEventListener('prerenderingchange', onChange);
  return cancel;
}

/**
 * Derives the expiry bounds from a sign-in. WaaS sets the new credential's expiry to the earlier of
 * an idle window after the request and the requested lifetime, so the expiry minus the send time is
 * the idle window (slightly more, by the request's latency). The ceiling is at least the send time
 * plus the requested lifetime; the server's clock can only put it later. Undefined when the
 * response's expiry is not usable.
 */
function signInExpiryBounds(
  expiresAt: string,
  sent: CompleteAuthSent
): SessionExpiryBounds | undefined {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return undefined;
  const idleWindowMs = expiresAtMs - sent.sentAt;
  if (idleWindowMs <= 0) return undefined;
  return {
    idleWindowMs,
    expiryCeilingMs: Math.max(sent.sentAt + sent.lifetimeSeconds * 1000, expiresAtMs)
  };
}

/** Reads the expiry bounds of a stored session record; undefined when absent or invalid. */
function storedSessionExpiryBounds(record: {
  idleWindowMs?: unknown;
  expiryCeiling?: unknown;
}): SessionExpiryBounds | undefined {
  const { idleWindowMs, expiryCeiling } = record;
  if (typeof idleWindowMs !== 'number' || !Number.isFinite(idleWindowMs) || idleWindowMs <= 0) {
    return undefined;
  }
  if (typeof expiryCeiling !== 'string') return undefined;
  const expiryCeilingMs = Date.parse(expiryCeiling);
  if (!Number.isFinite(expiryCeilingMs)) return undefined;
  return { idleWindowMs, expiryCeilingMs };
}

function parseStoredWalletAccount(value: unknown): WalletAccount | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const wallet = value as Record<string, unknown>;
  if (
    typeof wallet.id !== 'string' ||
    !wallet.id ||
    typeof wallet.address !== 'string' ||
    !wallet.address ||
    !isWalletType(wallet.type) ||
    !isWalletKeyOrigin(wallet.keyOrigin) ||
    (wallet.reference !== undefined && typeof wallet.reference !== 'string')
  ) {
    return undefined;
  }
  if (wallet.type === WalletType.Ethereum && !isAddress(wallet.address, { strict: false })) {
    return undefined;
  }
  return {
    id: wallet.id,
    type: wallet.type,
    address: wallet.address,
    ...(wallet.reference === undefined ? {} : { reference: wallet.reference }),
    keyOrigin: wallet.keyOrigin
  } as WalletAccount;
}

function isWalletKeyOrigin(value: unknown): value is WalletKeyOrigin {
  return (
    typeof value === 'string' && Object.values(WalletKeyOrigin).includes(value as WalletKeyOrigin)
  );
}

function cloneSessionExpiredEvent(
  event: OMSWalletSessionExpiredEvent
): OMSWalletSessionExpiredEvent {
  return {
    wallet: event.wallet ? cloneWalletAccount(event.wallet) : undefined,
    session: { expiresAt: event.session.expiresAt, auth: { ...event.session.auth } },
    expiredAt: event.expiredAt
  };
}

function normalizeSessionAuth(value: unknown): OMSWalletSessionAuth | undefined {
  if (!value || typeof value !== 'object') return undefined;

  const auth = value as Record<string, unknown>;
  if (auth.type === 'email' && typeof auth.email === 'string') {
    return {
      type: 'email',
      email: auth.email
    };
  }

  if (auth.type === 'oidc' && typeof auth.issuer === 'string' && isSessionAuthFlow(auth.flow)) {
    return {
      type: 'oidc',
      flow: auth.flow,
      issuer: auth.issuer,
      provider: typeof auth.provider === 'string' ? auth.provider : undefined,
      providerLabel: typeof auth.providerLabel === 'string' ? auth.providerLabel : undefined,
      email: typeof auth.email === 'string' ? auth.email : undefined
    };
  }

  return undefined;
}

function isSessionAuthFlow(value: unknown): value is OMSWalletOidcSessionAuthFlow {
  return value === 'redirect' || value === 'id-token';
}

function builtInOidcProviderForIssuer(issuer: string): string | undefined {
  switch (issuer) {
    case GOOGLE_ISSUER:
      return 'google';
    case APPLE_ISSUER:
      return 'apple';
    default:
      return undefined;
  }
}

function builtInOidcProviderLabelForIssuer(issuer: string): string | undefined {
  switch (issuer) {
    case GOOGLE_ISSUER:
      return 'Google';
    case APPLE_ISSUER:
      return 'Apple';
    default:
      return undefined;
  }
}

function normalizeJsonBigInts<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, nestedValue) => {
      return typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue;
    })
  ) as T;
}

/** WaaS codes with which an Execute is refused before anything is submitted. */
const EXECUTE_REFUSED_BEFORE_SUBMISSION_CODES: ReadonlySet<string> = new Set([
  '7201',
  '7205',
  '7206',
  '7207'
]);
/**
 * WaaS codes with which a Tron Execute is refused before anything is submitted. In WaaS v1.2.0,
 * `executeTron` raises InvalidRequest (7200) and InvalidFeeOption (7310) only while it prices the
 * transaction again, before it claims the transaction as pending and broadcasts it
 * (rpc/tron_transaction.go `executeTron`). TransactionExpired is left out: WaaS also returns it for a
 * transaction an earlier Execute already claimed.
 */
const TRON_EXECUTE_REFUSED_BEFORE_SUBMISSION_CODES: ReadonlySet<string> = new Set(['7200', '7310']);
/** After WaaS answers GetCredential with WebrpcBadRoute, how long until it is asked again. */
const CREDENTIAL_REFRESH_UNSUPPORTED_RETRY_MS = 15 * 60_000;
const MAX_SESSION_EXPIRY_TIMER_MS = 2_147_483_647;
/** How long after the predicted server expiry the expiry timer asks WaaS (5 minutes). */
const SESSION_EXPIRY_CHECK_GRACE_MS = 5 * 60_000;
/**
 * WaaS writes an extended expiry only when it moves by at least this much (6 hours) or reaches the
 * session's ceiling, so the last read's expiry trails the server's by less than this.
 */
const SERVER_EXPIRY_SLIDE_DAMPENING_MS = 6 * 60 * 60 * 1000;
/** Refresh the expiry after session activity once the last read is at least this old (6 hours). */
const CREDENTIAL_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Retry delays for an expiry check that could not reach WaaS (1 minute, doubling to 15 minutes). */
const CREDENTIAL_REFRESH_RETRY_MIN_MS = 60_000;
const CREDENTIAL_REFRESH_RETRY_MAX_MS = 15 * 60_000;
const GOOGLE_ISSUER = 'https://accounts.google.com';
const APPLE_ISSUER = 'https://appleid.apple.com';
