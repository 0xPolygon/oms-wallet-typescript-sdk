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

/**
 * Signs WaaS requests with `signer`. `publishableKey` is read for each request, so a client can move
 * to a rotated key of the same project.
 */
export function createSignedFetch(
  publishableKey: string | (() => string),
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
    headers['Api-Key'] = typeof publishableKey === 'function' ? publishableKey() : publishableKey;

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

/**
 * Sends the requests signed with one credential one at a time, in order, and across browser contexts
 * of one origin (tabs, frames, workers) under a Web Lock named after `lockNamePrefix` and the
 * credential, where the browser has Web Locks. WaaS accepts a credential's nonce only when it is
 * higher than the last one it stored, with an atomic conditional write (waas v1.2.0
 * data/credential.go), so requests sent one at a time from one nonce source are never rejected for
 * their nonce. Requests signed with different credentials cannot reject each other's nonces, so they
 * do not wait for each other. Requests from elsewhere (another process, an older SDK) can still
 * interleave, so the signed fetch keeps resending rejected nonces.
 *
 * A request leaves the queue when it settles, or when its signal aborts before it was sent: it can
 * no longer reach WaaS then, even if its signer finishes later.
 */
export function createSerialFetch(
  fetch: Fetch,
  signer: CredentialSigner,
  lockNamePrefix?: string
): Fetch {
  const queues = new Map<string, Promise<void>>();
  return async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? undefined;
    const credentialId = (await untilAborted(signer.credentialId(), signal)).toLowerCase();
    const previous = queues.get(credentialId) ?? Promise.resolve();
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => (releaseTurn = resolve));
    queues.set(credentialId, turn);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseTurn();
      if (queues.get(credentialId) === turn) queues.delete(credentialId);
    };
    try {
      await untilAborted(previous, signal);
    } catch (error) {
      // Gave up before its turn: the requests behind it still wait for the ones ahead.
      void previous.then(release);
      throw error;
    }
    const releaseIfNotSent = () => {
      if (signal && !wasRequestSent(signal)) release();
    };
    signal?.addEventListener('abort', releaseIfNotSent, { once: true });
    const lockName = lockNamePrefix && `${lockNamePrefix}:${credentialId}`;
    try {
      return await withWebLock(lockName, signal, () => fetch(input, init));
    } finally {
      signal?.removeEventListener('abort', releaseIfNotSent);
      release();
    }
  };
}

/** The parts of the Web Locks API `createSerialFetch` uses. */
interface WebLocks {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<void>
  ): Promise<void>;
}

/** Runs `run` holding the Web Lock `name`, or just runs it where Web Locks are unavailable. */
async function withWebLock<T>(
  name: string | undefined,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: WebLocks } }).navigator?.locks;
  if (!name || !locks?.request) return run();
  let result!: Promise<T>;
  await locks.request(name, signal ? { signal } : {}, async () => {
    result = run();
    // Held until the request settles or, aborted before it was sent, can no longer reach WaaS.
    await new Promise<void>((resolve) => {
      result.then(
        () => resolve(),
        () => resolve()
      );
      const resolveIfNotSent = () => {
        if (signal && !wasRequestSent(signal)) resolve();
      };
      if (signal?.aborted) resolveIfNotSent();
      else signal?.addEventListener('abort', resolveIfNotSent, { once: true });
    });
  });
  return result;
}

/** Resolves or rejects with `promise`, or rejects with the abort reason once `signal` aborts. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const rejectWithReason = () => reject(signal.reason);
    if (signal.aborted) return rejectWithReason();
    signal.addEventListener('abort', rejectWithReason, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', rejectWithReason);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', rejectWithReason);
        reject(error);
      }
    );
  });
}
