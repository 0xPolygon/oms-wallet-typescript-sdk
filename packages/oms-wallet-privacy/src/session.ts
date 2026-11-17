import type { Address } from 'viem';

import { getAddress } from 'viem';

import type {
  OMSWallet,
  OMSWalletExtensionContext,
  SendTransactionResponse,
  StorageManager,
  WalletClient
} from '@polygonlabs/oms-wallet';

import { Networks, isOMSWalletError } from '@polygonlabs/oms-wallet';

import type { CreateBackend, PrivacyBackend } from './backend.js';
import type { KeyChain } from './keyChain.js';

import { OMSWalletPrivacyError } from './errors.js';
import { privacyNetworks } from './networks.js';

/**
 * Signed once per setup to derive the private-balance keys. The prefix makes OMS Wallet refuse it
 * in `signMessage`, so only this package can obtain the signature. Never change this text or the
 * network it is signed on: a different signature means different keys and no access to funds.
 *
 * The wallet's signature for it changes once the wallet is deployed on that network, so keys are
 * only derived from a deployed wallet's signature: setup deploys the wallet there first if needed.
 */
export const KEY_MESSAGE =
  'OMS Wallet reserved message: private balance keys v1\n\n' +
  'Signing this derives the keys of your private balance.';
const KEY_NETWORK = Networks.polygon;

/** Torn down after this long without an operation. */
export const IDLE_TIMEOUT_MS = 60_000;

/** How long setup waits for a just-deployed wallet to be visible over RPC. */
const DEPLOY_VISIBLE_ATTEMPTS = 15;
const DEPLOY_VISIBLE_INTERVAL_MS = 1_000;

// v1 fingerprints could come from an undeployed wallet's signature, so they are not compared.
const fingerprintKey = (address: Address) =>
  `oms-wallet-privacy/key-fingerprint/v2/${address.toLowerCase()}`;

interface Entry {
  readonly address: Address;
  readonly backend: Promise<PrivacyBackend>;
  /** Operations run one at a time: each waits for this, then replaces it. */
  tail: Promise<unknown>;
  pending: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
  /** Set when the active wallet changed; a failed setup closes an entry without it. */
  walletChanged: boolean;
  unsubscribe: () => void;
}

/**
 * Per-wallet privacy backends, keyed by wallet client: `OMSWallet` instances on one stored session
 * share a wallet client, and so share one backend and one queue of operations.
 */
const entries = new WeakMap<WalletClient, Entry>();

/**
 * Runs privacy operations for the active wallet. Backends are created on first use and torn down
 * after `IDLE_TIMEOUT_MS` without operations or when the active wallet changes.
 */
export class PrivacySessions {
  constructor(
    private readonly oms: OMSWallet,
    private readonly context: OMSWalletExtensionContext,
    private readonly storage: StorageManager,
    private readonly createBackend: CreateBackend,
    private readonly keyChain: KeyChain
  ) {}

  /** The active Ethereum wallet's address, or a `OMS_PRIVACY_NO_WALLET` error. */
  activeAddress(operation: string): Address {
    const active = this.oms.wallet.activeWallet;
    if (active?.type !== 'ethereum') {
      throw new OMSWalletPrivacyError({
        code: 'OMS_PRIVACY_NO_WALLET',
        operation,
        message: 'An active Ethereum wallet is required.'
      });
    }
    return getAddress(active.address);
  }

  /**
   * Runs `action` with the active wallet's backend, after any operation already running for it.
   * `action` receives the address it is bound to; it must pass it as `expectedWallet` to every
   * wallet call.
   */
  async run<T>(
    operation: string,
    action: (backend: PrivacyBackend, address: Address) => Promise<T>
  ): Promise<T> {
    const address = this.activeAddress(operation);
    const entry = this.entryFor(address);
    entry.pending += 1;
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;

    const result = entry.tail.then(async () => {
      if (
        entry.walletChanged ||
        this.oms.wallet.activeWallet?.address.toLowerCase() !== address.toLowerCase()
      ) {
        throw walletChanged(operation);
      }
      // After a failed setup this throws that failure, for every operation queued behind it.
      const backend = await this.awaitBackend(entry, operation);
      return action(backend, address);
    });
    entry.tail = result.catch(() => undefined);
    try {
      return await result;
    } finally {
      entry.pending -= 1;
      if (entry.pending === 0 && !entry.closed) this.scheduleIdle(entry);
    }
  }

  private entryFor(address: Address): Entry {
    const wallet = this.oms.wallet;
    const existing = entries.get(wallet);
    if (existing && !existing.closed && existing.address === address) return existing;
    if (existing) this.close(existing);

    const entry: Entry = {
      address,
      backend: this.setup(address),
      tail: Promise.resolve(),
      pending: 0,
      idleTimer: undefined,
      closed: false,
      walletChanged: false,
      unsubscribe: () => {}
    };
    // A failed setup is reported by the operation that awaits it; the next call starts over.
    entry.backend.catch(() => {
      if (entries.get(wallet) === entry) this.close(entry);
    });
    entry.unsubscribe = wallet.onSessionChange((event) => {
      if (event.reason === 'expiryUpdated') return;
      if (event.activeWallet?.address.toLowerCase() === address.toLowerCase()) return;
      entry.walletChanged = true;
      this.close(entry);
    });
    entries.set(wallet, entry);
    return entry;
  }

