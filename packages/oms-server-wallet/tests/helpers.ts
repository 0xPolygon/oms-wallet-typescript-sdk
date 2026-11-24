import {
  createSingleProcessExecutor,
  UpstreamError,
  type ApprovalMode,
  type StateStore
} from '@polygonlabs/oms-server-wallet-sdk';
import type { Credential } from '../src/protocol.js';
import type { RpcTransport } from '../src/transport.js';

import { base58Encode, hexToTron } from '../src/internal/protocol/addresses.js';
import { createServerWalletInternal } from '../src/wallet.js';

/** A Solana or Tron transaction as WaaS v1.2.0 keeps it: claimed as pending before broadcast. */
export interface FakeChainTxn {
  family: 'solana' | 'tron';
  status: 'quoted' | 'pending' | 'executed' | 'failed';
  expiresAt: number;
  sponsored: boolean;
  feeOptions: unknown[];
  hash: string;
}
export const SOLANA_SIGNATURE = base58Encode(new Uint8Array(64).fill(7));
export const TRON_TXID = 'cd'.repeat(32);
type FakeWallet = { id: string; address: string; networkFamily: string; type?: string };
/** Deterministic addresses for the non-EVM families, valid for their encodings. */
export const SOLANA_ADDRESS = base58Encode(new Uint8Array(32).fill(1));
export const SOLANA_RECIPIENT = base58Encode(new Uint8Array(32).fill(2));
export const TRON_ADDRESS = hexToTron('0x3333333333333333333333333333333333333333');
export const TRON_RECIPIENT = hexToTron('0x4444444444444444444444444444444444444444');
export const TEST_PUBLISHABLE_KEY = 'pk_dev_live_test_key';

const created: Record<string, FakeWallet> = {
  solana: { id: 'wallet-sol', address: SOLANA_ADDRESS, networkFamily: 'solana', type: 'solana' },
  tron: { id: 'wallet-trx', address: TRON_ADDRESS, networkFamily: 'tron', type: 'tron' }
};

export class MemoryStore implements StateStore {
  values = new Map<string, string>();
  async read(key: string) {
    return this.values.get(key) ?? null;
  }
  async write(key: string, value: string) {
    this.values.set(key, value);
  }
}

