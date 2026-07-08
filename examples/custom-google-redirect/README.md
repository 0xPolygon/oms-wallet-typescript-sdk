# Custom Google Redirect Example

This Vite React example verifies Google as a custom OIDC provider. It configures
Google with `providerRedirectUri: "http://localhost:5173"` and does not use the
SDK built-in Google relay helper.

## Run Locally

```bash
cp examples/custom-google-redirect/.env.example examples/custom-google-redirect/.env.local
# Fill VITE_OMS_PUBLISHABLE_KEY in examples/custom-google-redirect/.env.local
pnpm dev:custom-google-redirect-example
```

The Google OAuth client in this example is configured for
`http://localhost:5173`, so run the app on that exact origin.
