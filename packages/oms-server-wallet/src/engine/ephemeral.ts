import type { NetworkFamily } from '../protocol.js';
import type { State } from '../state.js';
import type {
  EphemeralWalletSnapshot,
  SignatureResult,
  TronNetwork,
  TypedDataInput
} from '../types.js';
import type { EngineCore } from './core.js';

import { requireChain } from '../environment.js';
import { WalletError } from '../errors.js';
import { TRON_CHAIN_IDS } from '../internal/protocol/networks.js';
import { NETWORK_FAMILIES } from '../protocol.js';
import { validateTronTypedData, validateTypedData } from '../typed-data.js';
import { requireMessage, requireTronNetwork } from './inputs.js';
import {
  assertNotSelfVerifying,
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
 * Memory-only signer for one identity. It signs and reads balances but never prepares, sends or
 * records operations, and never creates wallets. Every call runs under the handle's private
 * executor; once `close()` starts, every later or queued call throws `WALLET_CLOSED`.
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

  async restore(families?: readonly NetworkFamily[]): Promise<EphemeralWalletSnapshot> {
    if (
      families !== undefined &&
      (!Array.isArray(families) ||
        !families.length ||
        families.some((family) => !NETWORK_FAMILIES.includes(family)))
    )
      throw new WalletError('INVALID_FAMILY', 'Request one or more of: evm, solana, tron.');
    const requested = families ? [...new Set(families)] : undefined;
    return this.run(async (state) => {
      await this.core.restoreExisting(state, requested);
      return this.snapshot(state);
    });
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
    const { typedData } = validateTypedData(input, chainId);
    assertPublicTypedData(typedData);
    return this.run(async (state) => {
      const wallet = this.requireWallet(state, 'evm');
      assertNotSelfVerifying(typedData, wallet.address);
      await this.core.ensure(state, ['evm']);
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
    const { typedData } = validateTronTypedData(input, TRON_CHAIN_IDS[validNetwork]);
    return this.run(async (state) => {
      this.requireWallet(state, 'tron');
      await this.core.ensure(state, ['tron']);
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
