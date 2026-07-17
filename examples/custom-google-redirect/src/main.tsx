import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Networks, type TokenBalance } from '@polygonlabs/oms-wallet';
import './styles.css';
import {
  formatSessionAuth,
  formatSessionExpiry,
  hasOidcCallbackParams,
  isPendingWalletSelection
} from '../../shared/example-utils';
import {
  CUSTOM_GOOGLE_CLIENT_ID,
  CUSTOM_GOOGLE_ISSUER,
  CUSTOM_GOOGLE_REDIRECT_URI
} from './config';
import { customGoogleOidcProvider, omsWallet } from './omsWallet';

const DEFAULT_MESSAGE = 'hello from OMS Wallet';
const BALANCE_NETWORKS = [Networks.polygon, Networks.base, Networks.arbitrum];

function App() {
  const restoredWalletAddress = omsWallet.wallet.walletAddress ?? '';
  const [walletAddress, setWalletAddress] = useState(restoredWalletAddress);
  const [status, setStatus] = useState(
    restoredWalletAddress
      ? 'Wallet session restored.'
      : 'Ready to sign in with the custom Google provider.'
  );
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [lastSignature, setLastSignature] = useState('');
  const [lastIdToken, setLastIdToken] = useState('');
  const [balances, setBalances] = useState<TokenBalance[] | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const callbackStarted = useRef(false);

  useEffect(() => {
    if (!hasOidcCallbackParams()) return;
    if (callbackStarted.current) return;
    callbackStarted.current = true;
    void completeRedirect();
  }, []);

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

  async function startRedirect() {
    await run('Opening Google sign-in...', async () => {
      await omsWallet.wallet.signInWithOidcRedirect({
        provider: customGoogleOidcProvider
      });
    });
  }

  async function completeRedirect() {
    await run('Finishing Google sign-in...', async () => {
      const result = await omsWallet.wallet.completeOidcRedirectAuth();

      if (!result) {
        setStatus('No matching Google callback found for this session.');
        return;
      }

      if (isPendingWalletSelection(result)) {
        setStatus('Choose automatic wallet selection for this example.');
        return;
      }

      setWalletAddress(result.walletAddress);
      setStatus('Google sign-in complete.');
    });
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

  async function getIdToken() {
    await run('Getting ID token...', async () => {
      const idToken = await omsWallet.wallet.getIdToken();
      setLastIdToken(idToken);
      setStatus('ID token issued.');
    });
  }

  async function signOut() {
    await run('Signing out...', async () => {
      await omsWallet.wallet.signOut();
      setWalletAddress('');
      setLastSignature('');
      setLastIdToken('');
      setBalances(null);
      setStatus('Signed out. You can start again.');
    });
  }

  return (
    <main className="shell">
      <section className="panel">
        <header>
          <p className="eyebrow">OMS Wallet example</p>
          <h1>Custom Google sign-in</h1>
        </header>

        <section className="provider-metadata" aria-label="Custom Google OAuth settings">
          <div className="provider-metadata-row">
            <span>Google OAuth client</span>
            <code>{CUSTOM_GOOGLE_CLIENT_ID}</code>
          </div>
          <div className="provider-metadata-row">
            <span>Redirect URI</span>
            <code>{CUSTOM_GOOGLE_REDIRECT_URI}</code>
          </div>
          <div className="provider-metadata-row">
            <span>Issuer</span>
            <code>{CUSTOM_GOOGLE_ISSUER}</code>
          </div>
        </section>

        <output>{status}</output>

        {!walletAddress ? (
          <button type="button" onClick={startRedirect} disabled={isBusy}>
            Sign in with Google
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
                <dt>Email</dt>
                <dd>{omsWallet.wallet.session.auth?.email ?? 'Unknown'}</dd>
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
              <h2>ID token</h2>
              <button type="button" onClick={getIdToken} disabled={isBusy}>
                Get ID token
              </button>
              {lastIdToken ? (
                <p className="result labeled-result">
                  <span className="result-label">ID token</span>
                  <code className="result-value">{lastIdToken}</code>
                </p>
              ) : null}
            </section>

            <button type="button" className="secondary" onClick={signOut} disabled={isBusy}>
              Sign out
            </button>
          </section>
        ) : null}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
