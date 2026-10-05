---
"@polygonlabs/oms-wallet": patch
---

Wallet import trusts the WaaS v1.1.1 enclave measurements on Staging and Production.

- **Staging:** restores wallet import, which was failing with `OMS_ATTESTATION_VERIFICATION_FAILED` after the Staging enclave was upgraded.
- **Production:** trusts the v1.1.1 measurement alongside the current one, so wallet import keeps working when Production is upgraded. Update before that rollout to avoid import failures.
