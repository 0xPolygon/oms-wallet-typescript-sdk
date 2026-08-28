---
'@polygonlabs/oms-wallet': major
---

Add attested EVM and Solana wallet import and smart-session read APIs for owners and remote applications.

- **Wallet import:** configure trusted enclave PCR0 measurements, import raw keys through HPKE, or provide externally encrypted key material through the advanced import methods.
- **Wallet provenance:** every `WalletAccount` now requires `keyOrigin`, distinguishing enclave-generated and imported keys.
- **Session reads:** wallet owners can read an authorized session and its grant usage, while `RemoteAccessClient` can list and read every session scoped to its credential.
- **Errors:** duplicate-address and failed-attestation imports now have stable SDK error codes.
