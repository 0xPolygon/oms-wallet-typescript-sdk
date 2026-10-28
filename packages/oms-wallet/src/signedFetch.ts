import type { CredentialSigner } from './credentialSigner.js';

import { RequestUtils } from './utils/requestUtils.js';

type Fetch = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

/**
 * Resends after WaaS rejects a nonce as not higher than the last one (`PreconditionFailed`, 7206),
 * which concurrent requests can cause. WaaS rejects it before running any method, so resending is
 * safe even for writes.
 */
const MAX_NONCE_RETRIES = 2;

async function buildWalletSignatureHeader(
  endpoint: string,
  signer: CredentialSigner,
  payload: string,
  projectId: string
): Promise<string> {
  const credentialId = await signer.credentialId();
  const nonce = await signer.nextNonce();
  const preimage = RequestUtils.buildWalletRequestPreimage(endpoint, nonce, projectId, payload);
  const signature = await signer.sign(preimage);
  return RequestUtils.buildWalletSignatureHeader(
    signer.signingAlgorithm,
    projectId,
    credentialId,
    nonce,
    signature
  );
}

/** Whether a WaaS response rejects the request nonce (`PreconditionFailed`, 7206). */
async function isNonceRejectedResponse(response: Response): Promise<boolean> {
  if (response.status !== 412) return false;
  try {
    const body = (await response.clone().json()) as { code?: unknown };
    return body?.code === 7206;
  } catch {
    return false;
  }
}

export function createSignedFetch(
  publishableKey: string,
  signer: CredentialSigner,
  projectId: string
): Fetch {
  return async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const segments = new URL(url).pathname.split('/');
    const endpoint = '/' + segments[segments.length - 1];

    const body = typeof init?.body === 'string' ? init.body : '';

    const headers: Record<string, string> = {};
    if (init?.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(init?.headers)) {
      Object.assign(headers, Object.fromEntries(init.headers));
    } else if (init?.headers) {
      Object.assign(headers, init.headers);
    }
    headers['Api-Key'] = publishableKey;

    for (let retry = 0; ; retry += 1) {
      // Each attempt is signed again, so a resent request carries a fresh, higher nonce.
      const signatureHeader = await buildWalletSignatureHeader(endpoint, signer, body, projectId);
      const response = await globalThis.fetch(input, {
        ...init,
        headers: { ...headers, 'OMS-Wallet-Signature': signatureHeader }
      });
      if (retry >= MAX_NONCE_RETRIES || !(await isNonceRejectedResponse(response))) {
        return response;
      }
    }
  };
}
