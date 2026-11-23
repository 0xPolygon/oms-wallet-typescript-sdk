# oms-wallet-protocol

WaaS wire-protocol code shared by `@polygonlabs/oms-wallet` and `@polygonlabs/oms-server-wallet-sdk`.
This package is private and never published: `pnpm --filter oms-wallet-protocol sync` copies `src/`
into `src/internal/protocol/` of both SDKs, and `codegen-drift-check` fails CI when a copy differs.

## What belongs here

Only code about how a request to WaaS, or a response from it, is built, identified or checked:

| Module | Contents |
| --- | --- |
| `attestation.ts` | AWS Nitro attestation verification, `Sequence/1` and `Sequence/2` user data, PCR0 normalisation |
| `requestSigning.ts` | Signed-request preimage, `OMS-Wallet-Signature` header, nonce rule |
| `publishableKey.ts` | Publishable key → project, API origin, stage, mode and trusted PCR0s |
| `addresses.ts` | Base58, Solana and Tron addresses |
| `networks.ts` | Solana and Tron network names, Tron TIP-712 chain IDs |
| `waasErrors.ts` | WaaS error codes the SDKs act on |
| `encoding.ts` | Base64, base64url, hex, constant-time compare, SHA-256 |

State, storage, sessions, retries, error classes, operation tracking, Trails and validation of
features only one SDK has stay in the SDKs. Public types stay defined in the SDKs too.

## Rules

- Edit here, then run `pnpm --filter oms-wallet-protocol sync` and commit both copies. Never edit a copy.
- Code must compile for the browser SDK's CJS (`node10`) and ESM builds and the server SDK's ESM build:
  relative imports with `.js`, no top-level `await`, no `import.meta`, Web Crypto and `fetch` only.
- Use only dependencies both SDKs declare; the sync fails otherwise.
- Keep `src/` flat: one `.ts` file per module. Import modules directly; there is no barrel file.
- Throw plain `Error`s; each SDK maps them to its own error classes.
- A change here needs a changeset naming each SDK whose behaviour changes.

## Attestation formats

| Format | `user_data` |
| --- | --- |
| `Sequence/1` | `base64(SHA-256(METHOD + " " + PATH + "\n" + reqBody + "\n" + resBody))` |
| `Sequence/2` | `base64(SHA-256(METHOD + " " + PATH + "\n" + OMS-Wallet-Signature + "\n" + reqBody + "\n" + resBody))` |

The verifier accepts both and rejects any other version. Drop `Sequence/1` once WaaS emits
`Sequence/2` in every environment and the pre-v2 enclave measurements are retired.