  private async setup(address: Address): Promise<PrivacyBackend> {
    await this.ensureDeployed(address);
    const keySignature = await this.context.signReservedMessage({
      network: KEY_NETWORK,
      message: KEY_MESSAGE,
      expectedWallet: address
    });
    const backend = await this.createBackend({
      address,
      keySignature,
      chainIds: privacyNetworks.map((network) => network.id)
    });
    try {
      if (backend.address.toLowerCase() !== address.toLowerCase()) {
        throw new Error('The privacy backend is bound to another address.');
      }
      const stored = this.storage.get(fingerprintKey(address));
      if (stored !== null && stored !== backend.keyFingerprint) {
        throw new OMSWalletPrivacyError({
          code: 'OMS_PRIVACY_KEY_MISMATCH',
          operation: 'privacy.setup',
          stage: 'setup',
          message:
            'The keys derived for this wallet’s private balance differ from the ones used before. ' +
            'Nothing was sent. Contact support before retrying.'
        });
      }
      if (stored === null) this.storage.set(fingerprintKey(address), backend.keyFingerprint);
      return backend;
    } catch (error) {
      await backend.destroy().catch(() => {});
      throw error;
    }
  }

  /**
   * Deploys the wallet on the key network when it is not yet, with an empty transaction to itself,
   * so its key-message signature is the one it will keep.
   */
  private async ensureDeployed(address: Address): Promise<void> {
    if (await this.isDeployed(address)) return;

    const txnIds: string[] = [];
    const failed = (message: string, cause?: unknown) =>
      new OMSWalletPrivacyError({
        code: txnIds.length > 0 ? 'OMS_PRIVACY_TRANSACTION_FAILED' : 'OMS_PRIVACY_WALLET_ERROR',
        operation: 'privacy.setup',
        stage: 'setup',
        txnIds,
        message,
        cause
      });
    let response: SendTransactionResponse;
    try {
      response = await this.oms.wallet.sendTransaction({
        network: KEY_NETWORK,
        to: address,
        data: '0x',
        expectedWallet: address,
        waitForStatus: true,
        onPrepared: (txnId) => {
          txnIds.push(txnId);
        }
      });
    } catch (error) {
      throw failed(
        `The wallet could not be deployed on ${KEY_NETWORK.displayName}, which private balances need once; see cause.`,
        error
      );
    }
    if (response.status !== 'executed') {
      throw failed(`The wallet deployment on ${KEY_NETWORK.displayName} is ${response.status}.`);
    }
    for (let attempt = 0; attempt < DEPLOY_VISIBLE_ATTEMPTS; attempt += 1) {
      if (await this.isDeployed(address)) return;
      await new Promise((resolve) => setTimeout(resolve, DEPLOY_VISIBLE_INTERVAL_MS));
    }
    throw failed(
      `The wallet deployment on ${KEY_NETWORK.displayName} is not visible yet. Retry shortly.`
    );
  }

  private async isDeployed(address: Address): Promise<boolean> {
    try {
      return await this.keyChain.isDeployed(address);
    } catch {
      throw new OMSWalletPrivacyError({
        code: 'OMS_PRIVACY_SERVICE_ERROR',
        operation: 'privacy.setup',
        stage: 'setup',
        message: `The wallet's state on ${KEY_NETWORK.displayName} could not be read.`
      });
    }
  }

  private async awaitBackend(entry: Entry, operation: string): Promise<PrivacyBackend> {
    try {
      return await entry.backend;
    } catch (error) {
      if (error instanceof OMSWalletPrivacyError) throw error;
      throw new OMSWalletPrivacyError({
        code: isOMSWalletError(error) ? 'OMS_PRIVACY_WALLET_ERROR' : 'OMS_PRIVACY_SERVICE_ERROR',
        operation,
        stage: 'setup',
        message: isOMSWalletError(error)
          ? 'The wallet could not authorize the private balance; see cause.'
          : 'The privacy service could not be set up.',
        cause: error
      });
    }
  }

  private scheduleIdle(entry: Entry): void {
    entry.idleTimer = setTimeout(() => this.close(entry), IDLE_TIMEOUT_MS);
    // Lets a Node process exit while the backend is idle.
    (entry.idleTimer as { unref?: () => void }).unref?.();
  }

  /** Stops new operations on `entry` and destroys its backend once running ones finish. */
  private close(entry: Entry): void {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.unsubscribe();
    if (entries.get(this.oms.wallet) === entry) entries.delete(this.oms.wallet);
    void entry.tail
      .then(() => entry.backend)
      .then((backend) => backend.destroy())
      .catch(() => {});
  }
}

export function walletChanged(
  operation: string,
  txnIds?: ReadonlyArray<string>
): OMSWalletPrivacyError {
  return new OMSWalletPrivacyError({
    code: 'OMS_PRIVACY_WALLET_CHANGED',
    operation,
    txnIds,
    message: 'The active wallet changed.'
  });
}
