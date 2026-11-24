import type { OperationGuidance, WalletOperation } from './types.js';

function isSignatureKind(kind: WalletOperation['kind']): boolean {
  return kind === 'sign' || kind === 'signTypedData';
}

/**
 * Pure decision helper derived from validated operation evidence (never mutates state or calls the
 * network). Tells orchestrators and agents what is safe to do next, with original IDs.
 */
export function describeOperation(operation: WalletOperation): OperationGuidance {
  const base = {
    operationId: operation.id,
    ...(operation.quote?.txnId ? { txnId: operation.quote.txnId } : {}),
    ...(operation.txnHash ? { txnHash: operation.txnHash } : {}),
    ...(operation.reviewId ? { reviewId: operation.reviewId } : {})
  };

  switch (operation.status) {
    case 'executed':
      return {
        ...base,
        action: 'done',
        reason: operation.txnHash
          ? 'Transaction executed on WaaS. Verify the chain receipt before treating payment as settled.'
          : 'Transaction reported executed without a transaction hash; verify the upstream/on-chain outcome.'
      };

    case 'signed':
      return {
        ...base,
        action: 'done',
        reason: 'Signature was produced and verified by WaaS.'
      };

    case 'quoted':
      if (!operation.reviewId)
        return {
          ...base,
          action: 'safe-to-reprepare',
          reason:
            'Legacy quoted operation predates reviewId binding and cannot be executed. Prepare and review a new operation under a fresh idempotencyKey.'
        };
      return {
        ...base,
        action: 'await-review',
        reason:
          'Prepared and quoted, not submitted. Review the terms and call execute with idempotencyKey and reviewId before expiry.'
      };

    case 'preparing':
      return {
        ...base,
        action: 'safe-to-reprepare',
        reason:
          'Preparation was interrupted before a quote was persisted; nothing was submitted. Retry prepare with the same idempotencyKey or start a new one.'
      };

    case 'pending':
      return {
        ...base,
        action: 'poll-original',
        reason:
          'Transaction was claimed for broadcast. Refresh or wait on this same operation ID; never submit a replacement.'
      };

    case 'submitting':
      return {
        ...base,
        action: 'poll-original',
        reason:
          'Submission began and outcome is not yet confirmed. Refresh this same operation ID; never submit a replacement.'
      };

    case 'unknown':
      if (isSignatureKind(operation.kind))
        return {
          ...base,
          action: 'reconcile-original',
          reason:
            'Signature attempt has an unknown outcome and cannot be polled as a transaction. Inspect upstream logs before issuing a new signing ID.'
        };
      if (operation.error === 'RECONCILIATION_REQUIRED')
        return {
          ...base,
          action: 'reconcile-original',
          reason:
            'Submission outcome remains unconfirmed past the quote grace window. Reconcile the original operation and WaaS txnId before authorizing any replacement.'
        };
      return {
        ...base,
        action: 'poll-original',
        reason:
          'Submission outcome is uncertain. Refresh this same operation ID; never submit a replacement.'
      };

    case 'expired':
      if (operation.provenUnsent)
        return {
          ...base,
          action: 'safe-to-reprepare',
          reason:
            'Quote expired locally before submission; nothing was broadcast. Prepare and review again under a new idempotencyKey.'
        };
      return {
        ...base,
        action: 'reconcile-original',
        reason:
          'Operation is marked expired without local proof that submission never occurred. Reconcile the original txnId before issuing any replacement.'
      };

    case 'failed':
      if (operation.provenUnsent)
        return {
          ...base,
          action: 'safe-to-reprepare',
          reason:
            'Operation failed before submission or broadcast claim; nothing was broadcast. Prepare and review again under a new idempotencyKey.'
        };
      return {
        ...base,
        action: 'done',
        reason: isSignatureKind(operation.kind)
          ? 'Signing failed or failed verification. Investigate the error and use a new idempotencyKey if still desired.'
          : 'Operation failed. Inspect the error and any on-chain state before authorizing a new business request.'
      };
  }
}
