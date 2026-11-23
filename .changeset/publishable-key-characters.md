---
'@polygonlabs/oms-wallet': patch
---

Publishable keys are checked more strictly: the project part must be letters and digits, and the secret part letters, digits and `-`. Other characters now fail with `Invalid publishableKey.` instead of reaching request headers.
