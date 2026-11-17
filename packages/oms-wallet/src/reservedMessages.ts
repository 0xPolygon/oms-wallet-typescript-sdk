import { hexToBytes, isHex } from 'viem';

/**
 * Messages that start with this prefix can only be signed through the context `OMSWallet.extend`
 * gives an extension, never through `WalletClient.signMessage`. An extension can then derive keys
 * from such a signature without any other code holding the session (a connected dApp, for
 * example) being able to obtain the same signature.
 */
export const RESERVED_MESSAGE_PREFIX = 'OMS Wallet reserved message:';

/** Also matches the message hex-encoded, in case it is signed as raw bytes. */
export function isReservedMessage(message: string): boolean {
  if (message.startsWith(RESERVED_MESSAGE_PREFIX)) return true;
  if (!isHex(message)) return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(message));
    return text.startsWith(RESERVED_MESSAGE_PREFIX);
  } catch {
    return false;
  }
}
