import { hexToBytes, isHex } from 'viem';

/**
 * Messages that start with this prefix can only be signed through the context `OMSWallet.extend`
 * gives an extension, never through `WalletClient.signMessage`. So code that can only call
 * `signMessage`, such as a dApp connected through wagmi, cannot obtain such a signature, and an
 * extension can derive keys from it.
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
