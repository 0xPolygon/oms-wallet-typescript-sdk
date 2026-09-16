export function invalidResponseError(message: string): Error {
  const error = new Error(message);
  error.name = 'OMSWalletInvalidResponseError';
  return error;
}
