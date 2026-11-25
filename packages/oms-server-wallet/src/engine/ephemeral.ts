import type { NetworkFamily } from '../protocol.js';
import type { State } from '../state.js';
import type {
  EphemeralWalletSnapshot,
  IdentityWallet,
  SignatureResult,
  TronNetwork,
  TypedDataInput
} from '../types.js';
import type { EngineCore } from './core.js';

import { requireChain } from '../environment.js';
import { WalletError } from '../errors.js';
import { tronToHex } from '../internal/protocol/addresses.js';
import { TRON_CHAIN_IDS } from '../internal/protocol/networks.js';
import { NETWORK_FAMILIES } from '../protocol.js';
import { validateTronTypedData, validateTypedData } from '../typed-data.js';
import { validateFamilies, validateSelection } from './core.js';
import { requireMessage, requireTronNetwork } from './inputs.js';
import {
  assertNotSelfVerifying,
  authorizeTypedData,
  assertPublicTypedData,
  requestChainSignature,
  requestEvmMessageSignature,
  requestEvmTypedDataSignature,
  solanaMessageRequest,
  tronMessageRequest,
  tronTypedDataRequest
} from './signing.js';

const closedError = () =>
  new WalletError('WALLET_CLOSED', 'This ephemeral wallet handle has been closed.', 409);

const familyLabel: Record<NetworkFamily, string> = { evm: 'EVM', solana: 'Solana', tron: 'Tron' };

/**
 * Wallet creations in flight in this process, by identity namespace. A handle creating wallets for
 * an identity waits for any other handle in the process that is already doing so, then discovers
 * what that one created instead of creating a second wallet.
 */
const creating = new Map<string, Promise<unknown>>();

/**
 * Memory-only signer for one identity. It signs and reads balances but never prepares, sends or
 * records operations. `restore()` never creates wallets; only `create()` does. Every call runs
 * under the handle's private executor; once `close()` starts, every later or queued call throws
 * `WALLET_CLOSED`.
 */
export class EphemeralEngine {
  private closed = false;

  constructor(private readonly core: EngineCore) {}

  private run<T>(task: (state: State) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(closedError());
    return this.core.config.executor.run(async () => {
      if (this.closed) throw closedError();
      return task(await this.core.load());
    });
  }

  private snapshot(state: State): EphemeralWalletSnapshot {
    return {
      wallets: { ...state.wallets },
      expiresAt: state.credential?.expiresAt,
      credentialId: state.credential?.credentialId
    };
  }

  private requireWallet(state: State, family: NetworkFamily) {
    const wallet = state.wallets[family];
    if (!wallet)
      throw new WalletError(
        'WALLET_NOT_INITIALIZED',
        `${familyLabel[family]} wallet has not been restored on this handle. Call restore() first.`,
        409
      );
    return wallet;
  }

  async restore(
    families?: readonly NetworkFamily[],
    selection?: unknown
  ): Promise<EphemeralWalletSnapshot> {
    const requested = families === undefined ? undefined : validateFamilies(families);
    const pins = validateSelection(selection);
    return this.run(async (state) => {
      await this.core.restoreExisting(state, requested, pins);
      return this.snapshot(state);
    });
  }

  /**
   * Bind existing wallets and create the missing ones. Concurrent `create()` calls for one
   * identity within this process run one at a time; across processes the caller must ensure
   * only one creates a new identity's wallets.
   */
  async create(
    families: readonly NetworkFamily[] = ['evm'],
    selection?: unknown
  ): Promise<EphemeralWalletSnapshot> {
    const requested = validateFamilies(families);
    const pins = validateSelection(selection);
    const key = this.core.config.namespace;
    for (let pending = creating.get(key); pending; pending = creating.get(key))
      await pending.catch(() => undefined);
    const task = this.run(async (state) => {
      await this.core.ensure(state, requested, { create: true, pins });
      return this.snapshot(state);
    });
    creating.set(key, task);
    try {
      return await task;
    } finally {
      if (creating.get(key) === task) creating.delete(key);
    }
  }

  /** Every wallet WaaS holds for this identity, including duplicates (see `restore`'s `wallets`). */
  listWallets(): Promise<readonly IdentityWallet[]> {
    if (this.closed) return Promise.reject(closedError());
    return this.core.listWallets();
  }

