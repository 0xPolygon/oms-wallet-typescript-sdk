import { useEffect, useRef, useState } from 'react';
import {
  TronNetworks,
  type FeeOptionSelection,
  type FeeOptionWithBalance
} from '@polygonlabs/oms-wallet';
import { FeeOptionsPanel } from '../../shared/example-components';
import { omsWallet } from './omsWallet';
import { formatBaseUnits, parseDecimalBaseUnits } from './SolanaExample';

const TRONSCAN_NILE_URL = 'https://nile.tronscan.org/#';
const NILE_FAUCET_URL = 'https://nileex.io/join/getJoinPage';
const NILE_USDT_CONTRACT = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
const USDT_DECIMALS = 6;
const SUN_DECIMALS = 6;

type AssetType = 'TRX' | 'TRC20';
type Trc20TokenType = 'USDT' | 'CUSTOM';

type FeeSelectionController = {
  resolve: (selection: FeeOptionSelection) => void;
  reject: (error: Error) => void;
};

export function TronExample({ walletAddress }: { walletAddress: string }) {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [usdtBalance, setUsdtBalance] = useState<bigint | null>(null);
  const [balanceStatus, setBalanceStatus] = useState('');
  const [isBalanceLoading, setIsBalanceLoading] = useState(false);
  const [message, setMessage] = useState('Sign in to OMS Wallet');
  const [messageSignature, setMessageSignature] = useState('');
  const [signStatus, setSignStatus] = useState('');
  const [assetType, setAssetType] = useState<AssetType>('TRX');
  const [tokenType, setTokenType] = useState<Trc20TokenType>('USDT');
  const [tokenContract, setTokenContract] = useState('');
  const [tokenDecimals, setTokenDecimals] = useState('6');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('1');
  const [transactionHash, setTransactionHash] = useState('');
  const [transferStatus, setTransferStatus] = useState('');
  const [feeOptions, setFeeOptions] = useState<FeeOptionWithBalance[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const feeSelection = useRef<FeeSelectionController | null>(null);

  useEffect(() => {
    void refreshBalance();
    return () => {
      feeSelection.current?.reject(new Error('Tron operation closed'));
      feeSelection.current = null;
    };
  }, [walletAddress]);

  async function refreshBalance() {
    setIsBalanceLoading(true);
    setBalanceStatus('');

    try {
      const snapshot = await getNileBalances(walletAddress);
      if (snapshot.error) {
        setBalanceStatus(snapshot.error);
      } else {
        setBalance(snapshot.trx);
        setUsdtBalance(snapshot.usdt);
      }
    } catch (error) {
      setBalanceStatus(errorMessage(error));
    } finally {
      setIsBalanceLoading(false);
    }
  }

  async function signMessage() {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;
    setIsBusy(true);
    setSignStatus('Signing message...');
    setMessageSignature('');
    try {
      const signature = await omsWallet.wallet.signTronMessage({ message: trimmedMessage });
      setMessageSignature(signature);
      setSignStatus('Verifying signature...');
      const isValid = await omsWallet.wallet.isValidTronMessageSignature({
        walletAddress,
        message: trimmedMessage,
        signature
      });
      setSignStatus(isValid ? 'Message signed and verified.' : 'Signature verification failed.');
    } catch (error) {
      setSignStatus(errorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function sendTransfer() {
    const destination = recipient.trim();
    if (!destination) return;

    setIsBusy(true);
    setTransferStatus('Preparing transfer...');
    setTransactionHash('');
    try {
      const options = {
        network: TronNetworks.nile,
        selectFeeOption: waitForFeeOptionSelection,
        statusPolling: { timeoutMs: 120_000 }
      };
      let transaction;
      if (assetType === 'TRX') {
        transaction = await omsWallet.wallet.sendTronTransaction({
          ...options,
          to: destination,
          value: parseDecimalBaseUnits(amount, SUN_DECIMALS, 'TRX amount')
        });
      } else {
        const contractAddress = tokenType === 'USDT' ? NILE_USDT_CONTRACT : tokenContract.trim();
        if (!contractAddress) {
          throw new Error('Enter a TRC-20 contract address.');
        }
        const baseUnits =
          tokenType === 'USDT'
            ? parseDecimalBaseUnits(amount, USDT_DECIMALS, 'USDT amount')
            : parseDecimalBaseUnits(amount, parseTokenDecimals(tokenDecimals), 'Token amount');
        // TRC-20 transfers are contract calls; the wallet service ABI-encodes the arguments.
        transaction = await omsWallet.wallet.callTronContract({
          ...options,
          contractAddress,
          method: 'transfer(address,uint256)',
          args: [
            { type: 'address', value: destination },
            { type: 'uint256', value: baseUnits.toString() }
          ]
        });
      }

      setTransactionHash(transaction.txnHash ?? transaction.txnId);
      setTransferStatus(
        transaction.status === 'executed' || transaction.status === 'failed'
          ? `Transfer ${transaction.status}.`
          : 'Transaction submitted.'
      );
      await refreshBalance();
    } catch (error) {
      setTransferStatus(errorMessage(error));
    } finally {
      feeSelection.current = null;
      setFeeOptions([]);
      setIsBusy(false);
    }
  }

  async function waitForFeeOptionSelection(
    options: FeeOptionWithBalance[]
  ): Promise<FeeOptionSelection | undefined> {
    if (options.length === 0) {
      setTransferStatus('Network fee sponsored. Sending transfer...');
      return undefined;
    }

    setFeeOptions(options);
    setTransferStatus('Daily free bandwidth is spent. Review the TRX fee to continue.');
    return new Promise((resolve, reject) => {
      feeSelection.current = { resolve, reject };
    });
  }

  function chooseFeeOption(option: FeeOptionWithBalance) {
    feeSelection.current?.resolve(option.selection);
    feeSelection.current = null;
    setFeeOptions([]);
    setTransferStatus(
      `Accepted ${option.feeOption.displayValue} ${option.feeOption.token.symbol} fee. Sending transfer...`
    );
  }

  function cancelFeeSelection() {
    feeSelection.current?.reject(new Error('Fee confirmation cancelled'));
    feeSelection.current = null;
    setFeeOptions([]);
  }

  return (
    <>
      <section className="tool solana-tool" role="tabpanel">
        <div className="tool-header">
          <h2>Tron operations</h2>
          <span className="metadata-pill">Nile testnet</span>
        </div>
        <p className="field-hint">
          Tron wallets use native mode only. Transactions are often sponsored by each account's
          daily free bandwidth; once it is spent, the network fee is paid in TRX.
        </p>

        <div className="balance-panel">
          <div className="balance-assets">
            <div className="balance-asset">
              <span>Nile TRX balance</span>
              <strong>
                {balance === null ? '—' : `${formatBaseUnits(balance, SUN_DECIMALS)} TRX`}
              </strong>
              <a href={NILE_FAUCET_URL} target="_blank" rel="noreferrer">
                Open TRX faucet
              </a>
            </div>
            <div className="balance-asset">
              <span>Nile USDT balance</span>
              <strong>
                {usdtBalance === null ? '—' : `${formatBaseUnits(usdtBalance, USDT_DECIMALS)} USDT`}
              </strong>
              <a href={NILE_FAUCET_URL} target="_blank" rel="noreferrer">
                Open USDT faucet
              </a>
            </div>
          </div>
          <div className="inline-links">
            <button
              type="button"
              className="secondary compact-button"
              onClick={refreshBalance}
              disabled={isBalanceLoading}
            >
              {isBalanceLoading ? 'Refreshing...' : 'Refresh'}
            </button>
            <a href={tronAddressExplorerUrl(walletAddress)} target="_blank" rel="noreferrer">
              View wallet
            </a>
          </div>
          {balanceStatus && <output>{balanceStatus}</output>}
        </div>

        <div className="operation-block">
          <h3>Sign message</h3>
          <label>
            Message
            <input value={message} onChange={(event) => setMessage(event.target.value)} />
          </label>
          <button type="button" onClick={signMessage} disabled={isBusy || !message.trim()}>
            Sign Tron message
          </button>
          {messageSignature && (
            <p className="result labeled-result">
              <span className="result-label">Signature</span>
              <code className="result-value">{messageSignature}</code>
            </p>
          )}
          {signStatus && <output>{signStatus}</output>}
        </div>

        <div className="operation-block">
          <div className="tool-header">
            <h3>Send transfer</h3>
            <span className="metadata-pill">Native</span>
          </div>
          <label>
            Asset
            <span className="select-control">
              <select
                value={assetType}
                onChange={(event) => setAssetType(event.target.value as AssetType)}
              >
                <option value="TRX">Native TRX</option>
                <option value="TRC20">TRC-20 token</option>
              </select>
            </span>
          </label>
          {assetType === 'TRC20' && (
            <>
              <label>
                Token
                <span className="select-control">
                  <select
                    value={tokenType}
                    onChange={(event) => setTokenType(event.target.value as Trc20TokenType)}
                  >
                    <option value="USDT">USDT</option>
                    <option value="CUSTOM">Custom token</option>
                  </select>
                </span>
              </label>
              {tokenType === 'CUSTOM' && (
                <>
                  <label>
                    Token contract
                    <input
                      value={tokenContract}
                      onChange={(event) => setTokenContract(event.target.value)}
                      placeholder="TRC-20 contract address (T...)"
                    />
                  </label>
                  <label>
                    Token decimals
                    <input
                      type="number"
                      inputMode="numeric"
                      min="0"
                      max="255"
                      value={tokenDecimals}
                      onChange={(event) => setTokenDecimals(event.target.value)}
                    />
                  </label>
                </>
              )}
              {tokenType === 'USDT' && (
                <p className="field-hint">USDT contract address: {NILE_USDT_CONTRACT}</p>
              )}
            </>
          )}
          <label>
            Recipient wallet
            <input
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              placeholder="Tron wallet address (T...)"
            />
          </label>
          <label>
            {assetType === 'TRX'
              ? 'Amount (TRX)'
              : tokenType === 'USDT'
                ? 'Amount (USDT)'
                : 'Amount (token units)'}
            <input
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={sendTransfer}
            disabled={
              isBusy ||
              !recipient.trim() ||
              !amount.trim() ||
              (assetType === 'TRC20' &&
                tokenType === 'CUSTOM' &&
                (!tokenContract.trim() || !tokenDecimals.trim()))
            }
          >
            Send on Tron Nile
          </button>
          {transactionHash && (
            <div className="result-block">
              <p className="result labeled-result">
                <span className="result-label">Transaction hash</span>
                <code className="result-value">{transactionHash}</code>
              </p>
              <a
                href={tronTransactionExplorerUrl(transactionHash)}
                target="_blank"
                rel="noreferrer"
              >
                View on Tronscan
              </a>
            </div>
          )}
          {transferStatus && <output>{transferStatus}</output>}
        </div>
      </section>
      {feeOptions.length > 0 && (
        <FeeOptionsPanel
          feeOptions={feeOptions}
          allowUnknownBalance
          onCancel={cancelFeeSelection}
          onChoose={chooseFeeOption}
        />
      )}
    </>
  );
}

async function getNileBalances(address: string): Promise<{
  trx: bigint;
  usdt: bigint;
  error?: string;
}> {
  const result = await omsWallet.indexer.getTronBalances({
    walletAddress: address,
    networks: [TronNetworks.nile],
    contractAddresses: [NILE_USDT_CONTRACT]
  });
  const networkError = result.errors.find((error) => error.network === TronNetworks.nile);
  if (networkError) {
    return { trx: 0n, usdt: 0n, error: networkError.reason };
  }

  const nativeBalance = result.balances.find((asset) => asset.assetType === 'native');
  const usdtBalance = result.balances.find(
    (asset) => asset.assetType === 'trc20' && asset.contractAddress === NILE_USDT_CONTRACT
  );
  return {
    trx: parseIndexerBalance(nativeBalance?.balance, 'TRX'),
    usdt: parseIndexerBalance(usdtBalance?.balance, 'USDT')
  };
}

function parseIndexerBalance(balance: string | undefined, symbol: string): bigint {
  if (balance === undefined) return 0n;
  if (!/^\d+$/.test(balance)) {
    throw new Error(`Indexer returned an invalid ${symbol} balance`);
  }
  return BigInt(balance);
}

function parseTokenDecimals(value: string): number {
  const decimals = Number(value.trim());
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('Token decimals must be an integer from 0 to 255.');
  }
  return decimals;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tronAddressExplorerUrl(address: string): string {
  return `${TRONSCAN_NILE_URL}/address/${address}`;
}

function tronTransactionExplorerUrl(txHash: string): string {
  return `${TRONSCAN_NILE_URL}/transaction/${txHash}`;
}
