# Auth0-issued ID Token Example

This Vite React example uses `@auth0/auth0-react` to authenticate with Auth0 and
obtain the provider's raw ID token. It passes that Auth0-issued token, the Auth0
issuer, and the Auth0 client ID as audience to `signInWithOidcIdToken`. Auth0
owns its authorization-code PKCE flow; OMS Wallet receives the resulting ID
token.

After wallet authentication, the example can sign a message, send a sponsored
native Polygon Amoy transaction with prefilled test values, read balances, and
display the Auth0-issued ID token.

## Auth0 Application Settings

Add `http://localhost:5173` to the Auth0 application's **Allowed Callback URLs**.
Also add it to **Allowed Logout URLs** and **Allowed Web Origins**. The example's
Vite server uses that exact origin and fails instead of selecting another port
when `5173` is occupied.

The Auth0 application must be a public client that supports the Authorization
Code flow with PKCE. No client secret belongs in this browser example.

## Run Locally

```bash
pnpm dev:custom-auth0-id-token-example
```
