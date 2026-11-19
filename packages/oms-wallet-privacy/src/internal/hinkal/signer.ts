import type * as Ethers from 'ethers';
import type { Address, Hex } from 'viem';

import type { BackendWalletCall } from '../../backend.js';

/** Where the signer sends transactions; set only while an operation that may send runs. */
export interface SignerState {
  send: ((call: BackendWalletCall) => Promise<Hex>) | undefined;
}

/**
 * An ethers signer over the OMS wallet, for the provider. It never signs: keys come from a
 * signature taken before setup. Transactions go to `state.send`, which applies the operation's
 * policy and sends through `WalletClient.sendTransaction`; outside an operation they are refused.
 * Built from the provider's own ethers instance (see `load.ts`).
 */
export function createSigner(
  ethers: typeof Ethers,
  address: Address,
  state: SignerState,
  provider: Ethers.Provider
): Ethers.Signer {
  class WalletSigner extends ethers.AbstractSigner {
    override connect(next: Ethers.Provider | null): Ethers.Signer {
      if (!next) throw new Error('A provider is required.');
      return new WalletSigner(next);
    }

    override async getAddress(): Promise<string> {
      return address;
    }

    override async signMessage(): Promise<string> {
      throw new Error('Message signing is not available.');
    }

    override async signTypedData(): Promise<string> {
      throw new Error('Typed-data signing is not available.');
    }

    override async signTransaction(): Promise<string> {
      throw new Error('Raw transaction signing is not available.');
    }

    override async sendTransaction(
      tx: Ethers.TransactionRequest
    ): Promise<Ethers.TransactionResponse> {
      const send = state.send;
      if (!send) throw new Error('No wallet transaction is expected now.');
      const provider = this.provider;
      if (!provider) throw new Error('No provider.');
      if (tx.from != null) {
        const from = await ethers.resolveAddress(tx.from, provider);
        if (ethers.getAddress(from) !== ethers.getAddress(address))
          throw new Error('Wrong sender.');
      }
      if (tx.to == null) throw new Error('Contract creation is not allowed.');
      const to = ethers.getAddress(await ethers.resolveAddress(tx.to, provider)) as Address;
      // Gas, nonce and fee fields are ignored: the wallet prepares and relays the transaction.
      const hash = await send({
        to,
        data: (tx.data ?? '0x') as Hex,
        value: tx.value == null ? 0n : BigInt(tx.value)
      });
      // The provider reads only `hash`; return the real transaction, never a made-up one.
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await provider.getTransaction(hash);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      throw new Error('The transaction is not visible on chain.');
    }
  }
  return new WalletSigner(provider);
}

/**
 * Answers only `getNetwork` until the provider connects the signer to its own RPC provider for the
 * chain an operation runs on.
 */
export function createInitialProvider(ethers: typeof Ethers, chainId: number): Ethers.Provider {
  class InitialProvider extends ethers.AbstractProvider {
    override async _detectNetwork(): Promise<Ethers.Network> {
      return ethers.Network.from(chainId);
    }
    override async _perform(): Promise<never> {
      throw new Error('Not connected to a network yet.');
    }
  }
  return new InitialProvider(chainId);
}
