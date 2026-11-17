import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_SESSION_LIFETIME_SECONDS,
  FeeOptionSelector,
  OmsRelayOidcProviders,
  type Network,
  type OMSWalletExpiredSession,
  type OMSWalletSession,
  type PendingWalletSelection,
  type WalletAccount,
  type WalletActivationResult
} from '@polygonlabs/oms-wallet';
import {
  isOMSWalletPrivacyError,
  type DeliveryStatus,
  type PrivacyProgressEvent,
  type PrivacyQuote,
  type PrivacyTransaction,
  type PrivateBalance
} from '@polygonlabs/oms-wallet-privacy';
import { formatUnits, isAddress, type Address, type Hex } from 'viem';
import {
  EmailCodeForm,
  EmailLoginForm,
  OidcButtons,
  SessionExpiredDialog,
  SessionOptions,
  WalletSelectionPanel
} from '../../shared/example-components';
import {
  activeEthereumAddress,
  formatOidcProvider,
  formatSessionAuth,
  formatSessionExpiry,
  hasOidcCallbackParams,
  isPendingWalletSelection,
  shortHash,
  switchToEthereumWallet,
  type OidcRedirectProvider
} from '../../shared/example-utils';
import { useSessionPreferences } from '../../shared/use-session-preferences';
import { omsWallet } from './omsWallet';
import {
  explorerTxUrl,
  findToken,
  formatAmount,
  parseAmount,
  tokensFor,
  type DemoToken
} from './tokens';
import './styles.css';

const MANUAL_WALLET_SELECTION_KEY = 'oms-privacy-manual-wallet-selection';
const SESSION_LIFETIME_SECONDS_KEY = 'oms-privacy-session-lifetime-seconds';
const privacy = omsWallet.privacy;

type AuthStep = 'email' | 'code';
type ActionKind = 'shield' | 'privateSend' | 'unshield';
type ActionState = {
  amount: string;
  to: string;
  quote: PrivacyQuote | null;
  progress: string[];
  result: ActionResult | null;
  status: string;
};
type ActionResult = {
  hashes: Hex[];
  deliveryId?: string;
  delivery?: DeliveryStatus;
};

const ACTIONS: ReadonlyArray<{ kind: ActionKind; title: string; description: string }> = [
  {
    kind: 'shield',
    title: 'Shield',
    description: 'Move tokens from the wallet into its private balance.'
  },
  {
    kind: 'privateSend',
    title: 'Private send',
    description:
      'Send from the wallet to a recipient with no on-chain link between the two. Delivered later.'
  },
  {
    kind: 'unshield',
    title: 'Unshield',
    description: 'Move tokens from the private balance to an address (this wallet by default).'
  }
];

const emptyAction = (): ActionState => ({
  amount: '',
  to: '',
  quote: null,
  progress: [],
  result: null,
  status: ''
});