export class FakeWaas implements RpcTransport {
  wallet: FakeWallet | undefined;
  /** Solana, Tron and any extra wallets the identity holds besides the EVM one. */
  others: FakeWallet[] = [];
  /** Page size for CompleteAuth and ListWallets. */
  pageSize = 100;
  calls: { method: string; body: Record<string, unknown>; credential?: string }[] = [];
  nonces = new Map<string, bigint>();
  private evmTxnCount = 0;
  revoked = new Set<string>();
  sponsored = true;
  failCreate = false;
  failExecute = false;
  /** Refuse the next EVM Execute with this code, before claiming the transaction. */
  evmExecuteRefusal: number | undefined;
  /** Answer EVM TransactionStatus with this error code. */
  evmStatusError: number | undefined;
  failRevoke = false;
  expiredOnce = false;
  txnStatus = 'quoted';
  signaturesValid = true;
  /** Solana and Tron transactions by ID, and how the next ones behave. */
  chainTxns = new Map<string, FakeChainTxn>();
  chainSponsored = true;
  chainQuoteMs = 60_000;
  /** Sun charged for an unsponsored Tron transaction. */
  tronFee = '345000';
  /** Send fee options as null, as servers before v1.2.0 do. */
  nullFeeOptions = false;
  /** Refuse the next Execute with this code before claiming the transaction. */
  executeRefusal: number | undefined;
  /** Status reads still answering from before the last claim, as an eventually consistent read can. */
  staleStatusReads = 0;
  /** Claim the transaction, then lose the Execute response. */
  chainLoseExecute = false;
  /** Where a claimed transaction is when its status is read. */
  chainOutcome: 'pending' | 'executed' | 'failed' = 'pending';
  inFlight = 0;
  maxInFlight = 0;
  async request(
    method: string,
    body: Record<string, unknown>,
    credential?: Credential
  ): Promise<unknown> {
    this.calls.push({ method, body, credential: credential?.id });
    if (credential) {
      const nonce = BigInt(credential.nonce);
      if (nonce <= (this.nonces.get(credential.id) ?? -1n)) throw new UpstreamError(7206, method);
      this.nonces.set(credential.id, nonce);
      if (this.revoked.has(credential.credentialId)) throw new UpstreamError(7207, method);
    }
    if (method === 'CommitVerifier') return { verifier: body.handle };
    if (method === 'CompleteAuth')
      return {
        identity: { type: 'oidc', iss: 'https://issuer.example', sub: 'customer-1' },
        credential: {
          credentialId: credential!.credentialId,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString()
        },
        ...this.page(0)
      };
    if (method === 'ListWallets') {
      const offset = (body.page as { cursor?: string } | undefined)?.cursor;
      return this.page(offset ? Number(offset) : 0);
    }
    if (method === 'CreateWallet' && body.networkFamily !== 'evm') {
      const wallet = { ...created[body.networkFamily as string] };
      this.others.push(wallet);
      if (this.failCreate) throw new Error('Lost create response');
      return { wallet };
    }
    if (method === 'CreateWallet') {
      this.wallet = {
        id: 'wallet-1',
        address: '0x1111111111111111111111111111111111111111',
        networkFamily: 'evm'
      };
      if (this.failCreate) throw new Error('Lost create response');
      return { wallet: this.wallet };
    }
    if (method === 'UseWallet')
      return { wallet: this.all().find((wallet) => wallet.id === body.walletId) };
    if (method === 'PrepareSolanaTransfer' || method.startsWith('PrepareTron'))
      return this.prepareChain(method === 'PrepareSolanaTransfer' ? 'solana' : 'tron');
    if (method === 'Execute' && this.chainTxns.has(body.txnId as string))
      return this.executeChain(body);
    if (method === 'TransactionStatus' && this.chainTxns.has(body.txnId as string)) {
      const txn = this.chainTxns.get(body.txnId as string)!;
      if (this.staleStatusReads > 0) {
        this.staleStatusReads--;
        if (Date.now() > txn.expiresAt) throw new UpstreamError(7309, method);
        return { status: 'quoted' };
      }
      if (txn.status === 'quoted' && Date.now() > txn.expiresAt)
        throw new UpstreamError(7309, method);
      if (txn.status === 'pending') txn.status = this.chainOutcome;
      return { status: txn.status, ...(txn.status === 'quoted' ? {} : { txnHash: txn.hash }) };
    }
    const signer = this.others.find((wallet) => wallet.id === body.walletId);
    if (method === 'SignMessage' && signer)
      return {
        signature: signer.networkFamily === 'solana' ? SOLANA_SIGNATURE : `0x${'11'.repeat(65)}`
      };
    if (method === 'SignTypedData' && signer) return { signature: `0x${'22'.repeat(65)}` };
    if (method === 'SignMessage' || method === 'SignTypedData') {
      if (this.expiredOnce) {
        this.expiredOnce = false;
        throw new UpstreamError(7203, method);
      }
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      this.inFlight--;
      return { signature: '0x1234' };
    }
    if (method === 'IsValidMessageSignature') {
      if (!['evm', 'solana', 'tron'].includes(body.networkFamily as string))
        throw new UpstreamError(7200, method);
      return { isValid: this.signaturesValid };
    }
    if (method === 'IsValidTypedDataSignature') {
      if (!body.typedData || ('networkFamily' in body && body.networkFamily !== 'tron'))
        throw new UpstreamError(7200, method);
      return { isValid: this.signaturesValid };
    }
    if (method === 'PrepareEthereumTransaction')
      return {
        txnId: `txn-${++this.evmTxnCount}`,
        status: 'quoted',
        sponsored: this.sponsored,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      };
    if (method === 'Execute') {
      if (this.evmExecuteRefusal) {
        const code = this.evmExecuteRefusal;
        this.evmExecuteRefusal = undefined;
        throw new UpstreamError(code, method);
      }
      this.txnStatus = 'pending';
      if (this.failExecute) throw new Error('Lost execute response');
      return { status: this.txnStatus };
    }
    if (method === 'TransactionStatus' && this.evmStatusError)
      throw new UpstreamError(this.evmStatusError, method);
    if (method === 'TransactionStatus')
      return {
        status: this.txnStatus,
        ...(this.txnStatus === 'executed' ? { txnHash: `0x${'ab'.repeat(32)}` } : {})
      };
    if (method === 'RevokeCredential') {
      if (this.failRevoke) throw new Error('Unavailable');
      if (body.credentialId !== credential!.credentialId) throw new Error('Invalid credential ID');
      this.revoked.add(body.credentialId as string);
      return { ok: true };
    }
    throw new Error(`Unhandled fake RPC: ${method}`);
  }
  private prepareChain(family: 'solana' | 'tron') {
    const txnId = `${family === 'solana' ? 'sol' : 'trx'}-txn-${this.chainTxns.size + 1}`;
    const feeOptions =
      this.chainSponsored || family === 'solana'
        ? []
        : [
            {
              // Live WaaS shape: null for values the token does not have.
              token: {
                network: 'tron:nile',
                name: 'TRX',
                symbol: 'TRX',
                type: 'NATIVE',
                decimals: null,
                contractAddress: null
              },
              value: this.tronFee,
              displayValue: (Number(this.tronFee) / 1e6).toString()
            }
          ];
    const txn: FakeChainTxn = {
      family,
      status: 'quoted',
      expiresAt: Date.now() + this.chainQuoteMs,
      sponsored: this.chainSponsored,
      feeOptions,
      hash: family === 'solana' ? SOLANA_SIGNATURE : TRON_TXID
    };
    this.chainTxns.set(txnId, txn);
    return {
      txnId,
      status: 'quoted',
      sponsored: txn.sponsored,
      feeOptions: this.nullFeeOptions ? null : feeOptions,
      expiresAt: new Date(txn.expiresAt).toISOString()
    };
  }
  private executeChain(body: Record<string, unknown>) {
    const txn = this.chainTxns.get(body.txnId as string)!;
    if (txn.status !== 'quoted' || Date.now() > txn.expiresAt)
      throw new UpstreamError(7309, 'Execute');
    if (!txn.sponsored && !body.feeOption) throw new UpstreamError(7310, 'Execute');
    if (this.executeRefusal) {
      const code = this.executeRefusal;
      this.executeRefusal = undefined;
      throw new UpstreamError(code, 'Execute');
    }
    txn.status = 'pending';
    if (this.chainLoseExecute) throw new Error('Lost execute response');
    return { status: 'pending' };
  }
  all(): FakeWallet[] {
    return [...(this.wallet ? [this.wallet] : []), ...this.others];
  }
  private page(offset: number) {
    const wallets = this.all().slice(offset, offset + this.pageSize);
    const next = offset + this.pageSize;
    return {
      wallets,
      ...(next < this.all().length ? { page: { cursor: String(next), limit: this.pageSize } } : {})
    };
  }
}

export function sdkHarness<TApproval extends ApprovalMode = 'allow-immediate'>(
  options: { approval?: TApproval; clock?: () => number } = {}
) {
  const store = new MemoryStore();
  const remote = new FakeWaas();
  const executor = createSingleProcessExecutor();
  const approval = (options.approval ?? 'allow-immediate') as TApproval;
  const create = <M extends ApprovalMode = TApproval>(overrideApproval?: M) =>
    createServerWalletInternal(
      {
        publishableKey: TEST_PUBLISHABLE_KEY,
        oidc: {
          subject: 'customer-1',
          issuer: 'https://issuer.example',
          audience: 'oms-server-wallet',
          getIdToken: async () => ({
            token: `fixture-${crypto.randomUUID()}`,
            expiresAt: Math.floor(Date.now() / 1000) + 300
          })
        },
        store: { encryptedStore: store },
        executor,
        approval: (overrideApproval ?? approval) as M
      },
      { transport: remote, clock: options.clock }
    );
  return { store, remote, executor, create, client: create() };
}
