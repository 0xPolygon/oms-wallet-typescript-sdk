---
'@polygonlabs/oms-server-wallet-sdk': patch
---

Store operation history in per-family 256-entry chunks instead of a single monolithic `operationIndex` array.

- Prevents Cloudflare Durable Objects KV wallets from hitting the 128 KiB per-value limit after ~2,500 lifetime operations.
- Reduces operation status updates to `O(1)` writes with zero history-index churn, and makes `listOperations({ status: 'all' })` `O(limit)` per family instead of scanning every operation across all families.
- Keeps internal Trails swap operations in a dedicated chunked bucket so public `evm.listOperations()` never scans past them, while preserving full `openOperationIndex` rebuild and crash-safe recovery.
