// Prints a fresh issuer key and state encryption key for .env.local.
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify'
]);
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const encryptionKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');

console.log(
  `OIDC_PRIVATE_JWK=${JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d })}`
);
console.log(`ENCRYPTION_KEY=${encryptionKey}`);
export {};
