# Error contract

Every error the SDK throws is a `WalletError`, including WaaS refusals, Trails failures and
malformed upstream responses. Branch on `code`, never on `message`.

```ts
import { isUpstreamError, isWalletError } from '@polygonlabs/oms-server-wallet-sdk';
import { TrailsError } from '@polygonlabs/oms-server-wallet-sdk/trails';

try {
  await wallet.evm.execute({ idempotencyKey, reviewId });
} catch (error) {
  if (isUpstreamError(error)) log(error.method, error.upstreamCode); // WaaS refused
  else if (error instanceof TrailsError) log(error.method, error.httpStatus);
  else if (isWalletError(error) && error.code === 'STALE_REVIEW') reReview();
  else throw error;
}
```

| Class | `code` | Extra fields |
| --- | --- | --- |
| `WalletError` | Any `WalletErrorCode` | `message` (safe to show), `status` |
| `UpstreamError` | `UPSTREAM_ERROR` | `upstreamCode` (WaaS error code), `method` (WaaS RPC) |
| `TrailsError` (`/trails`) | `TRAILS_ERROR` | `method`, `httpStatus`, optional `upstreamCode` |

When the SDK wraps a lower-level failure, such as a network timeout or TLS error, the original error is kept as the standard `cause` property for logging.

`isWalletErrorCode(value)` tells whether a string is a `WalletErrorCode`, for example to narrow a swap's `error`, which can also hold upstream Trails statuses. `isWalletError` matches all three; `isUpstreamError` matches `UpstreamError` only. `status` is an
HTTP-style hint: 400 for invalid input, 404 for an unknown ID, 409 for a state conflict, 502 for an
upstream failure and 503 for configuration.

## Thrown and recorded codes

Codes are thrown, and some are also recorded on a stored operation's `error` (or a swap's `error`)
so the outcome survives a restart. Settlement codes such as `SUBMISSION_UNCERTAIN` and
`RECONCILIATION_REQUIRED` are usually read from the operation rather than caught. Use
`describeOperation(operation)` for the next safe action.

## Codes

### Configuration

| Code | Meaning | What to do |
| --- | --- | --- |
| `CONFIGURATION` | Invalid factory options: publishable key, origin, OIDC, storage, executor, attestation, swaps, or an option an ephemeral handle does not take. | Fix the configuration; the message names the field. |
| `RPC_CONFIGURATION` | A Trails chain has no valid HTTPS RPC endpoint. | Configure `chains` in `trails(...)`. |
| `UNSUPPORTED_PROTOCOL` | The Trails endpoint does not speak the required protocol version. | Point Trails at a supported endpoint. |

### Invalid input

| Code | Meaning | What to do |
| --- | --- | --- |
| `INVALID_INPUT` | A malformed argument, such as `waitForOperation` `timeoutMs`, a `txnId`, or `resolveReconciliation` input. | Fix the argument. |
| `INVALID_IDEMPOTENCY_KEY` | The key is not 8–100 letters, digits, `_` or `-`, or starts with the reserved `swp_`. | Use a valid key. |
| `INVALID_IDENTITY` | The subject is empty or longer than 128 characters. | Fix the subject. |
| `INVALID_FAMILY` | `families` is not a non-empty list of `evm`, `solana`, `tron`. | Fix `families`. |
| `INVALID_ADDRESS` | An address is not valid for its network, or a recipient is the sending wallet. | Fix the address. |
| `INVALID_AMOUNT` | An amount is not a base-unit integer in range, or exceeds the token's precision. | Pass base units (see `parseAmount`). |
| `INVALID_TRANSFER` | A transfer is missing a chain, recipient, asset or positive amount. | Complete the transfer input. |
| `INVALID_CALL` | A contract call is malformed, targets the wallet itself, or its ABI arguments do not encode. | Fix the call. |
| `INVALID_FEE` | `maxFee` is not a positive amount of sun. | Fix `maxFee`. |
| `INVALID_MESSAGE` | A message is empty or larger than 16,384 UTF-8 bytes. | Shorten the message. |
| `INVALID_TYPED_DATA` | Typed data is malformed, bound to another chain, a Sequence wallet `Calls` authorization, or names the wallet as `verifyingContract`. | Fix the typed data; the last two are refused by design. |
| `INVALID_PAGE` | Pagination options are out of range. | Fix `limit`, `offset`, `page` or `cursor`. |
| `INVALID_JSON` | A value is not bounded JSON with lossless numbers. | Pass plain JSON; use strings for large integers. |
| `UNSUPPORTED_CHAIN` | The EVM chain ID is not one the SDK supports. | Use a `SupportedEvmChainId`. |
| `UNSUPPORTED_NETWORK` | The Solana or Tron network name is not supported. | Use `solana:mainnet`/`solana:devnet` or `tron:mainnet`/`tron:nile`. |
| `INVALID_SWAP` | Swap input uses unsupported assets, the same side twice, a non-positive amount or disallowed slippage. | Fix the swap input. |
| `INVALID_RECOVERY` | Recovery input or the prepared recovery does not match the swap, side, owner or balances. | Prepare recovery again with valid input. |

