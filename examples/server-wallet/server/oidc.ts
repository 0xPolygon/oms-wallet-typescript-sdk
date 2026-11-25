// A minimal OIDC issuer: mints ES256 ID tokens for any subject this server has already
// authenticated, and serves the discovery document and JWKS WaaS reads to verify them.

const b64url = (bytes: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof bytes === 'string' ? bytes : new Uint8Array(bytes)).toString('base64url');

export interface Issuer {
  readonly issuer: string;
  readonly audience: string;
  mint(subject: string): Promise<{ token: string; expiresAt: number }>;
  discovery(): Record<string, unknown>;
  jwks(): { keys: JsonWebKey[] };
}

export async function createIssuer(options: {
  issuer: string;
  audience: string;
  privateJwk: string;
}): Promise<Issuer> {
  const issuer = options.issuer.replace(/\/$/, '');
  const jwk = JSON.parse(options.privateJwk) as JsonWebKey;
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  // RFC 7638 thumbprint as the key ID.
  const thumbprint = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const kid = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(thumbprint)));
  const header = b64url(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' }));

  return {
    issuer,
    audience: options.audience,
    // A new token for every call: WaaS rejects a token that was already used to sign in.
    async mint(subject) {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + 300;
      const claims = {
        iss: issuer,
        aud: options.audience,
        sub: subject,
        iat: now,
        exp: expiresAt,
        jti: crypto.randomUUID()
      };
      const input = `${header}.${b64url(JSON.stringify(claims))}`;
      const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        new TextEncoder().encode(input)
      );
      return { token: `${input}.${b64url(signature)}`, expiresAt };
    },
    discovery: () => ({
      issuer,
      jwks_uri: `${issuer}/oidc/jwks`,
      id_token_signing_alg_values_supported: ['ES256'],
      subject_types_supported: ['public'],
      response_types_supported: ['id_token']
    }),
    jwks: () => ({
      keys: [
        {
          kty: jwk.kty,
          crv: jwk.crv,
          x: jwk.x,
          y: jwk.y,
          kid,
          alg: 'ES256',
          use: 'sig'
        } as JsonWebKey
      ]
    })
  };
}
