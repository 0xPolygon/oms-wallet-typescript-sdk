# Custom Google Redirect Example

This Vite React example verifies Google as a custom OIDC provider. It configures
Google with `providerRedirectUri: "http://localhost:5173"` and does not use the
SDK built-in Google relay value. The example passes its direct
`CustomOidcProviderConfig` to `signInWithOidcRedirect`.

## Run Locally

```bash
pnpm dev:custom-google-redirect-example
```

The Google OAuth client in this example is configured for
`http://localhost:5173`, so run the app on that exact origin.
