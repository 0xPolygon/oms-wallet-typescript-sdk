import type { Address, Hex } from 'viem';

import { getAddress } from 'viem';

import type {
  OMSWallet,
  OMSWalletExtensionContext,
  StorageManager,
  WalletClient
} from '@polygonlabs/oms-wallet';

import { Networks, isOMSWalletError } from '@polygonlabs/oms-wallet';

import type { CreateBackend, PrivacyBackend } from './backend.js';

import { OMSWalletPrivacyError } from './errors.js';
import { innerKeySignature } from './keySignature.js';
import { privacyNetworks } from './networks.js';

/**
 * Signed once per setup to derive the private-balance keys. The prefix makes OMS Wallet refuse it
 * in `signMessage`, so code that can only call `signMessage` (a connected dApp) cannot obtain it.
 * Never change this text or the network it is signed on: a different signature means different
 * keys and no access to funds.
 *
 * Keys come from the wallet key's own signature inside the result, not the full signature, which
 * changes with deployment and configuration updates (see keySignature.ts).
 */
export const KEY_MESSAGE =
  'OMS Wallet reserved message: private balance keys v1\n\n' +
  'Signing this derives the keys of your private balance.';
const KEY_NETWORK = Networks.polygon;

/** Torn down after this long without an operation. */
export const IDLE_TIMEOUT_MS = 60_000;

// v1 and v2 fingerprints came from full wallet signatures, which can change; v3 keys come from
// the wallet key's inner signature (see keySignature.ts), so earlier ones are not compared.
const fingerprintKey = (address: Address) =>
  `oms-wallet-privacy/key-fingerprint/v3/${address.toLowerCase()}`;

interface Entry {
  readonly address: Address;
  /** Set up by the entry's first operation, in the queue, so it never overlaps an earlier one. */
  backend: Promise<PrivacyBackend> | undefined;
  /** The last of this entry's operations, settled; the backend is destroyed after it. */
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
 * The last queued operation per wallet client, settled. Operations run one at a time across
 * entries, so one started for a wallet before it was switched away and back cannot overlap one
 * started after.
 */
const queues = new WeakMap<WalletClient, Promise<unknown>>();

/**
 * Runs privacy operations for the active wallet. Backends are created on first use and torn down
 * after `IDLE_TIMEOUT_MS` without operations or when the active wallet changes.
 */
export class PrivacySessions {
  constructor(
    private readonly oms: OMSWallet,
    private readonly context: OMSWalletExtensionContext,
    private readonly storage: StorageManager,
    private readonly createBackend: CreateBackend
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
   * `action` receives the address it is bound to and `requireCurrent`, which throws
   * `OMS_PRIVACY_WALLET_CHANGED` once the active wallet has changed since the operation started,
   * even if the same wallet is active again. Wallet calls act for the wallet active when they are
   * made, so `action` calls `requireCurrent` synchronously right before each one and right before
   * anything is submitted.
   */
  async run<T>(
    operation: string,
    action: (
      backend: PrivacyBackend,
      address: Address,
      requireCurrent: RequireCurrent
    ) => Promise<T>
  ): Promise<T> {
    const address = this.activeAddress(operation);
    const wallet = this.oms.wallet;
    const entry = this.entryFor(address);
    entry.pending += 1;
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;

    const requireCurrent: RequireCurrent = (txnIds) => {
      if (entry.walletChanged) throw walletChanged(operation, txnIds);
      requireActive(this.oms, address, operation, txnIds);
    };
    const result = (queues.get(wallet) ?? Promise.resolve()).then(async () => {
      requireCurrent();
      // After a failed setup this throws that failure, for every operation queued behind it.
      const backend = await this.awaitBackend(entry, operation);
      return action(backend, address, requireCurrent);
    });
    const settled = result.catch(() => undefined);
    queues.set(wallet, settled);
    entry.tail = settled;
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
      backend: undefined,
      tail: Promise.resolve(),
      pending: 0,
      idleTimer: undefined,
      closed: false,
      walletChanged: false,
      unsubscribe: () => {}
    };
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
    requireActive(this.oms, address, 'privacy.setup');
    const fullSignature = (await this.context.signReservedMessage({
      network: KEY_NETWORK,
      message: KEY_MESSAGE
    })) as Hex;
    const keySignature = await this.keySignature(address, fullSignature);
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
   * The wallet key's own signature inside `fullSignature`, after WaaS confirms `fullSignature` is a
   * valid signature by the wallet. Only that inner signature is stable: the full one changes with
   * deployment and configuration updates.
   */
  private async keySignature(address: Address, fullSignature: Hex): Promise<Hex> {
    const fail = (message: string) =>
      new OMSWalletPrivacyError({
        code: 'OMS_PRIVACY_KEY_MISMATCH',
        operation: 'privacy.setup',
        stage: 'setup',
        message
      });
    let extracted: { signature: Hex; signer: Address };
    try {
      extracted = await innerKeySignature({
        signature: fullSignature,
        wallet: address,
        chainId: KEY_NETWORK.id,
        message: KEY_MESSAGE
      });
    } catch {
      throw fail(
        'The wallet returned a signature this package cannot derive keys from. Nothing was sent.'
      );
    }
    // The extracted key signature alone meets the wallet's threshold, so a valid full signature
    // means its signer is the wallet's authorized key.
    const valid = await this.oms.wallet.isValidMessageSignature({
      network: KEY_NETWORK,
      walletAddress: address,
      message: KEY_MESSAGE,
      signature: fullSignature
    });
    if (!valid) throw fail('The wallet signature could not be verified. Nothing was sent.');
    return extracted.signature;
  }

  private async awaitBackend(entry: Entry, operation: string): Promise<PrivacyBackend> {
    if (!entry.backend) {
      const wallet = this.oms.wallet;
      entry.backend = this.setup(entry.address);
      // A failed setup is reported by the operation that awaits it; the next call starts over.
      entry.backend.catch(() => {
        if (entries.get(wallet) === entry) this.close(entry);
      });
    }
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
      .then((backend) => backend?.destroy())
      .catch(() => {});
  }
}

/** Throws `OMS_PRIVACY_WALLET_CHANGED`, with `txnIds` if given, unless the operation's wallet is still current. */
export type RequireCurrent = (txnIds?: ReadonlyArray<string>) => void;

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

/**
 * Throws `OMS_PRIVACY_WALLET_CHANGED` unless `address` is the active wallet. Call it in the same
 * synchronous step as the wallet call it guards: the wallet binds each call to the wallet active
 * when the call is made.
 */
export function requireActive(
  oms: OMSWallet,
  address: Address,
  operation: string,
  txnIds?: ReadonlyArray<string>
): void {
  const active = oms.wallet.activeWallet;
  if (active?.type !== 'ethereum' || active.address.toLowerCase() !== address.toLowerCase()) {
    throw walletChanged(operation, txnIds);
  }
}
