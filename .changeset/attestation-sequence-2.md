---
'@polygonlabs/oms-wallet': patch
'@polygonlabs/oms-server-wallet-sdk': patch
---

Enclave attestation now accepts the `Sequence/2` format alongside `Sequence/1`.

- A `Sequence/2` attestation also binds the request's `OMS-Wallet-Signature` header, so a response proves which credential signed the request the enclave answered. Both SDKs verify it against the header they sent.
- Unknown attestation formats are rejected.
- Upgrade before WaaS switches to `Sequence/2`: earlier versions reject those responses (`@polygonlabs/oms-wallet` during wallet import; `@polygonlabs/oms-server-wallet-sdk` on every request).
