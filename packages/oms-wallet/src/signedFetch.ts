import type { CredentialSigner } from './credentialSigner.js';

import { RequestUtils } from './utils/requestUtils.js';

type Fetch = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

/**
 * Resends after WaaS rejects a nonce as not higher than the last one (`PreconditionFailed`, 7206),
 * which concurrent requests can cause. WaaS rejects it before running any method, so resending is
 * safe even for writes.
 */
const MAX_NONCE_RETRIES = 2;

/**
 * How long a signed request may take, including its waits at the session request gates and its
 * signing. Neither `fetch` nor a custom signer has a deadline of its own.
 */
const SIGNED_REQUEST_TIMEOUT_MS = 30_000;

/** Signals of requests that reached `fetch`: a request whose signal is not here was never sent. */
const sentRequestSignals = new WeakSet<AbortSignal>();

/** Whether the request made with `signal` reached `fetch`, so WaaS may have received it. */
export function wasRequestSent(signal: AbortSignal): boolean {
  return sentRequestSignals.has(signal);
}

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
  // Another tab can replace a shared key while concurrent requests are signed, so the signature may
  // come from a key the header's credential ID does not name. Such a request is never sent.
  if ((await signer.credentialId()) !== credentialId) {
    throw new Error('Credential signer key changed while signing the request');
  }
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
      // A request that timed out while it was signed is never sent, however late the signer finishes.
      if (init?.signal?.aborted) {
        throw new Error('WaaS request was aborted before it was sent', {
          cause: init.signal.reason
        });
      }
      if (init?.signal) sentRequestSignals.add(init.signal);
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

/**
 * Bounds a signed request, from its waits at the request gates to its response, by
 * `SIGNED_REQUEST_TIMEOUT_MS`. The request runs under its own signal, which aborts at the deadline:
 * the signed fetch then sends nothing, and an aborted `fetch` ends a request in flight. A caller's
 * signal aborts it too, and is marked sent when the request was.
 */
export function createDeadlineFetch(fetch: Fetch, timeoutMs = SIGNED_REQUEST_TIMEOUT_MS): Fetch {
  return (input: RequestInfo, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const callerSignal = init?.signal ?? undefined;
    const abortWithCaller = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) abortWithCaller();
    else callerSignal?.addEventListener('abort', abortWithCaller, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(`WaaS request timed out after ${timeoutMs} ms`)),
      timeoutMs
    );
    (timer as { unref?: () => void }).unref?.();
    const aborted = new Promise<never>((_, reject) => {
      const rejectWithReason = () => reject(controller.signal.reason);
      if (controller.signal.aborted) rejectWithReason();
      else controller.signal.addEventListener('abort', rejectWithReason, { once: true });
    });
    aborted.catch(() => {});
    const request = fetch(input, { ...init, signal: controller.signal });
    // A signer can finish after the deadline; the request then fails without being sent.
    request.catch(() => {});
    return Promise.race([request, aborted]).finally(() => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortWithCaller);
      if (callerSignal && wasRequestSent(controller.signal)) sentRequestSignals.add(callerSignal);
    });
  };
}
