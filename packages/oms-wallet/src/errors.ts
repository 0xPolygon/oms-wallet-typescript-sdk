import type { OMSWalletOperation } from './operations.js';

export const attestationVerificationErrorPrefix = 'WaaS attestation verification failed: ';

export type OMSWalletErrorCode =
  | 'OMS_HTTP_ERROR'
  | 'OMS_INVALID_RESPONSE'
  | 'OMS_REQUEST_FAILED'
  | 'OMS_AUTH_COMMITMENT_CONSUMED'
  | 'OMS_WALLET_ADDRESS_ALREADY_IMPORTED'
  | 'OMS_ATTESTATION_VERIFICATION_FAILED'
  | 'OMS_SESSION_MISSING'
  | 'OMS_SESSION_EXPIRED'
  | 'OMS_WALLET_SELECTION_STALE'
  | 'OMS_WALLET_SELECTION_UNAVAILABLE'
  | 'OMS_WALLET_SELECTION_IN_FLIGHT'
  | 'OMS_TRANSACTION_EXECUTION_UNCONFIRMED'
  | 'OMS_TRANSACTION_STATUS_LOOKUP_FAILED'
  | 'OMS_VALIDATION_ERROR'
  | 'OMS_STORAGE_ERROR';

export interface OMSWalletUpstreamError {
  service: 'waas' | 'indexer';
  name?: string;
  /** Upstream error code. Numeric WebRPC codes are stringified, for example `'7313'`. */
  code?: string;
  message?: string;
  /** The service's reason for this error, when it gives one, for example why a request was invalid. */
  cause?: string;
  status?: number;
}

export interface OMSWalletErrorParams<Code extends OMSWalletErrorCode = OMSWalletErrorCode> {
  code: Code;
  message: string;
  operation?: string;
  status?: number;
  txnId?: string;
  retryable?: boolean;
  upstreamError?: OMSWalletUpstreamError;
  cause?: unknown;
}

export abstract class OMSWalletError extends Error {
  readonly code: OMSWalletErrorCode;
  readonly operation?: string;
  readonly status?: number;
  readonly txnId?: string;
  readonly retryable?: boolean;
  readonly upstreamError?: OMSWalletUpstreamError;

