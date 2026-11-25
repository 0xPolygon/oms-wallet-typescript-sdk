import type { RemoteWallet } from '../protocol.js';
import type { State } from '../state.js';
import type { TypedDataSigningRequest } from '../types.js';
import type { EngineCore } from './core.js';

import { WalletError } from '../errors.js';
import { parseWaas } from '../validation.js';
import {
  chainSignatureSchema,
  evmSignatureSchema,
  isSolanaSignature,
  isTronSignature,
  validSchema
} from './inputs.js';

/**
 * WaaS signing requests shared by the durable engines, which record each signature as an
 * operation, and the ephemeral signer, which keeps no records. Every function assumes the caller
 * holds the identity executor and has already ensured the family's wallet.
 */

/** Ask WaaS to sign an EIP-191 message with the EVM wallet, then ask it to verify the result. */
export async function requestEvmMessageSignature(
  core: EngineCore,
  state: State,
  chainId: number,
  message: string
): Promise<{ signature: string; valid: boolean }> {
  const { signature } = parseWaas(
    evmSignatureSchema,
    await core.activeCall(state, 'SignMessage', {
      network: String(chainId),
      walletId: state.wallets.evm!.id,
      message
    })
  );
  const { isValid } = parseWaas(
    validSchema,
    await core.config.transport.request('IsValidMessageSignature', {
      network: String(chainId),
      networkFamily: 'evm',
      walletAddress: state.wallets.evm!.address,
      message,
      signature
    })
  );
  return { signature, valid: isValid };
}

/** Ask WaaS to sign EIP-712 typed data with the EVM wallet, then ask it to verify the result. */
export async function requestEvmTypedDataSignature(
  core: EngineCore,
  state: State,
  chainId: number,
  typedData: object
): Promise<{ signature: string; valid: boolean }> {
  const { signature } = parseWaas(
    evmSignatureSchema,
    await core.activeCall(state, 'SignTypedData', {
      network: String(chainId),
      walletId: state.wallets.evm!.id,
      typedData
    })
  );
  const { isValid } = parseWaas(
    validSchema,
    await core.config.transport.request('IsValidTypedDataSignature', {
      network: String(chainId),
      walletAddress: state.wallets.evm!.address,
      typedData,
      signature
    })
  );
  return { signature, valid: isValid };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Ask the configured `signing.authorizeTypedData` policy to approve a public typed-data signature.
 * Throws `TYPED_DATA_REFUSED` unless it returns literal `true`; errors it throws pass through.
 */
export async function authorizeTypedData(
  core: EngineCore,
  request: Omit<TypedDataSigningRequest, 'subject'>
): Promise<void> {
  const policy = core.config.authorizeTypedData;
  if (!policy)
    throw new WalletError(
      'TYPED_DATA_REFUSED',
      'Typed-data signing is not enabled for this wallet. Configure signing.authorizeTypedData.',
      403
    );
  const frozen = deepFreeze(structuredClone({ ...request, subject: core.config.subject }));
  if ((await policy(frozen)) !== true)
    throw new WalletError(
      'TYPED_DATA_REFUSED',
      'The typed-data signing policy refused this request.',
      403
    );
}

/** Refuse Sequence wallet `Calls` authorizations on the public typed-data signing paths. */
export function assertPublicTypedData(typedData: {
  readonly domain: { readonly name?: string };
  readonly primaryType: string;
}): void {
  if (typedData.domain.name === 'Sequence Wallet' && typedData.primaryType === 'Calls')
    throw new WalletError(
      'INVALID_TYPED_DATA',
      'Sequence Wallet Calls authorizations cannot be signed through public signTypedData; use the reviewed recovery workflow.'
    );
}

/** Refuse typed data whose domain names the wallet itself as the verifying contract. */
export function assertNotSelfVerifying(
  typedData: { readonly domain: { readonly verifyingContract: string } },
  walletAddress: string
): void {
  if (typedData.domain.verifyingContract.toLowerCase() === walletAddress.toLowerCase())
    throw new WalletError(
      'INVALID_TYPED_DATA',
      'Typed data verifyingContract cannot be the wallet itself.'
    );
}

/** The WaaS sign and verify requests for one Solana or Tron signature. */
export interface ChainSignRequest {
  sign(wallet: RemoteWallet): { method: string; params: Record<string, unknown> };
  check(
    wallet: RemoteWallet,
    signature: string
  ): { valid: boolean; method: string; params: Record<string, unknown> };
}

export function solanaMessageRequest(message: string): ChainSignRequest {
  return {
    sign: (wallet) => ({
      method: 'SignMessage',
      params: { network: '', walletId: wallet.id, message }
    }),
    check: (wallet, signature) => ({
      valid: isSolanaSignature(signature),
      method: 'IsValidMessageSignature',
      params: { networkFamily: 'solana', walletAddress: wallet.address, message, signature }
    })
  };
}

export function tronMessageRequest(message: string): ChainSignRequest {
  return {
    sign: (wallet) => ({
      method: 'SignMessage',
      params: { network: '', walletId: wallet.id, message }
    }),
    check: (wallet, signature) => ({
      valid: isTronSignature(signature),
      method: 'IsValidMessageSignature',
      params: { networkFamily: 'tron', walletAddress: wallet.address, message, signature }
    })
  };
}

export function tronTypedDataRequest(typedData: object): ChainSignRequest {
  return {
    sign: (wallet) => ({
      method: 'SignTypedData',
      params: { network: '', walletId: wallet.id, typedData }
    }),
    check: (wallet, signature) => ({
      valid: isTronSignature(signature),
      method: 'IsValidTypedDataSignature',
      params: { networkFamily: 'tron', walletAddress: wallet.address, typedData, signature }
    })
  };
}

/**
 * Sign with the Solana or Tron wallet and have WaaS verify the signature. Throws
 * `INVALID_RESPONSE` for a malformed signature and `SIGNATURE_INVALID` when it does not verify.
 */
export async function requestChainSignature(
  core: EngineCore,
  state: State,
  family: 'solana' | 'tron',
  request: ChainSignRequest
): Promise<string> {
  const wallet = state.wallets[family]!;
  const { method, params } = request.sign(wallet);
  const { signature } = parseWaas(
    chainSignatureSchema,
    await core.activeCall(state, method, params, [family])
  );
  const verification = request.check(wallet, signature);
  if (!verification.valid)
    throw new WalletError('INVALID_RESPONSE', 'WaaS returned a malformed signature.', 502);
  const { isValid } = parseWaas(
    validSchema,
    await core.config.transport.request(verification.method, verification.params)
  );
  if (!isValid)
    throw new WalletError(
      'SIGNATURE_INVALID',
      'WaaS returned a signature that did not verify.',
      502
    );
  return signature;
}
