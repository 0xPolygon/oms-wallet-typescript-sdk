# @polygonlabs/oms-wallet

## 0.4.0

### Minor Changes

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Add Tron wallet support, replace `walletAddress` with a typed `activeWallet`, and align the public API with the Swift and Kotlin SDKs. This release has breaking changes; see `MIGRATION.md`.
  
  ### Tron
  
  - Create, sign in with, and import Tron wallets with **`WalletType.Tron`**. Imports take a secp256k1 private key, the same format as Ethereum.
  - Send TRX and contract calls with **`sendTronTransaction`**, and TRC-20 calls with **`callTronContract`**, on **`TronNetworks.mainnet`** and **`TronNetworks.nile`**. Tron wallets are EOAs and always run in native mode.
  - Omitting `data` sends a plain TRX transfer. Passing `data: '0x'` calls the recipient contract's payable fallback.
  - Prepared Tron transactions are often sponsored by the account's free daily bandwidth, even without a relayer.
  - Sign and verify with **`signTronMessage`**, **`signTronTypedData`** (TIP-712), **`isValidTronMessageSignature`**, and **`isValidTronTypedDataSignature`**.
  - **`indexer.getTronBalances`** returns TRX and TRC-20 balances on Tron Mainnet and Nile, with the same structure as `getSolanaBalances`; TRC-20 entries carry `tokenStandard` and `contractAddress` where Solana entries carry `tokenProgram` and `mintAddress`. `FeeOptionSelector.firstAvailable` uses it for Tron fees.
  - TRC-10 tokens are not supported.
  
  `callContract` and `callTronContract` now reject a full function signature as `method` (for example `'transfer(address,uint256)'`) with `OMS_VALIDATION_ERROR` before sending a request. Pass the bare function name (`'transfer'`); the wallet service builds the signature from the `args` types and already rejected full signatures with a generic invalid-request error.
  
  ### Additions
  
  - **`wallet.listAccessPage`** reads one access page; pass the previous page's `page.cursor` to continue. `AccessGrantPage` now includes `page` (`limit`, `cursor`).
  - **`WalletOperation`**, **`IndexerOperation`**, **`RemoteAccessOperation`**, and the **`OMSWalletOperation`** type are exported for comparing `error.operation`.
  - **`DEFAULT_SESSION_LIFETIME_SECONDS`** and **`MAX_SESSION_LIFETIME_SECONDS`** are exported (see Session lifetime).
  - **`FeeToken`** is exported.
  
  ### Breaking changes
  
  - **`wallet.activeWallet`** replaces `wallet.walletAddress`. It is the active `WalletAccount` or `undefined`, and narrowing on `type` gives Ethereum wallets a viem `Address`.
  - **`wallet.session`** is now `OMSWalletSession | undefined`, with `expiresAt` and `auth` always defined. `OMSWalletSessionState` is renamed to **`OMSWalletSession`** and no longer has `walletAddress`.
  - `walletAddress` is removed from auth and wallet activation results. Use `result.wallet.address`.
  - Session-expired events now include the expired `wallet`.
  - Wallet responses whose Ethereum address is not a valid hex address now fail with `OMS_INVALID_RESPONSE` instead of being passed through as an `Address`.
  - Sessions saved by 0.3.x are discarded on load, so users sign in once after upgrading.
  - Signature verification methods no longer take `walletId`. Pass `walletAddress`, or omit it to verify against the active wallet's address. An omitted address with no active session now throws `OMSWalletSessionError`, and with an active wallet of another family throws `OMSWalletValidationError`, before any request. A given but empty or whitespace-only `walletAddress` now throws `OMSWalletValidationError` instead of falling back to the active wallet.
  - **`createWallet`** and **`importEncryptedWallet`** take `walletType` instead of `type`.
  - `FeeToken.logoURL` and `FeeToken.tokenID` are renamed to **`logoUrl`** and **`tokenId`**.
  - `upstreamError.code` is always a string; numeric WebRPC codes are stringified (for example `'7313'`).
  - `AuthMode` no longer includes `OTP` or `IDToken`, which no SDK parameter accepted.
  - `OMSWalletClient` is renamed to **`WalletClient`** and `OMSWalletIndexerClient` to **`IndexerClient`**.

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Sign-in can now claim wallets that a project preallocated for the user's verified email.
  
  ### Claimable wallets
  
  - **Automatic wallet selection** uses an owned wallet of the requested type first, then claims a
    claimable wallet of that type, and only then creates a new one. A rejected claim fails the sign-in.
  - Completed sign-in results gain **`claimableWallets`**: the wallets the user can still claim, of
    every type, excluding one claimed during the sign-in.
  - **`PendingWalletSelection`** gains `claimableWallets` (of the requested type) and
    `claimAndSelectWallet({ walletId })`.
  - **`omsWallet.wallet.claimWallet({ walletId })`** claims a wallet from an active session and makes
    it the active wallet. A rejected claim fails with `OMS_REQUEST_FAILED` and the WaaS
    `AccountNotFound` error as `upstreamError`.

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Indexer responses, pending OIDC redirects, and the wagmi connector's wallet type now accept only the current shapes.
  
  - **`@polygonlabs/oms-wallet`:** indexer responses are read only with the indexer gateway's field names. A native balance without `balance`, or token metadata without `tokenId`, now fails with `OMS_INVALID_RESPONSE`.
  - **`@polygonlabs/oms-wallet`:** `completeOidcRedirectAuth` rejects a pending redirect record with a missing or unknown `walletType` as `Pending OIDC redirect auth is invalid` instead of continuing with an Ethereum wallet.
  - **`@polygonlabs/oms-wallet-wagmi-connector`:** `OMSWalletLike.wallet.onSessionExpired` is now required, so session expiry always disconnects wagmi. The SDK's `OMSWallet` already provides it.

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Replace `onSessionExpired` with `onSessionChange`, which reports every change of `activeWallet` or `session` (sign-in, wallet switch, expiry update, sign-out, or expiry) with a reason, including changes made in other tabs, which now stay in sync. `activeWallet` and `session` return the same frozen object until they change, so they work with React's `useSyncExternalStore`. The wagmi connector follows the session while connected: it disconnects when the session ends and changes the account when another Ethereum wallet becomes active. This is a breaking change; see `MIGRATION.md`.

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Sessions now stay signed in while they are used: the session expiry extends with activity, and sessions can last up to 180 days.
  
  ### Session expiry
  
  - **`wallet.session.expiresAt`** is the current expiry. The wallet API extends it with use, up to the lifetime requested at sign-in, and the SDK refreshes it after restoring a session, when the local expiry is reached, and after wallet activity.
  - A session whose local expiry has passed is checked with the wallet API before it ends, so protected operations can continue on an extended session.
  - An idle session ends about 10 days after its last use, and never after the requested lifetime. When the local expiry passes, a session whose lifetime has run out ends at once without asking the wallet API; otherwise the SDK reads the expiry and the wallet API decides. Reading the expiry counts as use, so in a hidden browser page the read waits until the page is shown; with the page open, an ended session is noticed at its expiry.
  - If the wallet API cannot be reached when the local expiry is reached, the session is kept and checked again later. Protected operations then fail with the request error (for example `OMS_REQUEST_FAILED`) instead of `OMS_SESSION_EXPIRED`.
  - When the wallet API reports that the session credential no longer exists or has expired, or the expiry check reports it revoked (`Unauthorized`, 7207), the session ends as on local expiry: listeners receive one `expired` change and the operation fails with `OMSWalletSessionError` (`OMS_SESSION_EXPIRED`), shaped like a local expiry (the wallet API error is its `cause`). This includes a rejected transaction execute, which never ran; a status lookup that fails after submission keeps `OMS_TRANSACTION_STATUS_LOOKUP_FAILED` and its `txnId`. `Unauthorized` from other requests is a request error; the SDK then checks the credential in the background and ends the session only if it was revoked.
  - If the credential signer no longer holds the session's key, for example after a sign-in in another tab, the expiry check clears the session without sending a request, as protected operations do, and listeners receive `expired` when no operation reports it. When that sign-in stored its own session, both now leave its stored session and key in place instead of deleting them.
  - Activating another wallet of the session (`useWallet`, `claimWallet`, `createWallet`, wallet import) keeps the session's current expiry instead of writing back the expiry read before the request.
  
  ### Session lifetime
  
  - **`MAX_SESSION_LIFETIME_SECONDS`** is now 180 days (`15552000`); `sessionLifetimeSeconds` above 30 days was previously rejected.
  - **`DEFAULT_SESSION_LIFETIME_SECONDS`** is now 180 days (`15552000`), the maximum: auth requests that omit `sessionLifetimeSeconds` ask for 180 days instead of one week. A session still ends after 10 days without use, so pass a shorter `sessionLifetimeSeconds` for a hard limit. On wallet API versions without sliding expiry, the requested lifetime is clamped to the server maximum (30 days) and there is no idle timeout, so the default gives a fixed 30-day session there.

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - `upstreamError` has a new `cause` field with the reason the wallet API or an indexer gave for an error, when it gives one. For example, a Tron send from a wallet that has never received TRX now carries `'wallet is not activated on chain: it must receive TRX or a token before it can send'` behind the generic message `'The request was invalid'`.