function App() {
  const [session, setSession] = useState<OMSWalletSession | undefined>(omsWallet.wallet.session);
  const [authStep, setAuthStep] = useState<AuthStep>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pendingWalletSelection, setPendingWalletSelection] =
    useState<PendingWalletSelection | null>(null);
  const [authStatus, setAuthStatus] = useState('Enter an email to start.');
  const [redirectStatus, setRedirectStatus] = useState('');
  const [sessionExpiredPrompt, setSessionExpiredPrompt] = useState<OMSWalletExpiredSession | null>(
    null
  );
  const [network, setNetwork] = useState<Network>(privacy.networks[2] ?? privacy.networks[0]!);
  const [tokenAddress, setTokenAddress] = useState<Address>(tokensFor(network)[1]!.address);
  const [walletBalance, setWalletBalance] = useState<bigint | undefined>();
  const [privateBalances, setPrivateBalances] = useState<PrivateBalance[] | undefined>();
  const [balanceStatus, setBalanceStatus] = useState('Sign in to load balances.');
  const [payFeeWithAnyToken, setPayFeeWithAnyToken] = useState(false);
  const [waitForDelivery, setWaitForDelivery] = useState(true);
  const [actions, setActions] = useState<Record<ActionKind, ActionState>>({
    shield: emptyAction(),
    privateSend: emptyAction(),
    unshield: emptyAction()
  });
  const [logLines, setLogLines] = useState(['Ready.']);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [walletCopyLabel, setWalletCopyLabel] = useState<'Copy' | 'Copied'>('Copy');
  const oidcCallbackStarted = useRef(false);
  const sessionRestoreStarted = useRef(false);

  const walletAddress = session ? activeEthereumAddress(omsWallet.wallet) : undefined;
  const isSignedIn = walletAddress != null;
  const isBusy = loadingAction != null;
  const token = findToken(network, tokenAddress) ?? tokensFor(network)[0]!;
  const {
    useManualWalletSelection,
    setUseManualWalletSelection,
    sessionLifetimeSeconds,
    updateSessionLifetime,
    saveSessionPreferences,
    walletSelection
  } = useSessionPreferences({
    manualWalletSelectionKey: MANUAL_WALLET_SELECTION_KEY,
    sessionLifetimeSecondsKey: SESSION_LIFETIME_SECONDS_KEY,
    defaultSessionLifetimeSeconds: DEFAULT_SESSION_LIFETIME_SECONDS
  });

  const appendLog = useCallback((line: string) => {
    setLogLines((current) => [...current, line].slice(-120));
  }, []);

  const runAction = useCallback(
    async (label: string, action: () => Promise<void>, onFailure?: (error: unknown) => void) => {
      appendLog(`> ${label}`);
      setLoadingAction(label);
      try {
        await action();
      } catch (error) {
        onFailure?.(error);
        appendLog(`! ${describeError(error)}`);
      } finally {
        setLoadingAction(null);
      }
    },
    [appendLog]
  );

  const selected = privateBalances?.find(
    (balance) =>
      balance.network.id === network.id &&
      balance.token.toLowerCase() === token.address.toLowerCase()
  );

  // The wallet balance comes from the indexer and is quick. The first private-balance read also
  // sets up the privacy keys (a wallet signature and the privacy library), so it is loaded apart.
  const refreshBalances = useCallback(async () => {
    const address = activeEthereumAddress(omsWallet.wallet);
    if (!address) return;
    setBalanceStatus('Loading balances...');
    const walletRead = omsWallet.indexer
      .getBalances({ networks: [network], walletAddress: address, includeMetadata: false })
      .then((publicBalances) => {
        const raw =
          token.address === '0x0000000000000000000000000000000000000000'
            ? publicBalances.nativeBalances.find((balance) => balance.chainId === network.id)
                ?.balance
            : publicBalances.balances.find(
                (balance) => balance.contractAddress?.toLowerCase() === token.address.toLowerCase()
              )?.balance;
        setWalletBalance(BigInt(raw ?? '0'));
      });
    const privateRead = privacy.getBalances().then(setPrivateBalances);
    const results = await Promise.allSettled([walletRead, privateRead]);
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [describeError(result.reason)] : []
    );
    errors.forEach((error) => appendLog(`! Balances: ${error}`));
    setBalanceStatus(
      errors.length > 0
        ? `Balance error: ${errors.join(' ')}`
        : `Updated ${new Date().toLocaleTimeString()}.`
    );
  }, [appendLog, network, token.address]);

  useEffect(() => {
    return omsWallet.wallet.onSessionChange((event) => {
      if (event.reason === 'expired') showSessionExpired(event.expiredSession);
    });
  }, []);

  useEffect(() => {
    if (omsWallet.wallet.activeWallet) {
      if (sessionRestoreStarted.current) return;
      sessionRestoreStarted.current = true;
      void runAction('Restore wallet session', async () => {
        const restoredWallet = await switchToEthereumWallet(omsWallet.wallet);
        setSession(omsWallet.wallet.session);
        setAuthStatus('Wallet session restored.');
        appendLog(`Wallet ready: ${restoredWallet?.address}`);
      });
      return;
    }
    if (hasOidcCallbackParams()) {
      if (oidcCallbackStarted.current) return;
      oidcCallbackStarted.current = true;
      void completeOidcRedirect();
    }
  }, [appendLog, runAction]);

  useEffect(() => {
    if (!walletAddress) {
      setWalletBalance(undefined);
      setPrivateBalances(undefined);
      setBalanceStatus('Sign in to load balances.');
      return;
    }
    void refreshBalances();
  }, [refreshBalances, walletAddress]);

  const sessionDetails = useMemo(
    () => [
      { label: 'Auth', value: formatSessionAuth(session?.auth) },
      { label: 'Account', value: session?.auth.email ?? 'Unavailable' },
      { label: 'Expires', value: formatSessionExpiry(session?.expiresAt) }
    ],
    [session?.auth, session?.expiresAt]
  );

  // Auth

  function startEmailAuth() {
    void runAction(
      'Start email sign-in',
      async () => {
        const normalizedEmail = email.trim();
        if (!normalizedEmail) throw new Error('Email is required.');
        setSessionExpiredPrompt(null);
        setPendingWalletSelection(null);
        setAuthStatus('Requesting email code...');
        await omsWallet.wallet.startEmailAuth({ email: normalizedEmail, sessionLifetimeSeconds });
        setEmail('');
        setAuthStep('code');
        setAuthStatus(`Code requested for ${normalizedEmail}`);
      },
      (error) => setAuthStatus(`Sign-in error: ${describeError(error)}`)
    );
  }

  function completeEmailAuth() {
    void runAction(
      'Complete email sign-in',
      async () => {
        const normalizedCode = code.trim();
        if (!normalizedCode) throw new Error('Code is required.');
        setAuthStatus('Verifying code...');
        const result = await omsWallet.wallet.completeEmailAuth({
          code: normalizedCode,
          walletSelection
        });
        setCode('');
        setAuthStep('email');
        handleAuthCompletion(result, 'Email login complete.');
      },
      (error) => setAuthStatus(`Verify error: ${describeError(error)}`)
    );
  }

  function startOidcRedirect(provider: OidcRedirectProvider) {
    const providerLabel = formatOidcProvider(provider);
    void runAction(
      `Start ${providerLabel} sign-in`,
      async () => {
        saveSessionPreferences();
        setSessionExpiredPrompt(null);
        setPendingWalletSelection(null);
        setRedirectStatus(`Redirecting to ${providerLabel}...`);
        await omsWallet.wallet.signInWithOidcRedirect({
          provider:
            provider === 'google' ? OmsRelayOidcProviders.google : OmsRelayOidcProviders.apple,
          walletSelection,
          sessionLifetimeSeconds
        });
      },
      (error) => setRedirectStatus(`${providerLabel} sign-in error: ${describeError(error)}`)
    );
  }

  function completeOidcRedirect() {
    void runAction(
      'Complete redirect sign-in',
      async () => {
        const result = await omsWallet.wallet.completeOidcRedirectAuth();
        if (result) {
          handleAuthCompletion(result, 'Redirect login complete.');
          return;
        }
        setSession(omsWallet.wallet.session);
      },
      (error) => setRedirectStatus(`Redirect error: ${describeError(error)}`)
    );
  }

  function handleAuthCompletion(
    result: PendingWalletSelection | WalletActivationResult,
    status: string
  ) {
    setSessionExpiredPrompt(null);
    if (isPendingWalletSelection(result)) {
      setPendingWalletSelection(result);
      setAuthStatus('Choose a wallet to continue.');
      setRedirectStatus('');
      return;
    }
    setPendingWalletSelection(null);
    setAuthStatus(status);
    setRedirectStatus('');
    setSession(omsWallet.wallet.session);
    appendLog(`Wallet ready: ${result.wallet.address}`);
  }

  function showSessionExpired(event: OMSWalletExpiredSession) {
    setPendingWalletSelection(null);
    setSession(omsWallet.wallet.session);
    setAuthStep('email');
    setCode('');
    setAuthStatus('Session expired. Sign in again to continue.');
    resetActions();
    if (event.session.auth?.email) setEmail(event.session.auth.email);
    setSessionExpiredPrompt(event);
    appendLog('Session expired.');
  }

  function reauthenticateExpiredSession() {
    const auth = sessionExpiredPrompt?.session.auth;
    setSessionExpiredPrompt(null);
    if (auth?.type === 'oidc' && (auth.provider === 'google' || auth.provider === 'apple')) {
      startOidcRedirect(auth.provider);
      return;
    }
    if (auth?.type === 'email' && auth.email) {
      const authEmail = auth.email;
      void runAction(
        'Send reauth code',
        async () => {
          setEmail(authEmail);
          setAuthStatus('Requesting email code...');
          await omsWallet.wallet.startEmailAuth({ email: authEmail, sessionLifetimeSeconds });
          setAuthStep('code');
          setAuthStatus('Code sent. Check your email.');
        },
        (error) => setAuthStatus(`Reauth error: ${describeError(error)}`)
      );
    }
  }

  function selectPendingWallet(wallet: WalletAccount) {
    if (!pendingWalletSelection) return;
    void runAction(
      'Selecting wallet',
      async () => {
        const result = await pendingWalletSelection.selectWallet({ walletId: wallet.id });
        handleAuthCompletion(result, 'Wallet selected.');
      },
      (error) => setAuthStatus(`Wallet selection error: ${describeError(error)}`)
    );
  }

  function createPendingWallet() {
    if (!pendingWalletSelection) return;
    void runAction(
      'Creating wallet',
      async () => {
        const result = await pendingWalletSelection.createAndSelectWallet({
          reference: 'privacy-example'
        });
        handleAuthCompletion(result, 'Wallet created.');
      },
      (error) => setAuthStatus(`Wallet creation error: ${describeError(error)}`)
    );
  }

  function signOut() {
    void runAction('Sign out', async () => {
      await omsWallet.wallet.signOut();
      setSessionExpiredPrompt(null);
      setPendingWalletSelection(null);
      setSession(omsWallet.wallet.session);
      setAuthStep('email');
      setCode('');
      setAuthStatus('Signed out.');
      setRedirectStatus('');
      resetActions();
    });
  }

  function copyWalletAddress() {
    if (!walletAddress) return;
    void navigator.clipboard.writeText(walletAddress).then(() => {
      setWalletCopyLabel('Copied');
      window.setTimeout(() => setWalletCopyLabel('Copy'), 1500);
    });
  }

  // Privacy

  function resetActions() {
    setActions({ shield: emptyAction(), privateSend: emptyAction(), unshield: emptyAction() });
  }

  function updateAction(kind: ActionKind, patch: Partial<ActionState>) {
    setActions((current) => ({ ...current, [kind]: { ...current[kind], ...patch } }));
  }

  function selectNetwork(chainId: string) {
    const next = privacy.networks.find((candidate) => candidate.id === Number(chainId));
    if (!next) return;
    setNetwork(next);
    setWalletBalance(undefined);
    setTokenAddress(tokensFor(next)[1]?.address ?? tokensFor(next)[0]!.address);
    resetActions();
  }

  function selectToken(address: string) {
    setTokenAddress(address as Address);
    setWalletBalance(undefined);
    resetActions();
  }

  function editAction(kind: ActionKind, patch: Pick<Partial<ActionState>, 'amount' | 'to'>) {
    updateAction(kind, { ...patch, quote: null, status: '' });
  }

  function getQuote(kind: ActionKind) {
    const state = actions[kind];
    void runAction(
      `Quote ${kind}`,
      async () => {
        const amount = parseAmount(state.amount, token);
        if (amount === undefined) throw new Error(`Enter a positive ${token.symbol} amount.`);
        const to = state.to.trim();
        if ((kind === 'privateSend' || to) && !isAddress(to)) {
          throw new Error('Enter a valid recipient address.');
        }
        const params = { network, token: token.address, amount };
        const quote =
          kind === 'shield'
            ? await privacy.quoteShield(params)
            : kind === 'privateSend'
              ? await privacy.quotePrivateSend({ ...params, to: to as Address })
              : await privacy.quoteUnshield(to ? { ...params, to: to as Address } : params);
        updateAction(kind, {
          quote,
          result: null,
          progress: [],
          status: `Quote valid until ${new Date(quote.expiresAt).toLocaleTimeString()}.`
        });
        appendLog(
          `Quote: ${formatAmount(quote.total, token)} total, fee ${formatAmount(quote.fee, token)}`
        );
      },
      (error) => updateAction(kind, { status: describeError(error) })
    );
  }

  function confirm(kind: ActionKind) {
    const quote = actions[kind].quote;
    if (!quote) return;
    const progress: string[] = [];
    const onProgress = (event: PrivacyProgressEvent) => {
      progress.push(describeProgress(event));
      updateAction(kind, { progress: [...progress] });
      appendLog(`  ${describeProgress(event)}`);
    };
    const feeOptions = payFeeWithAnyToken
      ? { selectFeeOption: FeeOptionSelector.firstAvailable }
      : {};
    void runAction(
      `Run ${kind}`,
      async () => {
        updateAction(kind, { status: 'Running...', progress: [], result: null });
        let result: ActionResult;
        if (quote.kind === 'shield') {
          const shielded = await privacy.shield(quote as PrivacyQuote<'shield'>, {
            ...feeOptions,
            onProgress
          });
          result = { hashes: transactionHashes(shielded.transactions) };
        } else if (quote.kind === 'privateSend') {
          const sent = await privacy.privateSend(quote as PrivacyQuote<'privateSend'>, {
            ...feeOptions,
            onProgress,
            waitForDelivery
          });
          result = {
            hashes: transactionHashes(sent.transactions),
            deliveryId: sent.deliveryId,
            delivery: sent.delivery
          };
        } else {
          const unshielded = await privacy.unshield(quote as PrivacyQuote<'unshield'>);
          result = { hashes: [unshielded.txnHash] };
        }
        updateAction(kind, { quote: null, result, status: 'Done.' });
        await refreshBalances();
      },
      (error) =>
        updateAction(kind, {
          quote: null,
          status: `Failed: ${describeError(error)} Get a new quote to retry.`
        })
    );
  }

  function checkDelivery(kind: ActionKind) {
    const deliveryId = actions[kind].result?.deliveryId;
    if (!deliveryId) return;
    void runAction('Check delivery', async () => {
      const delivery = await privacy.getDeliveryStatus({ deliveryId });
      setActions((current) => ({
        ...current,
        [kind]: {
          ...current[kind],
          result: current[kind].result ? { ...current[kind].result, delivery } : null
        }
      }));
      appendLog(`Delivery ${delivery.status}`);
    });
  }

  function recover(balance: PrivateBalance) {
    void runAction('Recover', async () => {
      const result = await privacy.recover({ network: balance.network, token: balance.token });
      appendLog(`Recovered in ${result.txnHashes.length} transaction(s).`);
      await refreshBalances();
    });
  }

  function renderActionCard(kind: ActionKind) {
    const action = ACTIONS.find((candidate) => candidate.kind === kind)!;
    return (
      <ActionCard
        kind={kind}
        title={action.title}
        description={action.description}
        state={actions[kind]}
        network={network}
        token={token}
        disabled={isBusy}
        waitForDelivery={waitForDelivery}
        onWaitForDeliveryChange={setWaitForDelivery}
        onEdit={(patch) => editAction(kind, patch)}
        onQuote={() => getQuote(kind)}
        onConfirm={() => confirm(kind)}
        onCheckDelivery={() => checkDelivery(kind)}
      />
    );
  }

  return (
    <main className="shell">
      <section className="panel privacy-panel">
        <header>
          <p className="eyebrow">OMS Wallet TypeScript SDK</p>
          <h1>Privacy</h1>
          {!isSignedIn && !pendingWalletSelection && authStep === 'email' && (
            <SessionOptions
              useManualWalletSelection={useManualWalletSelection}
              sessionLifetimeSeconds={sessionLifetimeSeconds}
              disabled={isBusy}
              onManualWalletSelectionChange={setUseManualWalletSelection}
              onSessionLifetimeChange={updateSessionLifetime}
            />
          )}
        </header>

        {!isSignedIn && !pendingWalletSelection && authStep === 'email' && (
          <div className="stack">
            <h2 className="section-title">Login Options</h2>
            <OidcButtons
              providers={['google', 'apple']}
              disabled={isBusy}
              status={redirectStatus}
              onStart={startOidcRedirect}
            />
            <div className="divider">or</div>
            <EmailLoginForm
              email={email}
              disabled={isBusy}
              status={authStatus}
              onEmailChange={setEmail}
              onSubmit={startEmailAuth}
            />
          </div>
        )}

        {!isSignedIn && !pendingWalletSelection && authStep === 'code' && (
          <EmailCodeForm
            code={code}
            disabled={isBusy}
            status={authStatus}
            onCodeChange={setCode}
            onSubmit={completeEmailAuth}
            onBack={() => setAuthStep('email')}
          />
        )}

        {!isSignedIn && pendingWalletSelection && (
          <WalletSelectionPanel
            pendingWalletSelection={pendingWalletSelection}
            authStatus={authStatus}
            disabled={isBusy}
            onSelectWallet={selectPendingWallet}
            onCreateWallet={createPendingWallet}
            onCancel={signOut}
          />
        )}

        {isSignedIn && (
          <div className="stack">
            <p className="notice">
              Private balances run on mainnets only. Every action here moves real funds and pays
              real fees.
            </p>

            <div className="wallet">
              <span>Wallet</span>
              <div className="wallet-address-row">
                <code>{walletAddress}</code>
                <button type="button" className="wallet-copy" onClick={copyWalletAddress}>
                  {walletCopyLabel}
                </button>
              </div>
            </div>

            <div className="session-info">
              {sessionDetails.map((detail) => (
                <div key={detail.label}>
                  <span>{detail.label}</span>
                  <strong>{detail.value}</strong>
                </div>
              ))}
            </div>

            <section className="tool network-tool">
              <div className="tool-header">
                <h2>Network</h2>
                <span className="network-meta">{network.nativeTokenSymbol}</span>
              </div>
              <span className="select-control">
                <select
                  aria-label="Network"
                  value={network.id}
                  onChange={(event) => selectNetwork(event.target.value)}
                  disabled={isBusy}
                >
                  {privacy.networks.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.displayName} ({candidate.id})
                    </option>
                  ))}
                </select>
              </span>
              <label>
                Token
                <span className="select-control">
                  <select
                    value={token.address}
                    onChange={(event) => selectToken(event.target.value)}
                    disabled={isBusy}
                  >
                    {tokensFor(network).map((candidate) => (
                      <option key={candidate.address} value={candidate.address}>
                        {candidate.symbol}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
            </section>

            <section className="tool">
              <div className="tool-header">
                <h2>Balances</h2>
                <button
                  type="button"
                  className="secondary subtle"
                  onClick={() => void runAction('Refresh balances', refreshBalances)}
                  disabled={isBusy}
                >
                  Refresh
                </button>
              </div>
              <div className="balance-grid">
                <BalancePanel
                  label={`Wallet ${token.symbol}`}
                  value={
                    walletBalance === undefined ? '…' : formatUnits(walletBalance, token.decimals)
                  }
                />
                <BalancePanel
                  label={`Private ${token.symbol}`}
                  value={
                    privateBalances === undefined
                      ? '…'
                      : formatUnits(selected?.amount ?? 0n, token.decimals)
                  }
                />
                <BalancePanel
                  label={`Recoverable ${token.symbol}`}
                  value={
                    privateBalances === undefined
                      ? '…'
                      : formatUnits(selected?.recoverable ?? 0n, token.decimals)
                  }
                />
              </div>
              {selected && selected.recoverable > 0n ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => recover(selected)}
                  disabled={isBusy}
                >
                  Recover {formatAmount(selected.recoverable, token)} to the wallet
                </button>
              ) : null}
              <p className="field-hint compact-hint">{balanceStatus}</p>
              {privateBalances === undefined ? (
                <p className="card-description">
                  The first private balance read asks the wallet for the signature that derives the
                  privacy keys, and loads the privacy library.
                </p>
              ) : null}
              <OtherPrivateBalances
                balances={privateBalances ?? []}
                network={network}
                token={token}
              />
            </section>

            <section className="tool">
              <div>
                <h2>Network fees</h2>
                <p className="card-description">
                  Paid in the token being moved unless this is checked.
                </p>
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={payFeeWithAnyToken}
                  onChange={(event) => setPayFeeWithAnyToken(event.target.checked)}
                  disabled={isBusy}
                />
                <span>Pay with any token the wallet can afford</span>
              </label>
            </section>

            <section className="privacy-action-grid">
              {renderActionCard('privateSend')}
              <div className="divider section-divider">Shield and unshield</div>
              {renderActionCard('shield')}
              {renderActionCard('unshield')}
            </section>

            <details className="tool collapsible-tool">
              <summary>Log</summary>
              <div className="collapsible-content">
                <pre className="log-output">{logLines.join('\n')}</pre>
                {loadingAction ? <output>Running: {loadingAction}</output> : null}
              </div>
            </details>

            <button type="button" className="secondary" onClick={signOut} disabled={isBusy}>
              Sign out
            </button>
          </div>
        )}
      </section>

      {sessionExpiredPrompt && (
        <SessionExpiredDialog
          event={sessionExpiredPrompt}
          disabled={isBusy}
          onReauthenticate={reauthenticateExpiredSession}
          onDismiss={() => setSessionExpiredPrompt(null)}
        />
      )}
    </main>
  );
}

