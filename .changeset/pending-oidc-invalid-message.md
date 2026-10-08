---
"@polygonlabs/oms-wallet": patch
---

`completeOidcRedirectAuth` now reports a corrupted pending redirect record as `Pending OIDC redirect auth is invalid` instead of a raw JSON parse error.
