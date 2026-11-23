import type { CredentialSigningAlgorithm } from '../credentialSigner.js';

import { base64UrlEncodeBytes } from '../internal/protocol/encoding.js';
import {
  walletRequestPreimage,
  walletSignatureHeader
} from '../internal/protocol/requestSigning.js';

export class RequestUtils {
  static buildWalletRequestPreimage(
    endpoint: string,
    nonce: string,
    scope: string,
    payload: string
  ): string {
    return walletRequestPreimage(`/v1/Waas${endpoint}`, nonce, scope, payload);
  }

  static buildWalletSignatureHeader(
    alg: CredentialSigningAlgorithm,
    scope: string,
    cred: string,
    nonce: string,
    sig: string
  ): string {
    return walletSignatureHeader({
      algorithm: alg,
      scope,
      credential: cred,
      nonce,
      signature: sig
    });
  }

  static async hashEmailAuthAnswer(challenge: string, code: string): Promise<string> {
    const encoded = new TextEncoder().encode(challenge + code);
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    const bytes = new Uint8Array(hashBuffer);
    return base64UrlEncodeBytes(bytes);
  }
}
