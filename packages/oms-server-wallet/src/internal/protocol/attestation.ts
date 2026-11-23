// DO NOT EDIT. Copied from packages/oms-wallet-protocol/src/attestation.ts by
// `pnpm --filter oms-wallet-protocol sync`; edit the source there and run it again.

import type * as X509 from '@peculiar/x509';
import type { X509Certificate } from '@peculiar/x509';
import type { Decoder, Tag as CborTag } from 'cbor-x';

import {
  base64DecodeBytes,
  base64EncodeBytes,
  bytesToHex,
  equalBytes,
  toArrayBuffer,
  utf8
} from './encoding.js';
import { DEBUG_PCR0 } from './publishableKey.js';
import { WALLET_SIGNATURE_HEADER } from './requestSigning.js';

/** Request header carrying the nonce the enclave must sign into its attestation. */
export const ATTESTATION_NONCE_HEADER = 'X-Attestation-Nonce';
/** Response header carrying the base64 COSE_Sign1 attestation document. */
export const ATTESTATION_DOCUMENT_HEADER = 'X-Attestation-Document';
/**
 * The request header a `Sequence/2` attestation binds. Its raw value as sent, or an empty string
 * when the request had none, is part of the attested hash, so an attestation proves which credential
 * signed the request the enclave answered.
 */
export const ATTESTATION_BOUND_HEADER = WALLET_SIGNATURE_HEADER;

/** Attestation formats the verifier accepts. Anything else is rejected. */
export type AttestationVersion = 1 | 2;

/** The request and response an attestation must bind. */
export interface AttestationBinding {
  method: string;
  path: string;
  /** Value of `ATTESTATION_BOUND_HEADER` as sent; omit or `''` when the request had none. */
  boundHeader?: string;
  requestBody: string;
  responseBody: string;
}

// SHA-256 fingerprint of the DER-encoded AWS Nitro Enclaves root certificate.
const awsNitroRootSha256 = '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b';
const coseSign1Tag = 18;
const coseEs384Algorithm = -35;
const maxAttestationAgeMs = 5 * 60 * 1_000;

interface AttestationDocument {
  timestamp: number;
  pcrs: Map<number, Uint8Array>;
  certificate: Uint8Array;
  cabundle: Uint8Array[];
  userData: Uint8Array;
  nonce: Uint8Array;
}

/**
 * Verifies a WaaS response's attestation document: the AWS Nitro certificate chain and COSE
 * signature, a trusted PCR0, the request nonce, its age, and that it binds this exact request and
 * response. Throws an `Error` naming the failed check.
 */
export async function verifyAttestationDocument(
  params: AttestationBinding & {
    encodedDocument: string;
    nonce: string;
    trustedPcr0s: ReadonlySet<string>;
    now?: Date;
  }
): Promise<void> {
  const { Decoder, Encoder, Tag } = await import('cbor-x');
  const decoder = new Decoder({ mapsAsObjects: false, copyBuffers: true });
  const encoder = new Encoder({ mapsAsObjects: false, tagUint8Array: false, useRecords: false });
  const signedDocument = decodeCoseSign1(base64DecodeBytes(params.encodedDocument), decoder, Tag);
  const document = decodeAttestationPayload(signedDocument.payload, decoder);
  const now = params.now ?? new Date();

  if (Math.abs(now.getTime() - document.timestamp) > maxAttestationAgeMs) {
    throw new Error('WaaS attestation timestamp is outside the accepted freshness window');
  }

  const pcr0 = document.pcrs.get(0);
  if (!pcr0 || !params.trustedPcr0s.has(bytesToHex(pcr0))) {
    throw new Error('WaaS attestation PCR0 is not trusted');
  }

  if (!equalBytes(document.nonce, new TextEncoder().encode(params.nonce))) {
    throw new Error('WaaS attestation nonce does not match the request');
  }

  const expectedUserData = await attestationUserData(
    attestationVersionOf(document.userData),
    params
  );
  if (!equalBytes(document.userData, expectedUserData)) {
    throw new Error('WaaS attestation is not bound to the request and response');
  }

  const certificate = await verifyCertificateChain(document, now);
  const publicKey = await certificate.publicKey.export({ name: 'ECDSA', namedCurve: 'P-384' }, [
    'verify'
  ]);
  const signatureInput = encoder.encode([
    'Signature1',
    signedDocument.protectedHeader,
    new Uint8Array(),
    signedDocument.payload
  ]);
  const validSignature = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-384' },
    publicKey,
    toArrayBuffer(signedDocument.signature),
    toArrayBuffer(signatureInput)
  );
  if (!validSignature) throw new Error('WaaS attestation signature is invalid');
}

