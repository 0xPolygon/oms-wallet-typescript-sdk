---
'@polygonlabs/oms-wallet': patch
---

A stored session whose saved expiry has passed is restored and checked with the wallet API instead of being discarded, unless its requested lifetime has run out. Requests after the SDK last read the expiry can extend the session on the wallet API without the SDK seeing it, so an idle session could otherwise end early on the next page load. When the read cannot reach the wallet API, the SDK retries it while the page is shown, at most 15 minutes apart, so a session restored offline is settled soon after the network returns.