  inspect(): Promise<EphemeralWalletSnapshot> {
    return this.run(async (state) => this.snapshot(state));
  }

  rotateCredential(): Promise<EphemeralWalletSnapshot> {
    return this.run(async (state) => {
      const held = NETWORK_FAMILIES.filter((family) => state.wallets[family]);
      if (!held.length)
        throw new WalletError(
          'WALLET_NOT_INITIALIZED',
          'No wallet has been restored on this handle. Call restore() first.',
          409
        );
      await this.core.revoke(state);
      await this.core.ensure(state, held);
      return this.snapshot(state);
    });
  }

  /**
   * Mark the handle closed, then revoke its credential. Idempotent: a later call revokes again if
   * an earlier revoke failed, and does nothing once the credential is gone.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.core.config.executor.run(async () => {
      const state = await this.core.load();
      if (state.credential) await this.core.revoke(state);
    });
  }

  /** The restored address of a family, for balance reads. */
  address(family: NetworkFamily): Promise<string> {
    return this.run(async (state) => this.requireWallet(state, family).address);
  }

  async signEvmMessage(chainId: number, message: string): Promise<SignatureResult> {
    requireChain(chainId);
    const text = requireMessage(message, false);
    return this.run(async (state) => {
      this.requireWallet(state, 'evm');
      await this.core.ensure(state, ['evm']);
      return verified(await requestEvmMessageSignature(this.core, state, chainId, text));
    });
  }

  async signEvmTypedData(chainId: number, input: TypedDataInput): Promise<SignatureResult> {
    // Snapshot synchronously so callers cannot mutate an authorization while it is queued.
    const { typedData, digest } = validateTypedData(input, chainId);
    assertPublicTypedData(typedData);
    return this.run(async (state) => {
      const wallet = this.requireWallet(state, 'evm');
      assertNotSelfVerifying(typedData, wallet.address);
      await this.core.ensure(state, ['evm']);
      await authorizeTypedData(this.core, {
        family: 'evm',
        chainId,
        walletAddress: wallet.address,
        digest,
        typedData
      });
      return verified(await requestEvmTypedDataSignature(this.core, state, chainId, typedData));
    });
  }

  async signSolanaMessage(message: string): Promise<SignatureResult> {
    const text = requireMessage(message, true);
    return this.run(async (state) => {
      this.requireWallet(state, 'solana');
      await this.core.ensure(state, ['solana']);
      const signature = await requestChainSignature(
        this.core,
        state,
        'solana',
        solanaMessageRequest(text)
      );
      return { signature, verified: true };
    });
  }

  async signTronMessage(message: string): Promise<SignatureResult> {
    const text = requireMessage(message, true);
    return this.run(async (state) => {
      this.requireWallet(state, 'tron');
      await this.core.ensure(state, ['tron']);
      const signature = await requestChainSignature(
        this.core,
        state,
        'tron',
        tronMessageRequest(text)
      );
      return { signature, verified: true };
    });
  }

  async signTronTypedData(network: TronNetwork, input: TypedDataInput): Promise<SignatureResult> {
    const validNetwork = requireTronNetwork(network);
    const chainId = TRON_CHAIN_IDS[validNetwork];
    const { typedData, digest } = validateTronTypedData(input, chainId);
    return this.run(async (state) => {
      const wallet = this.requireWallet(state, 'tron');
      assertNotSelfVerifying(typedData, tronToHex(wallet.address));
      await this.core.ensure(state, ['tron']);
      await authorizeTypedData(this.core, {
        family: 'tron',
        chainId,
        network: validNetwork,
        walletAddress: wallet.address,
        digest,
        typedData
      });
      const signature = await requestChainSignature(
        this.core,
        state,
        'tron',
        tronTypedDataRequest(typedData)
      );
      return { signature, verified: true };
    });
  }
}

function verified(result: { signature: string; valid: boolean }): SignatureResult {
  if (!result.valid)
    throw new WalletError(
      'SIGNATURE_INVALID',
      'WaaS returned a signature that did not verify.',
      502
    );
  return { signature: result.signature, verified: true };
}