function decodeCoseSign1(
  encoded: Uint8Array,
  decoder: Decoder,
  Tag: typeof CborTag
): {
  protectedHeader: Uint8Array;
  payload: Uint8Array;
  signature: Uint8Array;
} {
  const decoded = decoder.decode(encoded);
  const value = decoded instanceof Tag ? decoded.value : decoded;
  if ((decoded instanceof Tag && decoded.tag !== coseSign1Tag) || !Array.isArray(value)) {
    throw new Error('WaaS attestation is not a COSE_Sign1 document');
  }
  const [protectedHeader, unprotectedHeader, payload, signature] = value as unknown[];
  if (
    value.length !== 4 ||
    !(protectedHeader instanceof Uint8Array) ||
    !(unprotectedHeader instanceof Map) ||
    unprotectedHeader.size !== 0 ||
    !(payload instanceof Uint8Array) ||
    !(signature instanceof Uint8Array) ||
    signature.length !== 96
  ) {
    throw new Error('WaaS attestation has an invalid COSE_Sign1 structure');
  }
  const protectedValues = decoder.decode(protectedHeader);
  if (!(protectedValues instanceof Map) || protectedValues.get(1) !== coseEs384Algorithm) {
    throw new Error('WaaS attestation does not use COSE ES384');
  }
  return { protectedHeader, payload, signature };
}

function decodeAttestationPayload(payload: Uint8Array, decoder: Decoder): AttestationDocument {
  const decoded = decoder.decode(payload);
  if (!(decoded instanceof Map)) throw new Error('WaaS attestation payload is not a CBOR map');
  if (decoded.get('digest') !== 'SHA384') throw new Error('WaaS attestation digest is not SHA384');

  const timestampValue = decoded.get('timestamp');
  const timestamp =
    typeof timestampValue === 'bigint' && timestampValue <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(timestampValue)
      : timestampValue;
  const pcrs = decoded.get('pcrs');
  const certificate = decoded.get('certificate');
  const cabundle = decoded.get('cabundle');
  const userData = decoded.get('user_data');
  const nonce = decoded.get('nonce');
  if (
    typeof timestamp !== 'number' ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    !(pcrs instanceof Map) ||
    pcrs.size === 0 ||
    pcrs.size > 32 ||
    !(certificate instanceof Uint8Array) ||
    !Array.isArray(cabundle) ||
    cabundle.length === 0 ||
    !cabundle.every((entry) => entry instanceof Uint8Array) ||
    !(userData instanceof Uint8Array) ||
    !(nonce instanceof Uint8Array)
  ) {
    throw new Error('WaaS attestation payload is missing required fields');
  }
  for (const [index, measurement] of pcrs) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= 32 ||
      !(measurement instanceof Uint8Array) ||
      ![32, 48, 64].includes(measurement.length)
    ) {
      throw new Error('WaaS attestation contains an invalid PCR measurement');
    }
  }

  return {
    timestamp,
    pcrs: pcrs as Map<number, Uint8Array>,
    certificate,
    cabundle: cabundle as Uint8Array[],
    userData,
    nonce
  };
}

