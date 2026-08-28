import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { test } from 'vitest';

import { SMART_SESSION_ASSETS } from '../shared/networks.ts';
import {
  createSmartSessionGrants,
  MAX_SMART_SESSION_GRANTS,
  recipientIsAllowed,
  validateRecipientScope
} from '../shared/permissions.ts';

const receiverOne = '0x120117a430b5bf1ba6752732196cb86976701d53';
const receiverTwo = '0xf713cf113a249e08d97932db5d2a6cc03aa2f44f';

test('native permissions require exactly one specific receiver', () => {
  assert.deepEqual(
    createSmartSessionGrants(
      SMART_SESSION_ASSETS.pol,
      { mode: 'specific', recipients: [receiverOne] },
      10n
    ),
    [{ kind: 'nativeTransfer', to: getAddress(receiverOne), limit: 10n }]
  );
  assert.throws(
    () => validateRecipientScope({ mode: 'any' }, 'native'),
    /require one specific receiver/
  );
  assert.throws(
    () =>
      validateRecipientScope(
        { mode: 'specific', recipients: [receiverOne, receiverTwo] },
        'native'
      ),
    /exactly one receiver/
  );
});

test('specific ERC-20 receivers become separate cumulative grants', () => {
  assert.deepEqual(
    createSmartSessionGrants(
      SMART_SESSION_ASSETS.usdc,
      { mode: 'specific', recipients: [receiverOne, receiverTwo] },
      1_000_000n
    ),
    [
      {
        kind: 'erc20Transfer',
        token: SMART_SESSION_ASSETS.usdc.tokenAddress,
        to: getAddress(receiverOne),
        limit: 1_000_000n,
        cumulative: true
      },
      {
        kind: 'erc20Transfer',
        token: SMART_SESSION_ASSETS.usdc.tokenAddress,
        to: getAddress(receiverTwo),
        limit: 1_000_000n,
        cumulative: true
      }
    ]
  );
});

test('any-receiver ERC-20 permission omits the grant recipient', () => {
  assert.deepEqual(
    createSmartSessionGrants(SMART_SESSION_ASSETS.usdt, { mode: 'any' }, 2_000_000n),
    [
      {
        kind: 'erc20Transfer',
        token: SMART_SESSION_ASSETS.usdt.tokenAddress,
        limit: 2_000_000n,
        cumulative: true
      }
    ]
  );
  assert.equal(recipientIsAllowed({ mode: 'any' }, receiverTwo), true);
});

test('specific receiver validation rejects duplicates and unauthorized recipients', () => {
  assert.throws(
    () =>
      validateRecipientScope(
        { mode: 'specific', recipients: [receiverOne, getAddress(receiverOne)] },
        'erc20'
      ),
    /unique/
  );
  assert.equal(
    recipientIsAllowed({ mode: 'specific', recipients: [receiverOne] }, getAddress(receiverOne)),
    true
  );
  assert.equal(
    recipientIsAllowed({ mode: 'specific', recipients: [receiverOne] }, receiverTwo),
    false
  );
});

test('recipient validation enforces the Sessions Module grant limit', () => {
  const recipients = Array.from(
    { length: MAX_SMART_SESSION_GRANTS + 1 },
    (_, index) => `0x${index.toString(16).padStart(40, '0')}`
  );
  assert.throws(
    () => validateRecipientScope({ mode: 'specific', recipients }, 'erc20'),
    new RegExp(`at most ${MAX_SMART_SESSION_GRANTS} grants`)
  );
});
