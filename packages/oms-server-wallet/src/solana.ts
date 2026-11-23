import type { ChainOperation } from './chains.js';
import type { FeeOption } from './protocol.js';

import { base58Decode, isSolanaAddress } from './addresses.js';
import { ChainWallet } from './chains.js';
import { WalletError } from './errors.js';

export const SOLANA_NETWORKS = ['solana:mainnet', 'solana:devnet'] as const;
export type SolanaNetwork = (typeof SOLANA_NETWORKS)[number];
/** SOL is native; any other asset is a token mint, on the SPL Token or Token-2022 program. */
export interface SolanaTransfer {
  network: SolanaNetwork;
  to: string;
  asset: 'native' | string;
  /** Base units: lamports for SOL, the mint's smallest unit otherwise. At most u64. */
  amount: string;
}
export interface SolanaOperation extends ChainOperation {
  family: 'solana';
  kind: 'transfer' | 'sign';
  network?: SolanaNetwork;
  transfer?: SolanaTransfer;
}

const transferFields = ['network', 'to', 'asset', 'amount'];
const MAX_MESSAGE_BYTES = 16_384;
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function normalizeTransfer(input: unknown): SolanaTransfer {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new WalletError('INVALID_TRANSFER', 'Provide a network, recipient, asset and amount.');
  const fields = input as Record<string, unknown>;
  const unexpected = Object.keys(fields).find((key) => !transferFields.includes(key));
  if (unexpected)
    throw new WalletError('INVALID_TRANSFER', `Unexpected transfer field "${unexpected}".`);
  const { network, to, asset, amount } = fields;
  if (!SOLANA_NETWORKS.includes(network as SolanaNetwork))
    throw new WalletError('UNSUPPORTED_NETWORK', 'Select solana:mainnet or solana:devnet.');
  if (!isSolanaAddress(to) || (asset !== 'native' && !isSolanaAddress(asset)))
    throw new WalletError(
      'INVALID_ADDRESS',
      'Provide a base58 Solana recipient, and "native" or a token mint address.'
    );
  if (
    typeof amount !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(amount) ||
    BigInt(amount) >= 2n ** 64n
  )
    throw new WalletError(
      'INVALID_AMOUNT',
      'Provide a positive base-unit amount that fits in 64 bits.'
    );
  return { network: network as SolanaNetwork, to, asset, amount };
}

/**
 * The identity's Solana wallet: an Ed25519 EOA whose fees are paid by the project's Solana fee
 * payer. Only sponsored transfers are sent. A Solana quote lasts about a minute, the life of its
 * blockhash, so review must be quick or automated; `sendTransfer` prepares and submits at once.
 */
export class SolanaWallet extends ChainWallet<SolanaOperation> {
  protected readonly family = 'solana';

  async prepareTransfer(id: string, input: SolanaTransfer): Promise<SolanaOperation> {
    const transfer = normalizeTransfer(input);
    return this.context.run(() => this.prepare(id, transfer));
  }
  /** Submits the stored quote once. An expired quote fails with `TRANSACTION_EXPIRED`. */
  executeTransfer(id: string): Promise<SolanaOperation> {
    return this.context.run(() => this.executeLocked(id, ['transfer']));
  }
  /** Prepare and submit in one turn of the executor, so the short quote is not spent waiting. */
  async sendTransfer(id: string, input: SolanaTransfer): Promise<SolanaOperation> {
    const transfer = normalizeTransfer(input);
    return this.context.run(async () => {
      const op = await this.prepare(id, transfer);
      return this.executeLocked(op.id, ['transfer']);
    });
  }
  /** Signs a Solana off-chain message and checks the signature with WaaS. */
  async signMessage(id: string, message: string): Promise<SolanaOperation> {
    if (
      typeof message !== 'string' ||
      !message ||
      loneSurrogate.test(message) ||
      new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES
    )
      throw new WalletError('INVALID_MESSAGE', 'Messages must contain 1–16,384 UTF-8 bytes.');
    return this.signLocked(
      id,
      'sign',
      { message },
      (wallet) => ({
        method: 'SignMessage',
        params: { network: '', walletId: wallet.id, message }
      }),
      (wallet, signature) => ({
        valid: base58Decode(signature)?.length === 64,
        method: 'IsValidMessageSignature',
        params: { networkFamily: 'solana', walletAddress: wallet.address, message, signature }
      })
    );
  }

  private prepare(id: string, transfer: SolanaTransfer) {
    return this.prepareLocked(
      id,
      'transfer',
      { ...transfer },
      { network: transfer.network, transfer },
      (wallet) => {
        if (transfer.to === wallet.address)
          throw new WalletError('INVALID_ADDRESS', 'The recipient cannot be the sending wallet.');
        return {
          method: 'PrepareSolanaTransfer',
          params: {
            network: transfer.network,
            walletId: wallet.id,
            asset: transfer.asset === 'native' ? 'SOL' : transfer.asset,
            recipient: { address: transfer.to },
            amount: transfer.amount,
            mode: 'relayer'
          }
        };
      }
    );
  }
  protected payment(op: SolanaOperation): FeeOption | undefined {
    if (op.quote?.sponsored) return undefined;
    throw new WalletError(
      'SPONSORSHIP_REQUIRED',
      'This transfer is not sponsored. Enable the Solana fee payer for this project and network.',
      409
    );
  }
}