async function verifyCertificateChain(
  document: AttestationDocument,
  now: Date
): Promise<X509Certificate> {
  const {
    BasicConstraintsExtension,
    KeyUsageFlags,
    KeyUsagesExtension,
    X509Certificate,
    X509ChainBuilder
  } = await loadX509();
  const target = new X509Certificate(toArrayBuffer(document.certificate));
  const authorities = document.cabundle.map((raw) => new X509Certificate(toArrayBuffer(raw)));
  const root = authorities[0];
  const rootThumbprint = bytesToHex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', root.rawData))
  );
  if (rootThumbprint !== awsNitroRootSha256) {
    throw new Error('WaaS attestation certificate chain does not use the AWS Nitro root');
  }

  const chain = await new X509ChainBuilder({ certificates: authorities }).build(target);
  if (
    chain.length !== authorities.length + 1 ||
    !equalBytes(rawCertificate(chain.at(-1)!), rawCertificate(root))
  ) {
    throw new Error('WaaS attestation certificate chain is incomplete');
  }

  for (let index = 0; index < chain.length; index += 1) {
    const certificate = chain[index];
    if (now < certificate.notBefore || now > certificate.notAfter) {
      throw new Error('WaaS attestation certificate is outside its validity period');
    }
    const basicConstraints = certificate.getExtension(BasicConstraintsExtension);
    const keyUsage = certificate.getExtension(KeyUsagesExtension);
    if (index === 0) {
      if (
        (basicConstraints && (basicConstraints.ca || basicConstraints.pathLength !== undefined)) ||
        !keyUsage ||
        (keyUsage.usages & KeyUsageFlags.digitalSignature) === 0
      ) {
        throw new Error('WaaS attestation leaf certificate has invalid constraints');
      }
      continue;
    }
    if (
      !basicConstraints?.critical ||
      !basicConstraints.ca ||
      (basicConstraints.pathLength !== undefined && basicConstraints.pathLength < index - 1) ||
      !keyUsage ||
      (keyUsage.usages & KeyUsageFlags.keyCertSign) === 0
    ) {
      throw new Error('WaaS attestation CA certificate has invalid constraints');
    }
  }

  return target;
}

/**
 * The `user_data` an enclave writes for this request and response:
 *
 * - `Sequence/1:<base64(SHA-256(METHOD + " " + PATH + "\n" + reqBody + "\n" + resBody))>`
 * - `Sequence/2:<base64(SHA-256(METHOD + " " + PATH + "\n" + boundHeader + "\n" + reqBody + "\n" + resBody))>`
 */
export async function attestationUserData(
  version: AttestationVersion,
  binding: AttestationBinding
): Promise<Uint8Array> {
  const request = `${binding.method.toUpperCase()} ${binding.path}`;
  const preimage =
    version === 2
      ? `${request}\n${binding.boundHeader ?? ''}\n${binding.requestBody}\n${binding.responseBody}`
      : `${request}\n${binding.requestBody}\n${binding.responseBody}`;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(preimage)));
  return utf8(`Sequence/${version}:${base64EncodeBytes(hash)}`);
}

function attestationVersionOf(userData: Uint8Array): AttestationVersion {
  const text = new TextDecoder().decode(userData);
  if (text.startsWith('Sequence/1:')) return 1;
  if (text.startsWith('Sequence/2:')) return 2;
  throw new Error('WaaS attestation uses an unsupported user data version');
}

/** Lowercase hex PCR0s without `0x`. Throws when the list is empty or holds a malformed value. */
export function normalizeTrustedPcr0s(pcr0s: ReadonlyArray<string>): ReadonlySet<string> {
  const normalized = pcr0s.map((value) => value.trim().toLowerCase().replace(/^0x/, ''));
  if (normalized.length === 0 || normalized.some((value) => !/^[0-9a-f]{96}$/.test(value))) {
    throw new Error('trustedPcr0s must contain at least one 48-byte hex PCR0');
  }
  return new Set(normalized);
}

/** Whether a normalized PCR0 set trusts a debug enclave, which production must never do. */
export function trustsDebugEnclave(trustedPcr0s: ReadonlySet<string>): boolean {
  return trustedPcr0s.has(DEBUG_PCR0);
}

export function randomAttestationNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return base64EncodeBytes(bytes);
}

// Loaded on first use, so a browser bundle fetches the certificate code only when it verifies.
// @peculiar/x509 2.x expects the Reflect metadata polyfill to be loaded first; 1.x loads it itself.
async function loadX509(): Promise<typeof X509> {
  await import('reflect-metadata');
  return import('@peculiar/x509');
}

function rawCertificate(certificate: X509Certificate): Uint8Array {
  return new Uint8Array(certificate.rawData);
}
