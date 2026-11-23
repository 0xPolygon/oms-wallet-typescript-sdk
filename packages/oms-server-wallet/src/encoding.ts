import { base64UrlEncodeBytes, sha256Bytes } from './internal/protocol/encoding.js';

export {
  base64DecodeBytes,
  base64EncodeBytes,
  bytesToHex,
  equalBytes,
  toArrayBuffer,
  utf8
} from './internal/protocol/encoding.js';

/** Base64url SHA-256 of `value`'s UTF-8 bytes, without padding. */
export async function sha256(value: string): Promise<string> {
  return base64UrlEncodeBytes(await sha256Bytes(value));
}
