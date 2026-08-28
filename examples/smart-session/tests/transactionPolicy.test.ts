import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { test } from 'vitest';

import { requireAllowedTransactionRecipient } from '../shared/permissions.ts';

const approvedReceiver = '0x120117a430b5bf1ba6752732196cb86976701d53';
const otherReceiver = '0xf713cf113a249e08d97932db5d2a6cc03aa2f44f';

test('transaction policy accepts only a listed specific receiver', () => {
  assert.equal(
    requireAllowedTransactionRecipient(
      { mode: 'specific', recipients: [approvedReceiver] },
      approvedReceiver
    ),
    getAddress(approvedReceiver)
  );
  assert.throws(
    () =>
      requireAllowedTransactionRecipient(
        { mode: 'specific', recipients: [approvedReceiver] },
        otherReceiver
      ),
    /not allowed by this smart session/
  );
});

test('transaction policy accepts any valid receiver for an unrestricted ERC-20 grant', () => {
  assert.equal(
    requireAllowedTransactionRecipient({ mode: 'any' }, otherReceiver),
    getAddress(otherReceiver)
  );
  assert.throws(
    () => requireAllowedTransactionRecipient({ mode: 'any' }, 'not-an-address'),
    /not a valid address/
  );
});
