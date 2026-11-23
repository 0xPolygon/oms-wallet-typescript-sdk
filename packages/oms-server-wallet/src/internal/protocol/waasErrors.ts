// DO NOT EDIT. Copied from packages/oms-wallet-protocol/src/waasErrors.ts by
// `pnpm --filter oms-wallet-protocol sync`; edit the source there and run it again.

/** WebRPC error codes WaaS returns that the SDKs act on. */
export const WaasErrorCode = Object.freeze({
  InvalidRequest: 7200,
  InvalidSignature: 7201,
  KeyNotFound: 7202,
  KeyExpired: 7203,
  UsageLimitExceeded: 7205,
  PreconditionFailed: 7206,
  Unauthorized: 7207,
  InvalidFeeOption: 7310,
  AddressAlreadyImported: 7313
} as const);

/** Whether WaaS rejected the calling credential as gone: `KeyNotFound` or `KeyExpired`. */
export function isCredentialGoneCode(code: number): boolean {
  return code === WaasErrorCode.KeyNotFound || code === WaasErrorCode.KeyExpired;
}
