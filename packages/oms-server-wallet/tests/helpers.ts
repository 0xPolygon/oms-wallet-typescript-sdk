import {
  ServerWallet,
  SerialExecutor,
  UpstreamError,
  type StateStore,
  type RpcTransport
} from '@polygonlabs/oms-server-wallet-sdk';
import type { Credential } from '../src/protocol.js';

import { base58Encode, hexToTron } from '../src/addresses.js';

type FakeWallet = { id: string; address: string; networkFamily: string; type?: string };
/** Deterministic addresses for the non-EVM families, valid for their encodings. */
export const SOLANA_ADDRESS = base58Encode(new Uint8Array(32).fill(1));
export const SOLANA_RECIPIENT = base58Encode(new Uint8Array(32).fill(2));
export const TRON_ADDRESS = hexToTron('0x3333333333333333333333333333333333333333');
export const TRON_RECIPIENT = hexToTron('0x4444444444444444444444444444444444444444');
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
  revoked = new Set<string>();
  sponsored = true;
  failCreate = false;
  failExecute = false;
  failRevoke = false;
  expiredOnce = false;
  txnStatus = 'quoted';
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
      if (body.networkFamily !== 'evm') throw new UpstreamError(7200, method);
      return { isValid: true };
    }
    if (method === 'IsValidTypedDataSignature') {
      if ('networkFamily' in body || !body.typedData) throw new UpstreamError(7200, method);
      return { isValid: true };
    }
    if (method === 'PrepareEthereumTransaction')
      return {
        txnId: 'txn-1',
        status: 'quoted',
        sponsored: this.sponsored,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      };
    if (method === 'Execute') {
      this.txnStatus = 'pending';
      if (this.failExecute) throw new Error('Lost execute response');
      return { status: this.txnStatus };
    }
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
export function sdkHarness() {
  const store = new MemoryStore();
  const remote = new FakeWaas();
  const executor = new SerialExecutor();
  const create = () =>
    new ServerWallet({
      subject: 'customer-1',
      issuer: 'https://issuer.example',
      audience: 'oms-server-wallet',
      store,
      executor,
      transport: remote,
      tokenProvider: async () => ({
        token: `fixture-${crypto.randomUUID()}`,
        expiresAt: Math.floor(Date.now() / 1000) + 300
      })
    });
  return { store, remote, create, client: create() };
}
