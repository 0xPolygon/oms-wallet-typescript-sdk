import type { Address } from 'viem';

import type {
  CredentialInfo,
  CredentialMetadata,
  Wallet as GeneratedWallet
} from '../generated/waas.gen.js';
import type { AccessGrant, RemoteCredentialMetadata } from '../types/accessGrant.js';
import type { WalletAccount } from '../wallet.js';

import { CredentialType } from '../generated/waas.gen.js';
import { WalletType } from '../types/waas.js';
import { fromGeneratedSmartSessionGrant } from './accessGrant.js';
import { invalidResponseError } from './invalidResponse.js';
import { fromGeneratedNetworkFamily, fromGeneratedWalletKeyOrigin } from './waasTypes.js';

export function fromGeneratedWallet(wallet: GeneratedWallet | undefined): WalletAccount {
  if (!wallet || !wallet.id?.trim() || !wallet.address?.trim()) {
    throw invalidResponseError('Wallet response is missing required fields');
  }
  if (!wallet.networkFamily) {
    throw invalidResponseError('Wallet response is missing networkFamily');
  }
  if (!wallet.keyOrigin) {
    throw invalidResponseError('Wallet response is missing keyOrigin');
  }
  const type = fromGeneratedNetworkFamily(wallet.networkFamily);
  const keyOrigin = fromGeneratedWalletKeyOrigin(wallet.keyOrigin);
  if (type === WalletType.Ethereum) {
    return {
      id: wallet.id,
      type,
      address: wallet.address as Address,
      reference: wallet.reference,
      keyOrigin
    };
  }
  return {
    id: wallet.id,
    type,
    address: wallet.address,
    reference: wallet.reference,
    keyOrigin
  };
}

export function fromGeneratedAccessGrant(credential: CredentialInfo | undefined): AccessGrant {
  if (
    !credential ||
    !credential.credentialId?.trim() ||
    !credential.expiresAt?.trim() ||
    typeof credential.isCaller !== 'boolean'
  ) {
    throw invalidResponseError('Access entry is missing required fields');
  }
  if (credential.type === CredentialType.Direct) {
    return {
      type: 'direct',
      credentialId: credential.credentialId,
      expiresAt: credential.expiresAt,
      isCaller: credential.isCaller
    };
  }

  if (credential.type !== CredentialType.Remote) {
    throw invalidResponseError(
      `Access entry has unsupported credential type: ${String(credential.type)}`
    );
  }
  if (!credential.sessionId || !credential.metadata || !Array.isArray(credential.grants?.entries)) {
    throw invalidResponseError('Remote access entry is missing session data');
  }

  return {
    type: 'remote',
    credentialId: credential.credentialId,
    sessionId: credential.sessionId,
    metadata: fromGeneratedRemoteCredentialMetadata(credential.metadata),
    grants: credential.grants.entries.map(fromGeneratedSmartSessionGrant),
    expiresAt: credential.expiresAt,
    isCaller: credential.isCaller
  };
}

export function fromGeneratedRemoteCredentialMetadata(
  metadata: CredentialMetadata | undefined
): RemoteCredentialMetadata {
  if (
    !metadata ||
    typeof metadata.appUrl !== 'string' ||
    typeof metadata.appName !== 'string' ||
    typeof metadata.appLogoUrl !== 'string' ||
    typeof metadata.custom !== 'object' ||
    metadata.custom === null ||
    Array.isArray(metadata.custom) ||
    Object.values(metadata.custom).some((value) => typeof value !== 'string')
  ) {
    throw invalidResponseError('Remote credential metadata is invalid');
  }
  return {
    appUrl: metadata.appUrl,
    appName: metadata.appName,
    appLogoUrl: metadata.appLogoUrl,
    custom: { ...metadata.custom }
  };
}