function ActionCard({
  kind,
  title,
  description,
  state,
  network,
  token,
  disabled,
  waitForDelivery,
  onWaitForDeliveryChange,
  onEdit,
  onQuote,
  onConfirm,
  onCheckDelivery
}: {
  kind: ActionKind;
  title: string;
  description: string;
  state: ActionState;
  network: Network;
  token: DemoToken;
  disabled: boolean;
  waitForDelivery: boolean;
  onWaitForDeliveryChange: (value: boolean) => void;
  onEdit: (patch: { amount?: string; to?: string }) => void;
  onQuote: () => void;
  onConfirm: () => void;
  onCheckDelivery: () => void;
}) {
  const quote = state.quote;
  return (
    <section className="tool privacy-action-card">
      <h2>{title}</h2>
      <p className="card-description">{description}</p>
      <label>
        Amount ({token.symbol})
        <input
          inputMode="decimal"
          value={state.amount}
          placeholder="0.0"
          onChange={(event) => onEdit({ amount: event.target.value })}
          disabled={disabled}
        />
      </label>
      {kind !== 'shield' ? (
        <label>
          {kind === 'privateSend' ? 'Recipient' : 'Recipient (optional)'}
          <input
            value={state.to}
            placeholder="0x..."
            spellCheck={false}
            onChange={(event) => onEdit({ to: event.target.value })}
            disabled={disabled}
          />
        </label>
      ) : null}
      {kind === 'privateSend' ? (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={waitForDelivery}
            onChange={(event) => onWaitForDeliveryChange(event.target.checked)}
            disabled={disabled}
          />
          <span>Wait for delivery</span>
        </label>
      ) : null}
      <div className="actions">
        <button type="button" onClick={onQuote} disabled={disabled}>
          Get quote
        </button>
        <button
          type="button"
          className="secondary"
          onClick={onConfirm}
          disabled={disabled || !quote}
        >
          Confirm
        </button>
      </div>
      {quote ? (
        <dl className="prepared-summary">
          <div>
            <dt>Amount</dt>
            <dd>{formatAmount(quote.amount, token)}</dd>
          </div>
          <div>
            <dt>Privacy fee</dt>
            <dd>{formatAmount(quote.fee, token)}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd>{formatAmount(quote.total, token)}</dd>
          </div>
          {quote.to ? (
            <div>
              <dt>To</dt>
              <dd>
                <code>{quote.to}</code>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {state.status ? <p className="field-hint compact-hint">{state.status}</p> : null}
      {state.progress.length > 0 ? (
        <ol className="progress-list">
          {state.progress.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ol>
      ) : null}
      {state.result ? (
        <div className="result-block">
          {state.result.hashes.map((hash) => (
            <a key={hash} href={explorerTxUrl(network, hash)} target="_blank" rel="noreferrer">
              {shortHash(hash)}
            </a>
          ))}
          {state.result.deliveryId ? (
            <>
              <p className="result labeled-result">
                <span className="result-label">Delivery</span>
                <code className="result-value">
                  {state.result.delivery?.status ?? 'pending'} · {state.result.deliveryId}
                </code>
              </p>
              {state.result.delivery?.txnHash ? (
                <a
                  href={explorerTxUrl(network, state.result.delivery.txnHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Delivery {shortHash(state.result.delivery.txnHash)}
                </a>
              ) : null}
              {state.result.delivery?.status !== 'delivered' ? (
                <button
                  type="button"
                  className="secondary subtle"
                  onClick={onCheckDelivery}
                  disabled={disabled}
                >
                  Check delivery
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function BalancePanel({ label, value }: { label: string; value: string }) {
  return (
    <div className="balance-panel">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/** Private balances outside the selected network and token, so nothing goes unnoticed. */
function OtherPrivateBalances({
  balances,
  network,
  token
}: {
  balances: PrivateBalance[];
  network: Network;
  token: DemoToken;
}) {
  const others = balances.filter(
    (balance) =>
      balance.network.id !== network.id ||
      balance.token.toLowerCase() !== token.address.toLowerCase()
  );
  if (others.length === 0) return null;
  return (
    <ul className="other-balances">
      {others.map((balance) => {
        const known = findToken(balance.network, balance.token);
        return (
          <li key={`${balance.network.id}:${balance.token}`}>
            {balance.network.displayName}: {formatAmount(balance.amount, known)}
            {balance.recoverable > 0n
              ? ` (${formatAmount(balance.recoverable, known)} recoverable)`
              : ''}
          </li>
        );
      })}
    </ul>
  );
}

function transactionHashes(transactions: ReadonlyArray<PrivacyTransaction>): Hex[] {
  return transactions.flatMap((transaction) =>
    transaction.response.txnHash ? [transaction.response.txnHash as Hex] : []
  );
}

function describeProgress(event: PrivacyProgressEvent): string {
  if (event.step === 'delivery') {
    return `Delivery ${event.state} (${event.deliveryId})`;
  }
  const step =
    event.step === 'reset-approval'
      ? 'Reset approval'
      : event.step === 'approve'
        ? 'Approve'
        : 'Deposit';
  const fee = event.networkFee ? `, network fee ${event.networkFee.amount}` : '';
  return event.state === 'prepared'
    ? `${step}: prepared ${event.txnId}`
    : `${step}: confirmed ${event.txnHash ? shortHash(event.txnHash) : event.txnId}${fee}`;
}

function describeError(error: unknown): string {
  if (isOMSWalletPrivacyError(error)) {
    const sent = error.txnIds.length > 0 ? ` Transactions: ${error.txnIds.join(', ')}.` : '';
    return `${error.code}: ${error.message}${sent}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export default App;
