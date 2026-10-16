const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decodes a base58 string, or returns undefined if it contains a non-base58 character. */
export function decodeBase58(value: string): Uint8Array | undefined {
  let decoded = 0n;
  for (const character of value) {
    const index = base58Alphabet.indexOf(character);
    if (index < 0) return undefined;
    decoded = decoded * 58n + BigInt(index);
  }

  const bytes: number[] = [];
  while (decoded > 0n) {
    bytes.push(Number(decoded & 0xffn));
    decoded >>= 8n;
  }
  bytes.reverse();
  for (let index = 0; index < value.length && value[index] === '1'; index += 1) {
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
