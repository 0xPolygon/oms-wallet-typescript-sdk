---
"@polygonlabs/oms-wallet": patch
---

Require viem `2.55.0` or newer, so installs no longer resolve the `ws` version affected by GHSA-96hv-2xvq-fx4p.

- **`@polygonlabs/oms-wallet`:** the `viem` dependency is now `^2.55.0`.
- **`@polygonlabs/oms-wallet-wagmi-connector`:** the `viem` peer range is now `>=2.55.0 <3`, and the `@wagmi/core` peer range is now `>=3.6.5 <4`. viem 2.56 and later removed an export that earlier `@wagmi/core` releases import, so those releases fail to build with current viem.