### Wallet state

| Code | Meaning | What to do |
| --- | --- | --- |
| `WALLET_NOT_INITIALIZED` | The family's wallet has not been created or restored on this handle; an ephemeral handle found none on WaaS. | Call `createOrRestore` (or `restore()` on an ephemeral handle); create wallets durably first. |
| `WALLET_PENDING` | Swaps need the EVM wallet, which is not restored yet. | Call `createOrRestore`. |
| `WALLET_DISABLED` | The wallet is disabled. | `enable()` it, or stop using it. |
| `WALLET_CLOSED` | The ephemeral handle was closed. | Create a new handle. |
| `WALLET_MISMATCH` | WaaS shows a different or duplicate wallet for the identity, or a swap belongs to another wallet. | Stop and investigate; do not retry blindly. |
| `WALLET_BUSY` | Too many unresolved swaps for this wallet. | Reconcile existing swaps first. |
| `CREATION_UNCERTAIN` | An earlier create request has an unknown outcome. | Restore again later; no duplicate wallet is created. |
| `NO_CREDENTIAL` | No credential is available for the request. | Retry; the SDK signs in again. |
| `IDEMPOTENCY_CONFLICT` | The idempotency key was already used with different input or mode. | Use a new key for new input. |
| `NOT_FOUND` | No operation, prepared transaction or swap has that ID. | Check the ID. |
| `INVALID_STATE` | Stored state is unreadable, or the operation is not in a state that allows the request. | Read the message; unreadable state needs operator attention. |
| `STORAGE_INTEGRITY` | Encrypted state failed authentication: wrong key, namespace or tampered data. | Check `encryptionKey` and storage; never ignore. |

### Review and approval

| Code | Meaning | What to do |
| --- | --- | --- |
| `APPROVAL_REQUIRED` | An immediate `send*` was used on an ID prepared for review. | Call `execute({ idempotencyKey, reviewId })`. |
| `STALE_REVIEW` | The `reviewId` (or `txnId`) does not match the prepared operation. | Review the current operation, then execute. |
| `STALE_QUOTE` | The swap `reviewId` does not match the current quote. | Review the current swap quote. |
| `STALE_RECOVERY` | The recovery `reviewId` does not match the prepared recovery. | Review the current recovery. |
| `OPERATION_CANCELLED` | `execute` was called on an operation cancelled with `cancel`; nothing was sent. | Prepare a replacement under a new key if still wanted. |
| `QUOTE_EXPIRED` | The quote expired before submission; nothing was sent. | Prepare again under a new key. |
| `SPONSORSHIP_REQUIRED` | The transaction is not sponsored (and, on Tron, no `maxFee` allows paying). | Enable sponsorship, or set `maxFee` on Tron. |
| `FEE_LIMIT_EXCEEDED` | The quoted Tron fee exceeds `maxFee`. | Raise `maxFee` or retry later. |

### Execution and settlement

| Code | Meaning | What to do |
| --- | --- | --- |
| `EXECUTE_REFUSED` | WaaS refused `Execute` before claiming the transaction; nothing was sent (`provenUnsent`). | Prepare again if still wanted. |
| `FEE_ABOVE_QUOTE` | WaaS re-priced the fee above the quote at `Execute`; nothing was sent. | Prepare again. |
| `SUBMISSION_UNCERTAIN` | `Execute` may have been sent; its outcome is unknown. | Refresh or wait on the same operation; never send a replacement. |
| `RECONCILIATION_REQUIRED` | Still unconfirmed after the post-expiry grace window. | Verify out of band, then `resolveReconciliation`. |
| `PREPARATION_FAILED` | Preparing failed with an error that is not a `WalletError` (recorded on the operation). | Inspect logs; prepare again. |
| `SIGNING_FAILED` | Signing failed with an error that is not a `WalletError` (recorded on the operation). | Inspect logs; sign again under a new key. |
| `SIGNATURE_INVALID` | WaaS returned a signature that did not verify. | Do not use it; retry or investigate. |
| `TYPED_DATA_REFUSED` | `signing.authorizeTypedData` did not return `true`, or typed-data signing is not configured. Nothing was signed or recorded. | Treat as a policy refusal; the same key can be retried. |
| `DEBIT_PENDING` | Another debit on the chain is pending or uncertain (including a swap reservation). | Settle or reconcile it first. |
| `SWAPS_COORDINATION_REQUIRED` | The wallet has swaps coordination, but this handle was created without `swaps`. | Create the wallet with `swaps: trails(...)`. |