  protected constructor(params: OMSWalletErrorParams) {
    super(params.message);
    this.name = 'OMSWalletError';
    this.code = params.code;
    this.operation = params.operation;
    this.status = params.status;
    this.txnId = params.txnId;
    this.retryable = params.retryable;
    this.upstreamError = params.upstreamError;
    if (params.cause !== undefined) {
      this.cause = params.cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type OMSWalletSessionErrorCode = 'OMS_SESSION_MISSING' | 'OMS_SESSION_EXPIRED';
type OMSWalletRequestErrorCode =
  | 'OMS_HTTP_ERROR'
  | 'OMS_REQUEST_FAILED'
  | 'OMS_AUTH_COMMITMENT_CONSUMED'
  | 'OMS_WALLET_ADDRESS_ALREADY_IMPORTED';
type OMSWalletResponseErrorCode = 'OMS_INVALID_RESPONSE' | 'OMS_ATTESTATION_VERIFICATION_FAILED';
type OMSWalletTransactionErrorCode =
  'OMS_TRANSACTION_EXECUTION_UNCONFIRMED' | 'OMS_TRANSACTION_STATUS_LOOKUP_FAILED';
type OMSWalletSelectionErrorCode =
  | 'OMS_WALLET_SELECTION_STALE'
  | 'OMS_WALLET_SELECTION_UNAVAILABLE'
  | 'OMS_WALLET_SELECTION_IN_FLIGHT';
type OMSWalletValidationErrorCode = 'OMS_VALIDATION_ERROR';
type OMSWalletStorageErrorCode = 'OMS_STORAGE_ERROR';

export class OMSWalletSessionError extends OMSWalletError {
  constructor(
    params: Omit<OMSWalletErrorParams<OMSWalletSessionErrorCode>, 'code'> & {
      code?: OMSWalletSessionErrorCode;
    }
  ) {
    super({ ...params, code: params.code ?? 'OMS_SESSION_MISSING' });
    this.name = 'OMSWalletSessionError';
  }
}

export class OMSWalletRequestError extends OMSWalletError {
  constructor(
    params: Omit<OMSWalletErrorParams<OMSWalletRequestErrorCode>, 'code'> & {
      code?: OMSWalletRequestErrorCode;
    }
  ) {
    super({ ...params, code: params.code ?? 'OMS_REQUEST_FAILED' });
    this.name = 'OMSWalletRequestError';
  }
}

export class OMSWalletResponseError extends OMSWalletError {
  constructor(
    params: Omit<OMSWalletErrorParams<OMSWalletResponseErrorCode>, 'code'> & {
      code?: OMSWalletResponseErrorCode;
    }
  ) {
    super({ ...params, code: params.code ?? 'OMS_INVALID_RESPONSE' });
    this.name = 'OMSWalletResponseError';
  }
}

export class OMSWalletTransactionError extends OMSWalletError {
  constructor(
    params: Omit<OMSWalletErrorParams<OMSWalletTransactionErrorCode>, 'code'> & {
      code?: OMSWalletTransactionErrorCode;
    }
  ) {
    super({ ...params, code: params.code ?? 'OMS_TRANSACTION_STATUS_LOOKUP_FAILED' });
    this.name = 'OMSWalletTransactionError';
  }
}

export class OMSWalletSelectionError extends OMSWalletError {
  constructor(params: OMSWalletErrorParams<OMSWalletSelectionErrorCode>) {
    super(params);
    this.name = 'OMSWalletSelectionError';
  }
}

export class OMSWalletValidationError extends OMSWalletError {
  constructor(
    params: Omit<OMSWalletErrorParams<OMSWalletValidationErrorCode>, 'code'> & {
      code?: OMSWalletValidationErrorCode;
    }
  ) {
    super({ ...params, code: params.code ?? 'OMS_VALIDATION_ERROR' });
    this.name = 'OMSWalletValidationError';
  }
}

export class OMSWalletStorageError extends OMSWalletError {
  constructor(
    params: Omit<OMSWalletErrorParams<OMSWalletStorageErrorCode>, 'code'> & {
      code?: OMSWalletStorageErrorCode;
    }
  ) {
    super({ ...params, code: params.code ?? 'OMS_STORAGE_ERROR' });
    this.name = 'OMSWalletStorageError';
  }
}

export function isOMSWalletError(error: unknown): error is OMSWalletError {
  return error instanceof OMSWalletError;
}

export function toOMSWalletError(
  error: unknown,
  operation: OMSWalletOperation,
  upstreamService: OMSWalletUpstreamError['service'] = 'waas'
): OMSWalletError {
  if (isOMSWalletError(error)) {
    return error;
  }

  const status = statusFromError(error);
  const name = error instanceof Error ? error.name : undefined;
  const generatedCode = generatedCodeFromError(error);
  const upstreamError = upstreamErrorFromError(error, upstreamService);
  const attestationErrorMessage = attestationVerificationMessage(error);

  if (name === 'OMSWalletInvalidResponseError') {
    return new OMSWalletResponseError({
      operation,
      cause: error,
      message: errorMessage(error)
    });
  }

  if (attestationErrorMessage !== undefined) {
    return new OMSWalletResponseError({
      code: 'OMS_ATTESTATION_VERIFICATION_FAILED',
      operation,
      retryable: false,
      cause: error,
      message: attestationErrorMessage
    });
  }

  if (name === 'AddressAlreadyImported' || generatedCode === 7313) {
    return new OMSWalletRequestError({
      code: 'OMS_WALLET_ADDRESS_ALREADY_IMPORTED',
      operation,
      status: 409,
      retryable: false,
      upstreamError,
      cause: error,
      message: errorMessage(error)
    });
  }

  if (
    (operation === 'wallet.importWallet' || operation === 'wallet.importEncryptedWallet') &&
    (name === 'InvalidRequest' || generatedCode === 7200)
  ) {
    return new OMSWalletValidationError({
      operation,
      upstreamError,
      cause: error,
      message: errorMessage(error)
    });
  }

  if (name === 'CommitmentConsumed' || generatedCode === 7008) {
    return new OMSWalletRequestError({
      code: 'OMS_AUTH_COMMITMENT_CONSUMED',
      operation,
      status,
      retryable: false,
      upstreamError,
      cause: error,
      message: errorMessage(error)
    });
  }

  if (name === 'WebrpcBadResponse') {
    if (isHttpStatus(status)) {
      return new OMSWalletRequestError({
        code: 'OMS_HTTP_ERROR',
        operation,
        status,
        retryable: status >= 500,
        upstreamError,
        cause: error,
        message: errorMessage(error)
      });
    }

    return new OMSWalletResponseError({
      operation,
      status,
      upstreamError,
      cause: error,
      message: errorMessage(error)
    });
  }

  if (isHttpStatus(status) && name?.startsWith('Webrpc') && name !== 'WebrpcRequestFailed') {
    return new OMSWalletRequestError({
      code: 'OMS_HTTP_ERROR',
      operation,
      status,
      retryable: status >= 500,
      upstreamError,
      cause: error,
      message: errorMessage(error)
    });
  }

  if (!name?.startsWith('Webrpc') && status === undefined) {
    return new OMSWalletValidationError({
      operation,
      cause: error,
      message: errorMessage(error)
    });
  }

  return new OMSWalletRequestError({
    operation,
    status,
    retryable: name === 'WebrpcRequestFailed' || status === undefined || status >= 500,
    upstreamError,
    cause: error,
    message: errorMessage(error)
  });
}

/**
 * Whether WaaS rejected the calling credential as gone: `KeyNotFound` (7202) or `KeyExpired` (7203).
 * Checks a raw generated error and an SDK error that carries it as `upstreamError`.
 */
export function isCredentialEndedError(error: unknown): boolean {
  if (isOMSWalletError(error)) {
    return (
      error.upstreamError?.service === 'waas' &&
      (error.upstreamError.code === '7202' || error.upstreamError.code === '7203')
    );
  }
  const code = generatedCodeFromError(error);
  return code === 7202 || code === 7203;
}

/**
 * Whether a raw generated WaaS error is `Unauthorized` (7207). Matched by code only: the API gateway
 * also returns errors named `Unauthorized` (code 1000).
 */
export function isUnauthorizedError(error: unknown): boolean {
  return !isOMSWalletError(error) && generatedCodeFromError(error) === 7207;
}

/** Whether WaaS does not serve the called method (`WebrpcBadRoute`, code -2). */
export function isBadRouteError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : undefined;
  return (
    name === 'WebrpcBadRoute' || (!isOMSWalletError(error) && generatedCodeFromError(error) === -2)
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function attestationVerificationMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.name === 'OMSWalletAttestationVerificationError') {
    return error.message.replace(attestationVerificationErrorPrefix, '');
  }
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (typeof cause !== 'string') return undefined;
  const prefixIndex = cause.indexOf(attestationVerificationErrorPrefix);
  return prefixIndex === -1
    ? undefined
    : cause.slice(prefixIndex + attestationVerificationErrorPrefix.length);
}

function statusFromError(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | undefined)?.status;
  const code = generatedCodeFromError(error);
  const name = error instanceof Error ? error.name : undefined;
  if (name === 'WebrpcRequestFailed' && code === -1 && status === 400) {
    return undefined;
  }
  return typeof status === 'number' ? status : undefined;
}

function generatedCodeFromError(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'number' ? code : undefined;
}

function isHttpStatus(status: number | undefined): status is number {
  return status !== undefined && status >= 400;
}

function upstreamErrorFromError(
  error: unknown,
  service: OMSWalletUpstreamError['service']
): OMSWalletUpstreamError | undefined {
  const name = error instanceof Error ? error.name : undefined;
  const code = generatedCodeFromError(error);
  const status = statusFromError(error);

  if (!name?.startsWith('Webrpc') && code === undefined && status === undefined) {
    return undefined;
  }

  return {
    service,
    name,
    code: code === undefined ? undefined : String(code),
    message: errorMessage(error),
    cause: code !== undefined && code >= 0 ? upstreamCause(error) : undefined,
    status
  };
}

/**
 * The reason a service error carries in `cause` alongside its generic message. Only errors the
 * service sent (code 0 and up) qualify: the client's own transport errors (negative codes) put
 * local details there, such as the raw body of a response it could not parse.
 */
function upstreamCause(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  return typeof cause === 'string' && cause.length > 0 ? cause : undefined;
}
