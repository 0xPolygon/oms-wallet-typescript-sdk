import { hexToBytes, isHex, stringToBytes } from 'viem';

/**
 * Messages that start with this prefix can only be signed through the context `OMSWallet.extend`
 * gives an extension, never through `WalletClient.signMessage`. So code that can only ask the
 * wallet to sign, such as a dApp sending `personal_sign` through the wagmi connector, cannot obtain
 * such a signature, and an extension can derive keys from it.
 */
export const RESERVED_MESSAGE_PREFIX = 'OMS Wallet reserved message:';

const PREFIX_BYTES = stringToBytes(RESERVED_MESSAGE_PREFIX);

/** Also matches the message hex-encoded, in case it is signed as raw bytes. */
export function isReservedMessage(message: string): boolean {
  if (message.startsWith(RESERVED_MESSAGE_PREFIX)) return true;
  if (!isHex(message)) return false;
  // Compares bytes, so whatever follows the prefix does not matter.
  const bytes = hexToBytes(message);
  return (
    bytes.length >= PREFIX_BYTES.length &&
    PREFIX_BYTES.every((byte, index) => bytes[index] === byte)
  );
}
