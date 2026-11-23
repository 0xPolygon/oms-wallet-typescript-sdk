// DO NOT EDIT. Copied from packages/oms-wallet-protocol/src/requestSigning.ts by
// `pnpm --filter oms-wallet-protocol sync`; edit the source there and run it again.

/** Header that carries a credential's signature over a WaaS request. */
export const WALLET_SIGNATURE_HEADER = 'OMS-Wallet-Signature';

export type WalletSignatureAlgorithm = 'ecdsa-p256-sha256' | 'ecdsa-p256k-eip191';

/**
 * The text a credential signs for a WaaS request. `path` is the request path, for example
 * `/v1/Waas/SignMessage`; `scope` is the project ID.
 */
export function walletRequestPreimage(
  path: string,
  nonce: string,
  scope: string,
  body: string
): string {
  return `POST ${path}\nnonce: ${nonce}\nscope: ${scope}\n\n${body}`;
}

export function walletSignatureHeader(params: {
  algorithm: WalletSignatureAlgorithm;
  scope: string;
  credential: string;
  nonce: string;
  signature: string;
}): string {
  return `alg="${params.algorithm}", scope="${params.scope}", cred="${params.credential}", nonce=${params.nonce}, sig="${params.signature}"`;
}

/**
 * The nonce for a credential's next request. WaaS accepts a nonce only when it is higher than the
 * credential's last one; starting from the clock keeps a reset counter ahead of earlier requests.
 */
export function nextWalletNonce(previous: bigint, now: number = Date.now()): bigint {
  const clock = BigInt(now);
  return clock > previous ? clock : previous + 1n;
}
