import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { test } from 'vitest';

import { getSmartSessionAsset, SMART_SESSION_ASSETS } from '../shared/networks.ts';
import {
  createSmartSessionGrants,
  MAX_SMART_SESSION_GRANTS,
  validateRecipientScope
} from '../shared/permissions.ts';

const receiverOne = '0x120117a430b5bf1ba6752732196cb86976701d53';
const receiverTwo = '0xf713cf113a249e08d97932db5d2a6cc03aa2f44f';
const polygonUsdc = getSmartSessionAsset('polygon', 'usdc');
const polygonUsdt = getSmartSessionAsset('polygon', 'usdt');
if (polygonUsdc.kind !== 'erc20' || polygonUsdt.kind !== 'erc20') {
  throw new Error('Polygon stablecoins must be ERC-20 assets');
}

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
      polygonUsdc,
      { mode: 'specific', recipients: [receiverOne, receiverTwo] },
      1_000_000n
    ),
    [
      {
        kind: 'erc20Transfer',
        token: polygonUsdc.tokenAddress,
        to: getAddress(receiverOne),
        limit: 1_000_000n,
        cumulative: true
      },
      {
        kind: 'erc20Transfer',
        token: polygonUsdc.tokenAddress,
        to: getAddress(receiverTwo),
        limit: 1_000_000n,
        cumulative: true
      }
    ]
  );
});

test('any-receiver ERC-20 permission omits the grant recipient', () => {
  assert.deepEqual(createSmartSessionGrants(polygonUsdt, { mode: 'any' }, 2_000_000n), [
    {
      kind: 'erc20Transfer',
      token: polygonUsdt.tokenAddress,
      limit: 2_000_000n,
      cumulative: true
    }
  ]);
});

// Literal addresses, so a wrong constant in shared/networks.ts is caught here.
test.each([
  ['Polygon Amoy', 'polygon-amoy', '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582'],
  ['Base', 'base', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
  ['Base Sepolia', 'base-sepolia', '0x036CbD53842c5426634e7929541eC2318f3dCF7e']
] as const)('USDC permissions use the USDC contract for %s', (_label, networkId, token) => {
  const usdc = getSmartSessionAsset(networkId, 'usdc');
  assert.equal(usdc.kind, 'erc20');
  if (usdc.kind !== 'erc20') return;

  assert.deepEqual(createSmartSessionGrants(usdc, { mode: 'any' }, 1_000_000n), [
    {
      kind: 'erc20Transfer',
      token,
      limit: 1_000_000n,
      cumulative: true
    }
  ]);
});

test('specific receiver validation rejects duplicates', () => {
  assert.throws(
    () =>
      validateRecipientScope(
        { mode: 'specific', recipients: [receiverOne, getAddress(receiverOne)] },
        'erc20'
      ),
    /unique/
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
