import { z } from 'zod';

import type { AttestationOptions, ResolvedEnvironment } from './environment.js';
import type { Credential } from './protocol.js';

import { environmentFromKey, resolveAttestationPolicy } from './environment.js';
import { UpstreamError, WalletError } from './errors.js';
import { boundedText } from './http.js';
import {
  ATTESTATION_BOUND_HEADER,
  ATTESTATION_DOCUMENT_HEADER,
  ATTESTATION_NONCE_HEADER,
  randomAttestationNonce,
  verifyAttestationDocument
} from './internal/protocol/attestation.js';
import { signatureHeader } from './protocol.js';

export { boundedText } from './http.js';

/** Internal RPC seam. The public factory always builds an attested `WaasTransport`. */
export interface RpcTransport {
  request(method: string, body: Record<string, unknown>, credential?: Credential): Promise<unknown>;
}

/** Every WaaS response is verified. There is deliberately no skip-attestation switch. */
export class WaasTransport implements RpcTransport {
  private readonly environment: ResolvedEnvironment;
  private readonly pcrs: ReadonlySet<string>;
  constructor(
    private readonly key: string,
    attestation: AttestationOptions = {},
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.environment = environmentFromKey(key);
    this.pcrs = resolveAttestationPolicy(this.environment, attestation);
  }
  async request(
    method: string,
    params: Record<string, unknown>,
    credential?: Credential
  ): Promise<unknown> {
    if (!/^[A-Za-z]+$/.test(method)) throw new WalletError('INVALID_METHOD', 'Invalid RPC method.');
    const path = `/v1/${credential ? 'Waas' : 'WaasPublic'}/${method}`;
    const body = JSON.stringify(params);
    const nonce = randomAttestationNonce();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Api-Key': this.key,
      [ATTESTATION_NONCE_HEADER]: nonce
    };
    if (credential)
      headers[ATTESTATION_BOUND_HEADER] = await signatureHeader(
        credential,
        path,
        this.environment.projectId,
        body
      );
    const fetcher = this.fetcher;
    let response: Response;
    let responseBody: string;
    try {
      response = await fetcher(this.environment.origin + path, {
        method: 'POST',
        body,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000)
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new WalletError('UPSTREAM_REDIRECT', 'WaaS redirects are not permitted.', 502);
      }
      responseBody = await boundedText(response);
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw new WalletError(
        'UPSTREAM_UNAVAILABLE',
        `WaaS ${method} request did not complete.`,
        502,
        { cause: error }
      );
    }
    try {
      const encodedDocument = response.headers.get(ATTESTATION_DOCUMENT_HEADER);
      if (!encodedDocument || encodedDocument.length > 64_000)
        throw new Error('Missing or oversized attestation');
      await verifyAttestationDocument({
        encodedDocument,
        method: 'POST',
        path,
        boundHeader: headers[ATTESTATION_BOUND_HEADER] ?? '',
        requestBody: body,
        responseBody,
        nonce,
        trustedPcr0s: this.pcrs
      });
    } catch {
      throw new WalletError(
        'ATTESTATION_FAILED',
        'WaaS response could not be verified against the configured enclave trust policy.',
        502
      );
    }
    let result: unknown;
    try {
      result = JSON.parse(responseBody);
    } catch {
      throw new WalletError('INVALID_RESPONSE', 'WaaS returned invalid JSON.', 502);
    }
    if (!response.ok) {
      const error = z.object({ code: z.number() }).safeParse(result);
      throw new UpstreamError(error.success ? error.data.code : response.status, method);
    }
    return result;
  }
}
