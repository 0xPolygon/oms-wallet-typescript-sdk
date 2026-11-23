import { attestationVerificationErrorPrefix } from './errors.js';
import {
  ATTESTATION_BOUND_HEADER,
  ATTESTATION_DOCUMENT_HEADER,
  ATTESTATION_NONCE_HEADER,
  normalizeTrustedPcr0s,
  randomAttestationNonce,
  verifyAttestationDocument
} from './internal/protocol/attestation.js';

type Fetch = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

class AttestationVerificationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`${attestationVerificationErrorPrefix}${message}`, options);
    this.name = 'OMSWalletAttestationVerificationError';
  }
}

/**
 * Verifies the attestation of every response `fetch` returns. `fetch` must be the one that sends the
 * request as it is: a `Sequence/2` attestation binds the request's signature header, so the
 * header checked is the one sent.
 */
export function createAttestedFetch(fetch: Fetch, trustedPcr0s: ReadonlyArray<string>): Fetch {
  const trustedMeasurements = normalizeTrustedPcr0s(trustedPcr0s);

  return async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
    const nonce = randomAttestationNonce();
    const headers = new Headers(init?.headers);
    headers.set(ATTESTATION_NONCE_HEADER, nonce);

    const requestHeaders: Record<string, string> = {};
    headers.forEach((value, key) => {
      requestHeaders[key] = value;
    });
    const requestInit = { ...init, headers: requestHeaders };
    const response = await fetch(input, requestInit);
    try {
      const responseBody = await response.clone().text();
      const attestationDocument = response.headers.get(ATTESTATION_DOCUMENT_HEADER);
      if (!attestationDocument) {
        throw new Error('WaaS response is missing its attestation document');
      }

      const url = new URL(typeof input === 'string' ? input : input.url);
      await verifyAttestationDocument({
        encodedDocument: attestationDocument,
        method: requestInit.method ?? 'GET',
        path: url.pathname,
        boundHeader: headers.get(ATTESTATION_BOUND_HEADER) ?? '',
        requestBody: typeof requestInit.body === 'string' ? requestInit.body : '',
        responseBody,
        nonce,
        trustedPcr0s: trustedMeasurements
      });
    } catch (error) {
      throw new AttestationVerificationError(
        error instanceof Error ? error.message : 'WaaS attestation verification failed',
        { cause: error }
      );
    }

    return response;
  };
}