### Patch Changes

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - A transaction the wallet API refuses because simulation shows it would revert now fails with `OMSWalletRequestError` (`OMS_REQUEST_FAILED`, status 400, `upstreamError.code` `'7314'`) instead of `OMS_TRANSACTION_EXECUTION_UNCONFIRMED`; it was never submitted. The same applies when the wallet API refuses the execute request before submitting anything: an invalid request signature (`'7201'`), an exceeded credential usage limit (`'7205'`), or `Unauthorized` (`'7207'`). Other execute failures are unchanged.

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - A session that ends on its own (expiry, the wallet API rejecting its credential, or another tab replacing its key) no longer deletes a signing key or pending sign-in redirect state that another tab's newer sign-in stored. With the default browser signer, the key is deleted only while it is still the ended session's, checked and deleted in one IndexedDB transaction. Signing out and starting a new sign-in clear them as before.

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - `completeOidcRedirectAuth` now reports a corrupted pending redirect record as `Pending OIDC redirect auth is invalid` instead of a raw JSON parse error.

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Signed wallet API requests no longer hang, and execute failures say more precisely whether anything was submitted.
  
  - Requests signed with the session credential, including the session expiry read, and `RemoteAccessClient` requests fail with `OMS_REQUEST_FAILED` after 30 seconds without a response. The deadline counts the wait for other session requests and the signing, and a request whose signer finishes after it is never sent. Previously one request that never completed could block every later wallet call.
  - An execute request the SDK never sent, because signing failed or the deadline passed first, fails with `OMS_REQUEST_FAILED` and no `txnId` instead of `OMS_TRANSACTION_EXECUTION_UNCONFIRMED`. An execute that was sent before it timed out stays unconfirmed.
  - A Tron execute refused while the wallet API prices it again (`InvalidRequest` 7200 or `InvalidFeeOption` 7310) fails with `OMS_REQUEST_FAILED` and no `txnId`: nothing was broadcast.
  - After the wallet API answers the expiry read with `WebrpcBadRoute`, the SDK asks again 15 minutes later instead of never.

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - A stored session whose saved expiry has passed is restored and checked with the wallet API instead of being discarded, unless its requested lifetime has run out. Requests after the SDK last read the expiry can extend the session on the wallet API without the SDK seeing it, so an idle session could otherwise end early on the next page load. When the read cannot reach the wallet API, the SDK retries it while the page is shown, at most 15 minutes apart, so a session restored offline is settled soon after the network returns.

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Concurrent wallet requests no longer fail when the wallet API rejects one for an out-of-order nonce.
  
  When the wallet API rejects a signed request's nonce (WaaS `PreconditionFailed`, 7206), the SDK signs the request again with a fresh nonce and resends it, up to 2 times. The wallet API rejects the nonce before running the method, so this also applies to transaction writes. If the last attempt is still rejected, the error surfaces as a request error (`OMS_REQUEST_FAILED`, status 412); a transaction's `Execute` reports it the same way instead of as `OMS_TRANSACTION_EXECUTION_UNCONFIRMED`, because the transaction was never submitted.

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - `OMSWallet` instances of one project can no longer drift apart, and projects on one origin keep their own sessions.
  
  - Creating `OMSWallet` again for the same project and environment returns the same wallet when the instances already share their stored session: the browser defaults, or the same `storage`, `credentialSigner` and `redirectAuthStorage` objects. A rotated publishable key of the same project keeps the session and sends the new key. Node defaults and per-user storage stay separate sessions. Reusing one `storage` object with a different `credentialSigner` or `redirectAuthStorage` throws `OMSWalletValidationError`.
  - Stored sessions, signing keys and redirect state are kept per project and wallet API origin, so several projects or environments on one origin no longer sign each other out.
  - Requests signed with one credential are sent one at a time, in order, by every client in the process (wallet and remote-access clients alike) and across tabs with Web Locks, so concurrent calls from this app are no longer rejected for a stale nonce.
  - The 30-second request deadline now also covers reading the response body, so a response whose body stalls fails instead of hanging.
  - The wagmi connector observes session expiry from `connect` on, so configs that never connect leave no listener.

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Wallet import now trusts the WaaS v1.2.0 enclave measurements for Production and Staging alongside the currently deployed ones, and no longer trusts the retired v1.1.0 Production measurement.

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Require viem `2.55.0` or newer, so installs no longer resolve the `ws` version affected by GHSA-96hv-2xvq-fx4p.
  
  - **`@polygonlabs/oms-wallet`:** the `viem` dependency is now `^2.55.0`.
  - **`@polygonlabs/oms-wallet-wagmi-connector`:** the `viem` peer range is now `>=2.55.0 <3`, and the `@wagmi/core` peer range is now `>=3.6.5 <4`. viem 2.56 and later removed an export that earlier `@wagmi/core` releases import, so those releases fail to build with current viem.

