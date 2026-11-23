/** WebRPC error codes WaaS returns that the SDKs act on. */
export const WaasErrorCode = Object.freeze({
  DataIntegrityError: 7103,
  InvalidRequest: 7200,
  InvalidSignature: 7201,
  KeyNotFound: 7202,
  KeyExpired: 7203,
  UsageLimitExceeded: 7205,
  PreconditionFailed: 7206,
  Unauthorized: 7207,
  UnsupportedNetwork: 7304,
  UnsupportedTransactionMode: 7305,
  TransactionFailed: 7306,
  WalletProviderError: 7307,
  TransactionNotFound: 7308,
  TransactionExpired: 7309,
  InvalidFeeOption: 7310,
  AddressAlreadyImported: 7313
} as const);

/** Whether WaaS rejected the calling credential as gone: `KeyNotFound` or `KeyExpired`. */
export function isCredentialGoneCode(code: number): boolean {
  return code === WaasErrorCode.KeyNotFound || code === WaasErrorCode.KeyExpired;
}
