import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Auth0Provider, useAuth0 } from '@auth0/auth0-react';
import { Networks, type TokenBalance } from '@polygonlabs/oms-wallet';
import './styles.css';
import { formatSessionAuth, formatSessionExpiry } from '../../shared/example-utils';
import { AUTH0_CLIENT_ID, AUTH0_DOMAIN, AUTH0_ISSUER, AUTH0_REDIRECT_URI } from './config';
import { omsWallet } from './omsWallet';

const DEFAULT_MESSAGE = 'hello from OMS Wallet';
const DEFAULT_TX_TO = '0xE5E8B483FfC05967FcFed58cc98D053265af6D99';
const BALANCE_NETWORKS = [Networks.polygon, Networks.base, Networks.arbitrum];

function App() {
  const {
    error: auth0Error,
    getIdTokenClaims,
    isAuthenticated: isAuth0Authenticated,
    isLoading: isAuth0Loading,
    loginWithRedirect,
    logout: logoutFromAuth0,
    user: auth0User
  } = useAuth0();
  const restoredWalletAddress = omsWallet.wallet.walletAddress ?? '';
  const [walletAddress, setWalletAddress] = useState(restoredWalletAddress);
  const [status, setStatus] = useState(
    restoredWalletAddress
      ? 'Wallet session restored.'
      : 'Ready to authenticate with Auth0 and pass its ID token to OMS Wallet.'
  );
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [lastSignature, setLastSignature] = useState('');
  const [lastAuth0IdToken, setLastAuth0IdToken] = useState('');
  const [transactionTo, setTransactionTo] = useState(DEFAULT_TX_TO);
  const [transactionValue, setTransactionValue] = useState('0');
  const [lastTransactionHash, setLastTransactionHash] = useState('');
  const [lastTransactionExplorerUrl, setLastTransactionExplorerUrl] = useState('');
  const [balances, setBalances] = useState<TokenBalance[] | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const omsSignInStarted = useRef(false);

  useEffect(() => {
    if (isAuth0Loading || !isAuth0Authenticated || walletAddress || omsSignInStarted.current)
      return;
    omsSignInStarted.current = true;
    void signInToOmsWithAuth0IdToken();
  }, [isAuth0Authenticated, isAuth0Loading, walletAddress]);

  async function run(label: string, action: () => Promise<void>) {
    setIsBusy(true);
    setStatus(label);
    try {
      await action();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function startAuth0Login() {
    setStatus('Opening Auth0 sign-in...');
    await loginWithRedirect();
  }

  async function signInToOmsWithAuth0IdToken() {
    setIsBusy(true);
    setStatus('Signing in to OMS Wallet with the Auth0-issued ID token...');
    try {
      const claims = await getIdTokenClaims();
      if (!claims?.__raw) {
        throw new Error('Auth0 did not return a raw ID token');
      }

      setLastAuth0IdToken(claims.__raw);
      const result = await omsWallet.wallet.signInWithOidcIdToken({
        idToken: claims.__raw,
        issuer: AUTH0_ISSUER,
        audience: AUTH0_CLIENT_ID,
        provider: 'auth0',
        providerLabel: 'Auth0'
      });

      setWalletAddress(result.walletAddress);
      setStatus('OMS Wallet sign-in with the Auth0-issued ID token is complete.');
    } catch (error) {
      omsSignInStarted.current = false;
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function signMessage() {
    await run('Signing message...', async () => {
      const signature = await omsWallet.wallet.signMessage({
        network: Networks.amoy,
        message
      });
      setLastSignature(signature);
      setStatus('Message signed.');
    });
  }

  async function loadBalances() {
    if (!walletAddress) return;

    await run('Loading balances...', async () => {
      const result = await omsWallet.indexer.getBalances({
        walletAddress,
        networks: BALANCE_NETWORKS,
        includeMetadata: true
      });
      setBalances([...result.nativeBalances, ...result.balances]);
      setStatus(`Loaded ${result.nativeBalances.length + result.balances.length} balances.`);
    });
  }

  async function sendTransaction() {
    await run('Sending Polygon Amoy transaction...', async () => {
      const to = transactionTo.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
        throw new Error('Enter a valid EVM recipient address');
      }

      let value: bigint;
      try {
        value = BigInt(transactionValue.trim() || '0');
      } catch {
        throw new Error('Transaction value must be an integer number of wei');
      }
      if (value < 0n) {
        throw new Error('Transaction value cannot be negative');
      }

      setLastTransactionHash('');
      setLastTransactionExplorerUrl('');
      const transaction = await omsWallet.wallet.sendTransaction({
        network: Networks.amoy,
        to: to as `0x${string}`,
        value
      });
      setLastTransactionHash(transaction.txnHash ?? transaction.txnId);
      setLastTransactionExplorerUrl(
        transaction.txnHash
          ? `${Networks.amoy.explorerUrl.replace(/\/+$/, '')}/tx/${transaction.txnHash}`
          : ''
      );
      setStatus('Polygon Amoy transaction sent.');
    });
  }

  async function refreshAuth0IdToken() {
    await run('Getting the current Auth0-issued ID token...', async () => {
      const claims = await getIdTokenClaims();
      if (!claims?.__raw) {
        throw new Error('Auth0 did not return a raw ID token');
      }
      setLastAuth0IdToken(claims.__raw);
      setStatus('Auth0-issued ID token loaded.');
    });
  }

  async function signOut() {
    await run('Signing out...', async () => {
      await omsWallet.wallet.signOut();
      setWalletAddress('');
      setLastSignature('');
      setLastAuth0IdToken('');
      setTransactionTo(DEFAULT_TX_TO);
      setTransactionValue('0');
      setLastTransactionHash('');
      setLastTransactionExplorerUrl('');
      setBalances(null);
      omsSignInStarted.current = false;
      await logoutFromAuth0({
        logoutParams: {
          returnTo: AUTH0_REDIRECT_URI
        }
      });
    });
  }

  const displayedStatus = auth0Error ? `Auth0 error: ${auth0Error.message}` : status;

  return (
    <main className="shell">
      <section className="panel">
        <header>
          <p className="eyebrow">OMS Wallet example</p>
          <h1>Sign in with an Auth0-issued ID token</h1>
        </header>

        <section className="provider-metadata" aria-label="Auth0-issued ID token settings">
          <div className="provider-metadata-row">
            <span>Auth0 domain</span>
            <code>{AUTH0_DOMAIN}</code>
          </div>
          <div className="provider-metadata-row">
            <span>Auth0 client / token audience</span>
            <code>{AUTH0_CLIENT_ID}</code>
          </div>
          <div className="provider-metadata-row">
            <span>Auth0 redirect URI</span>
            <code>{AUTH0_REDIRECT_URI}</code>
          </div>
          <div className="provider-metadata-row">
            <span>Token issuer</span>
            <code>{AUTH0_ISSUER}</code>
          </div>
        </section>

        <output>{isAuth0Loading ? 'Restoring Auth0 session...' : displayedStatus}</output>

        {!walletAddress && !isAuth0Authenticated ? (
          <button type="button" onClick={startAuth0Login} disabled={isBusy || isAuth0Loading}>
            Sign in with Auth0
          </button>
        ) : null}

        {!walletAddress && isAuth0Authenticated ? (
          <button type="button" onClick={signInToOmsWithAuth0IdToken} disabled={isBusy}>
            Sign in to OMS with Auth0-issued ID token
          </button>
        ) : null}

        {walletAddress ? (
          <section className="stack">
            <h2>Active session</h2>
            <dl className="session-details">
              <div>
                <dt>Wallet address</dt>
                <dd>{walletAddress || 'Unknown'}</dd>
              </div>
              <div>
                <dt>Sign-in method</dt>
                <dd>{formatSessionAuth(omsWallet.wallet.session.auth)}</dd>
              </div>
              <div>
                <dt>Auth0 user</dt>
                <dd>{auth0User?.email ?? auth0User?.name ?? 'Unknown'}</dd>
              </div>
              <div>
                <dt>Session expires</dt>
                <dd>{formatSessionExpiry(omsWallet.wallet.session.expiresAt)}</dd>
              </div>
            </dl>

            <section className="tool">
              <h2>Sign message</h2>
              <label>
                Message
                <input
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  disabled={isBusy}
                />
              </label>
              <button type="button" onClick={signMessage} disabled={isBusy || !message.trim()}>
                Sign message
              </button>
              {lastSignature ? (
                <p className="result labeled-result">
                  <span className="result-label">Signature</span>
                  <code className="result-value">{lastSignature}</code>
                </p>
              ) : null}
            </section>

            <section className="tool">
              <div className="tool-header">
                <h2>Send transaction</h2>
                <span className="metadata-pill">Polygon Amoy</span>
              </div>
              <p className="field-hint compact-hint">
                Sponsored testnet transaction. The recipient and zero-value amount are prefilled for
                one-click testing.
              </p>
              <label>
                Recipient
                <input
                  value={transactionTo}
                  onChange={(event) => setTransactionTo(event.target.value)}
                  placeholder="0x..."
                  disabled={isBusy}
                />
              </label>
              <label>
                Value (wei)
                <input
                  inputMode="numeric"
                  value={transactionValue}
                  onChange={(event) => setTransactionValue(event.target.value)}
                  disabled={isBusy}
                />
              </label>
              <button
                type="button"
                onClick={sendTransaction}
                disabled={isBusy || !transactionTo.trim()}
              >
                Send Amoy transaction
              </button>
              {lastTransactionHash ? (
                <div className="result-block">
                  <p className="result labeled-result">
                    <span className="result-label">
                      {lastTransactionExplorerUrl ? 'Transaction hash' : 'Transaction ID'}
                    </span>
                    <code className="result-value">{lastTransactionHash}</code>
                  </p>
                  {lastTransactionExplorerUrl ? (
                    <a href={lastTransactionExplorerUrl} target="_blank" rel="noreferrer">
                      View on explorer
                    </a>
                  ) : null}
                </div>
              ) : null}
            </section>

            <section className="tool">
              <div className="tool-header">
                <h2>Read balances</h2>
                <span className="metadata-pill">Polygon, Base, Arbitrum</span>
              </div>
              <button type="button" onClick={loadBalances} disabled={isBusy || !walletAddress}>
                Load balances
              </button>
              {balances && balances.length > 0 ? (
                <div className="balance-list">
                  {balances.map((balance, index) => (
                    <article
                      key={`${balance.chainId}-${balance.contractAddress ?? 'native'}-${balance.tokenId ?? index}`}
                      className="balance-row"
                    >
                      <span>
                        {balance.contractAddress === undefined
                          ? balance.symbol
                          : (balance.contractInfo?.symbol ?? 'Token')}
                      </span>
                      <code>{balance.balance}</code>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="field-hint compact-hint">
                  {balances
                    ? 'No balances found for the active wallet.'
                    : 'Load balances for the active wallet.'}
                </p>
              )}
            </section>

            <section className="tool">
              <h2>Auth0-issued ID token</h2>
              <button type="button" onClick={refreshAuth0IdToken} disabled={isBusy}>
                Get Auth0-issued ID token
              </button>
              {lastAuth0IdToken ? (
                <p className="result labeled-result">
                  <span className="result-label">Raw ID token supplied to OMS</span>
                  <code className="result-value">{lastAuth0IdToken}</code>
                </p>
              ) : null}
            </section>

            <button type="button" className="secondary" onClick={signOut} disabled={isBusy}>
              Sign out of OMS and Auth0
            </button>
          </section>
        ) : null}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <Auth0Provider
    domain={AUTH0_DOMAIN}
    clientId={AUTH0_CLIENT_ID}
    authorizationParams={{
      redirect_uri: AUTH0_REDIRECT_URI,
      scope: 'openid profile email'
    }}
  >
    <App />
  </Auth0Provider>
);