- [#104](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/104) [`1801a73`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/1801a73df79b2035588be7e4c92749a3e627b5d5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - The default browser credential signer no longer leaves a tab stuck after another tab signs out and back in.
  
  When another tab removed the shared signing key, the signer could report no credential ID, and the session check failed with a `TypeError` on every operation. The signer now reloads or recreates its key on next use, and a missing key counts as a mismatch, so the stale tab's session is cleared like any other replaced session.
  
  The signer also reports the stored key rather than the one it loaded earlier, so a tab whose key another tab replaced clears its session before sending anything, instead of sending one request that the wallet API rejects as an invalid signature. A request whose key is replaced while it is being signed fails without being sent.

## 0.3.1

### Patch Changes

- [#103](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/103) [`0b97509`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/0b975098deb0c49c4e28e600cdc2fc1a9ee767f5) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Wallet import trusts the WaaS v1.1.1 enclave measurements on Staging and Production.
  
  - **Staging:** restores wallet import, which was failing with `OMS_ATTESTATION_VERIFICATION_FAILED` after the Staging enclave was upgraded.
  - **Production:** trusts the v1.1.1 measurement alongside the current one, so wallet import keeps working when Production is upgraded. Update before that rollout to avoid import failures.

## 0.3.0

### Minor Changes

- [#85](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/85) [`6fb0b31`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/6fb0b316d82db655a1ef6063027d53c6a383e9f3) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Add public smart-session credential inspection, owner-side session management, a signed remote
  application client for backend session transactions, and Solana wallet creation, off-chain message
  signing and verification, and native SOL and SPL-token transfers. Solana transfers now default to
  relayer mode: network fees are sponsored, while fee options are returned for rent when a recipient
  token account must be created.
  
  `walletAddress` and `WalletAccount` now represent both Ethereum and Solana addresses. Use the wallet
  type discriminator before applying Ethereum-specific address handling.
  
  Ethereum-specific signing, transactions, and smart-session authorization now reject an active
  Solana wallet explicitly.
  
  Sponsored transactions now invoke an optional fee selector with an empty list before execution, so
  applications can acknowledge the free fee or stop the transaction. `FeeOptionSelector.firstAvailable`
  continues sponsored execution without sending a fee option and uses Solana indexer balances to pick
  an affordable option for non-sponsored Solana transfers.

- [#85](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/85) [`6fb0b31`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/6fb0b316d82db655a1ef6063027d53c6a383e9f3) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - `OMSWallet.indexer.getSolanaBalances` now retrieves native SOL and fungible SPL-token balances across Solana Mainnet and Devnet.
  
  Balance results include token metadata, verification and USD pricing when available, while per-network failures are returned separately without discarding successful results.

- [#85](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/85) [`6fb0b31`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/6fb0b316d82db655a1ef6063027d53c6a383e9f3) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Add attested EVM and Solana wallet import and smart-session read APIs for owners and remote applications.
  
  - **Wallet import:** import raw keys through HPKE or provide externally encrypted key material through the advanced import methods. Polygon-managed environments now supply their attestation trust policy automatically.
  - **Wallet provenance:** every `WalletAccount` now requires `keyOrigin`, distinguishing enclave-generated and imported keys.
  - **Session reads:** wallet owners can read an authorized session and its grant usage, while `RemoteAccessClient` can list and read every session scoped to its credential.
  - **Access management:** `AccessGrant` now discriminates direct and remote access with `type`, and `revokeAccess` accepts `credentialId` plus an optional `sessionId` instead of `targetCredentialId`.
  - **Errors:** duplicate-address and failed-attestation imports now have stable SDK error codes.

### Patch Changes

- [#85](https://github.com/0xPolygon/oms-wallet-typescript-sdk/pull/85) [`6fb0b31`](https://github.com/0xPolygon/oms-wallet-typescript-sdk/commit/6fb0b316d82db655a1ef6063027d53c6a383e9f3) Thanks [@tolgahan-arikan](https://github.com/tolgahan-arikan)! - Enable Development sandbox wallet import while verifying the Nitro certificate chain, freshness,
  nonce, signature, and request/response binding. Development's debug-mode PCR0 is all zeroes and
  should be used only with disposable keys.
