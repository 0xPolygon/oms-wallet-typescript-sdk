---
'@polygonlabs/oms-wallet': minor
---

Add attested EVM and Solana wallet import and smart-session read APIs for owners and remote applications.

- **Wallet import:** import raw keys through HPKE or provide externally encrypted key material through the advanced import methods. Polygon-managed environments now supply their attestation trust policy automatically.
- **Wallet provenance:** every `WalletAccount` now requires `keyOrigin`, distinguishing enclave-generated and imported keys.
- **Session reads:** wallet owners can read an authorized session and its grant usage, while `RemoteAccessClient` can list and read every session scoped to its credential.
- **Access management:** `AccessGrant` now discriminates direct and remote access with `type`, and `revokeAccess` accepts `credentialId` plus an optional `sessionId` instead of `targetCredentialId`.
- **Errors:** duplicate-address and failed-attestation imports now have stable SDK error codes.