### Upstream and transport

| Code | Meaning | What to do |
| --- | --- | --- |
| `UPSTREAM_ERROR` | WaaS refused the request (`UpstreamError`; see `upstreamCode`, `method`). | Branch on `upstreamCode` where needed. |
| `UPSTREAM_REDIRECT` | WaaS or Trails answered with a redirect, which is never followed. | Check the endpoint and network path. |
| `UPSTREAM_UNAVAILABLE` | A WaaS request failed before a verified response was received (network error or timeout). | Retry idempotent reads; reconcile mutations before retrying. |
| `ATTESTATION_FAILED` | A WaaS response failed enclave attestation. | Do not bypass; check `attestation` and the endpoint. |
| `IDENTITY_MISMATCH` | WaaS authenticated a different identity or credential. | Check the OIDC subject and issuer. |
| `INVALID_RESPONSE` | WaaS, Trails or the indexer returned a response the SDK does not accept. | Retry later; report if it persists. |
| `INVALID_METHOD` | An internal WaaS method name was rejected (SDK bug). | Report it. |
| `RESPONSE_TOO_LARGE` | An upstream response exceeded the size limit. | Retry; report if it persists. |
| `INDEXER_UNAVAILABLE` | The balance service failed. | Retry later; balances are display-only. |
| `CHAIN_READ_FAILED` | A chain RPC read failed, returned a mismatched chain, or an unexpected result. | Check the RPC endpoint; retry. |

### Trails swaps

| Code | Meaning | What to do |
| --- | --- | --- |
| `TRAILS_ERROR` | Trails refused a request (`TrailsError`). | Inspect `method`, `httpStatus`, `upstreamCode`. |
| `TRAILS_TIMEOUT` | A Trails request timed out. | Reconcile before retrying a mutation. |
| `TRAILS_ABORTED` | A Trails request was aborted by its signal. | Reconcile before retrying a mutation. |
| `TRAILS_UNAVAILABLE` | A Trails request did not complete. | Reconcile before retrying a mutation. |
| `SWAPS_DISABLED` | New swaps are disabled (`enabled: false`). | Re-enable swaps to start new ones. |
| `SWAP_UNAVAILABLE` | A swap step failed with an error that is not a `WalletError` (recorded on the swap). | `reconcile` or `tick` later. |
| `SWAP_ENVIRONMENT_CHANGED` | The swap was created against another Trails endpoint or project. | Restore the original Trails configuration. |
| `INVALID_SWAP_QUOTE` | The Trails quote does not match the requested swap or funding contract. | Request a new quote. |
| `INTENT_ALREADY_TRACKED` | Another swap already tracks this Trails intent. | Use the existing swap. |
| `INTENT_NOT_FUNDABLE` | Trails will not accept funding for the intent. | Quote a new swap. |
| `INSUFFICIENT_BALANCE` | The on-chain balance is below the reviewed input amount. | Fund the wallet or quote a smaller swap. |
| `FUNDING_FAILED` | The funding transaction failed. | Inspect the swap; recover if needed. |
| `FUNDING_REVERTED` | The funding transaction reverted on chain. | Inspect the swap; recover if needed. |
| `FUNDING_UNKNOWN` | The funding operation record is missing. | Reconcile before proceeding. |
| `FUNDING_RECEIPT_UNVERIFIED` | The token receipt does not prove the exact reviewed deposit. | Investigate before proceeding. |
| `SETTLEMENT_REQUIRES_REVIEW` | Trails reports success, but the destination amount or recipient does not match. | Review manually. |
| `REFUND_REQUIRES_REVIEW` | Trails reports a refund that cannot be verified. | Review manually. |

### Trails recovery

| Code | Meaning | What to do |
| --- | --- | --- |
| `INVALID_RECOVERY_TRANSACTION` | The built recovery transaction does not match the reviewed authorization. | Do not execute; prepare recovery again. |
| `NO_RECOVERABLE_BALANCE` | No recoverable balance exists on that side of the intent. | Nothing to recover there. |
| `RECOVERY_NOT_READY` | The route is still progressing. | Recover after failure or a prolonged stall. |
| `RECOVERY_PENDING` | Another recovery is active. | Reconcile it first. |
| `RECOVERY_CHANGED` | A reviewed recovery balance is no longer available. | Prepare recovery again. |
| `RECOVERY_EVIDENCE_PENDING` | The recovery receipt does not yet prove the received amount. | `reconcile` later. |
| `RECOVERY_EXPIRED` | The recovery transaction expired before execution. | Prepare recovery again. |
| `RECOVERY_FAILED` | The recovery transaction failed. | Inspect, then prepare recovery again. |
| `RECOVERY_LIMIT` | The recovery history limit was reached. | Operator intervention is required. |
