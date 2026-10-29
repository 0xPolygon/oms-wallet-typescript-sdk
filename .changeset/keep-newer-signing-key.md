---
'@polygonlabs/oms-wallet': patch
---

A session that ends on its own (expiry, the wallet API rejecting its credential, or another tab replacing its key) no longer deletes a signing key or pending sign-in redirect state that another tab's newer sign-in stored. With the default browser signer, the key is deleted only while it is still the ended session's, checked and deleted in one IndexedDB transaction. Signing out and starting a new sign-in clear them as before.
