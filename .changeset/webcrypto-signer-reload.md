---
'@polygonlabs/oms-wallet': patch
---

The default browser credential signer no longer leaves a tab stuck after another tab signs out and back in.

When another tab removed the shared signing key, the signer could report no credential ID, and the session check failed with a `TypeError` on every operation. The signer now reloads or recreates its key on next use, and a missing key counts as a mismatch, so the stale tab's session is cleared like any other replaced session.

The signer also reports the stored key rather than the one it loaded earlier, so a tab whose key another tab replaced clears its session before sending anything, instead of sending one request that the wallet API rejects as an invalid signature.
