import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test, vi } from 'vitest';

import type { RemoteAccessSession, SmartSessionGrantUsage } from '@polygonlabs/oms-wallet';

import type {
  AdminOverview,
  AdminTransaction,
  ApprovalRequest,
  CreateApprovalBody,
  CreatedApproval
} from '../shared/api.js';
import { SMART_SESSION_ASSETS } from '../shared/networks.js';
import worker from '../worker/index.js';

interface MockSession {
  credentialId: string;
  session: RemoteAccessSession;
  usage: SmartSessionGrantUsage[];
  listed: boolean;
  active: boolean;
}

const mockedWaas = vi.hoisted(() => ({
  nextTransaction: 0,
  revokedCredentialIds: [] as string[],
  sessions: new Map<string, MockSession>(),
  preparedTransactions: [] as Array<Record<string, unknown>>
}));

vi.mock('../worker/rac.js', () => ({
  RAC_LIFETIME_SECONDS: 30 * 24 * 60 * 60,
  createRacContext: async (_publishableKey: string, privateKey: string) => {
    const racSuffix = privateKey.slice(-12);
    const credentialId = `credential-${racSuffix}`;
    const findSession = (sessionId: string): MockSession => {
      const entry = mockedWaas.sessions.get(sessionId);
      if (!entry?.active || entry.credentialId !== credentialId) {
        throw Object.assign(new Error('Session not found'), { status: 404 });
      }
      return entry;
    };
    return {
      signerId: `signer-${racSuffix}`,
      client: {
        registerCredential: async () => ({ credentialId }),
        revokeCredential: async ({ credentialId: revokedId }: { credentialId: string }) => {
          mockedWaas.revokedCredentialIds.push(revokedId);
        },
        listSessions: async () =>
          Array.from(mockedWaas.sessions.values())
            .filter((entry) => entry.credentialId === credentialId && entry.active && entry.listed)
            .map((entry) => entry.session),
        getSession: async ({ sessionId }: { sessionId: string }) => findSession(sessionId).session,
        getSessionUsage: async ({ sessionId }: { sessionId: string }) =>
          findSession(sessionId).usage,
        prepareTransaction: async (params: Record<string, unknown>) => {
          mockedWaas.preparedTransactions.push(params);
          mockedWaas.nextTransaction += 1;
          return {
            txnId: `txn-${mockedWaas.nextTransaction}`,
            status: 'quoted',
            sponsored: true,
            feeOptions: []
          };
        },
        executeTransaction: async () => ({ status: 'pending' }),
        getTransactionStatus: async ({ txnId }: { txnId: string }) => ({
          status: 'executed',
          txnHash: `0x${txnId.replace('txn-', '').padStart(64, '0')}`
        })
      }
    };
  }
}));

interface TestEnv {
  DB: D1Database;
  OMS_PUBLISHABLE_KEY: string;
  TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as TestEnv;
const origin = 'https://smart-session.example';
const recipientA = '0x1000000000000000000000000000000000000001';
const recipientB = '0x2000000000000000000000000000000000000002';
const walletA = '0x3000000000000000000000000000000000000003';
const walletB = '0x4000000000000000000000000000000000000004';
const sessionSigner = '0x5000000000000000000000000000000000000005';

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(() => {
  mockedWaas.revokedCredentialIds.length = 0;
  mockedWaas.sessions.clear();
  mockedWaas.preparedTransactions.length = 0;
});

test('rotating one backend RAC removes only its activity', async () => {
  const activityA = await createNativeActivity(
    'admin-a-token-that-is-at-least-32-characters',
    recipientA,
    walletA,
    'session-a'
  );
  const activityB = await createNativeActivity(
    'admin-b-token-that-is-at-least-32-characters',
    recipientB,
    walletB,
    'session-b'
  );

  await adminRequest(
    activityA.token,
    `/api/admin/approvals/${activityB.approvalId}/link`,
    { method: 'POST' },
    404
  );
  await adminRequest(
    activityA.token,
    `/api/admin/sessions/${activityB.sessionRecordId}/transactions`,
    { method: 'POST', body: { recipient: recipientB, amount: '1' } },
    404
  );
  await adminRequest(
    activityA.token,
    `/api/admin/transactions/${activityB.transactionId}`,
    undefined,
    404
  );

  await adminRequest(activityA.token, '/api/admin/rac/rotate', { method: 'POST' });

  const rotatedA = await overview(activityA.token);
  const preservedB = await overview(activityB.token);
  expect(rotatedA.credential.id).not.toBe(activityA.credentialId);
  expect(rotatedA.approvals).toEqual([]);
  expect(rotatedA.sessions).toEqual([]);
  expect(rotatedA.transactions).toEqual([]);
  expect(preservedB.approvals.map(({ id }) => id)).toEqual([activityB.approvalId]);
  expect(preservedB.sessions.map(({ id }) => id)).toEqual([activityB.sessionRecordId]);
  expect(preservedB.transactions.map(({ id }) => id)).toEqual([activityB.transactionId]);
  expect(mockedWaas.revokedCredentialIds).toEqual([activityA.credentialId]);
});

test.each([
  ['network', { chainId: 137 }],
  [
    'grants',
    {
      grants: [
        {
          kind: 'nativeTransfer' as const,
          to: recipientA as `0x${string}`,
          limit: 11n
        }
      ]
    }
  ],
  ['expiry', { expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString() }]
])('rejects an authorized session with mismatched %s', async (field, override) => {
  const token = `admin-mismatch-${field}-token-at-least-32-characters`;
  const approval = await createApproval(token, {
    recipientScope: { mode: 'specific', recipients: [recipientA] },
    allowance: '10',
    networkId: 'polygon-amoy',
    assetId: 'pol'
  });
  const sessionId = `session-mismatch-${field}`;
  mockedWaas.sessions.set(sessionId, {
    credentialId: approval.credentialId,
    session: {
      ...nativeSession(sessionId, 'authoritative-wallet', recipientA, approval.expiresAt),
      ...override
    },
    usage: [],
    listed: true,
    active: true
  });

  await requestJson(
    `/api/approvals/${encodeURIComponent(approval.approvalToken)}/approve`,
    { method: 'POST', body: { walletAddress: walletA, sessionId } },
    409
  );
  expect((await overview(token)).approvals[0]?.status).toBe('pending');
});

test('reconciles list, session fallback, usage, and revocation from WaaS', async () => {
  const token = 'admin-reconcile-token-that-is-at-least-32-characters';
  const created = await createApprovedNativeSession(token, recipientA, walletA, 'session-sync');
  const entry = mockedWaas.sessions.get(created.sessionId);
  if (!entry) throw new Error('Mock session was not created');
  await requestJson(
    `/api/approvals/${encodeURIComponent(created.approvalToken)}/approve`,
    { method: 'POST', body: { walletAddress: walletA, sessionId: created.sessionId } },
    409
  );
  entry.listed = false;
  entry.usage = [{ grant: entry.session.grants[0], used: 4n }];

  const reconciled = (await overview(token)).sessions[0];
  expect(reconciled).toMatchObject({
    status: 'usable',
    sessionId: created.sessionId,
    grants: [{ limit: '10', used: '4', remaining: '6' }]
  });

  entry.active = false;
  expect((await overview(token)).sessions[0]?.status).toBe('revoked');

  await testEnv.DB.prepare('UPDATE approval_requests SET expires_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 1_000).toISOString(), created.approvalId)
    .run();
  expect((await overview(token)).sessions[0]?.status).toBe('expired');
});

test('dismisses only inactive session records owned by the backend RAC', async () => {
  const revoked = await createNativeActivity(
    'admin-dismiss-revoked-token-at-least-32-characters',
    recipientA,
    walletA,
    'session-dismiss-revoked'
  );
  const active = await createApprovedNativeSession(
    revoked.token,
    recipientB,
    walletB,
    'session-dismiss-active'
  );
  const outsiderToken = 'admin-dismiss-outsider-token-at-least-32-characters';
  await bootstrapAdmin(outsiderToken);

  const revokedEntry = mockedWaas.sessions.get(revoked.sessionId);
  if (!revokedEntry) throw new Error('Mock session was not created');
  revokedEntry.active = false;

  await adminRequest(
    revoked.token,
    `/api/admin/sessions/${active.sessionRecordId}`,
    { method: 'DELETE' },
    409
  );
  await adminRequest(
    outsiderToken,
    `/api/admin/sessions/${revoked.sessionRecordId}`,
    { method: 'DELETE' },
    404
  );
  await adminRequest(revoked.token, `/api/admin/sessions/${revoked.sessionRecordId}`, {
    method: 'DELETE'
  });

  const remaining = await overview(revoked.token);
  expect(remaining.sessions.map(({ id }) => id)).toEqual([active.sessionRecordId]);
  expect(remaining.transactions.map(({ id }) => id)).toEqual([revoked.transactionId]);
  expect(remaining.approvals.map(({ id }) => id)).toEqual(
    expect.arrayContaining([revoked.approvalId, active.approvalId])
  );
});

test('dismisses an expired session record', async () => {
  const token = 'admin-dismiss-expired-token-at-least-32-characters';
  const expired = await createApprovedNativeSession(
    token,
    recipientA,
    walletA,
    'session-dismiss-expired'
  );
  await testEnv.DB.prepare('UPDATE approval_requests SET expires_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 1_000).toISOString(), expired.approvalId)
    .run();

  await adminRequest(token, `/api/admin/sessions/${expired.sessionRecordId}`, { method: 'DELETE' });

  expect((await overview(token)).sessions).toEqual([]);
});

test('checks per-recipient cumulative usage and uses the authoritative wallet ID', async () => {
  const token = 'admin-usage-token-that-is-at-least-32-characters';
  const created = await createApprovedUsdcSession(
    token,
    [recipientA, recipientB],
    walletA,
    'session-usage'
  );
  const entry = mockedWaas.sessions.get(created.sessionId);
  if (!entry) throw new Error('Mock session was not created');
  entry.usage = [
    { grant: entry.session.grants[0], used: 7n },
    { grant: entry.session.grants[1], used: 1n }
  ];

  await adminRequest(
    token,
    `/api/admin/sessions/${created.sessionRecordId}/transactions`,
    { method: 'POST', body: { recipient: recipientA, amount: '4' } },
    400
  );
  expect(mockedWaas.preparedTransactions).toEqual([]);

  await adminRequest<AdminTransaction>(
    token,
    `/api/admin/sessions/${created.sessionRecordId}/transactions`,
    { method: 'POST', body: { recipient: recipientB, amount: '9' } },
    201
  );
  expect(mockedWaas.preparedTransactions).toEqual([
    expect.objectContaining({
      walletId: 'authoritative-wallet',
      sessionId: created.sessionId,
      to: SMART_SESSION_ASSETS.usdc.tokenAddress
    })
  ]);
});

test('shares cumulative usage across an unrestricted ERC-20 grant', async () => {
  const token = 'admin-any-recipient-token-that-is-at-least-32-characters';
  const created = await createApprovedUsdcSession(token, 'any', walletA, 'session-any');
  const entry = mockedWaas.sessions.get(created.sessionId);
  if (!entry) throw new Error('Mock session was not created');
  entry.usage = [{ grant: entry.session.grants[0], used: 7n }];

  await adminRequest(
    token,
    `/api/admin/sessions/${created.sessionRecordId}/transactions`,
    { method: 'POST', body: { recipient: recipientB, amount: '4' } },
    400
  );
  await adminRequest(
    token,
    `/api/admin/sessions/${created.sessionRecordId}/transactions`,
    { method: 'POST', body: { recipient: recipientB, amount: '3' } },
    201
  );
});

async function createNativeActivity(
  token: string,
  recipient: string,
  walletAddress: string,
  sessionId: string
) {
  const session = await createApprovedNativeSession(token, recipient, walletAddress, sessionId);
  const transaction = await adminRequest<AdminTransaction>(
    token,
    `/api/admin/sessions/${session.sessionRecordId}/transactions`,
    { method: 'POST', body: { recipient, amount: '1' } },
    201
  );
  return { ...session, token, transactionId: transaction.id };
}

async function createApprovedNativeSession(
  token: string,
  recipient: string,
  walletAddress: string,
  sessionId: string
) {
  const approval = await createApproval(token, {
    recipientScope: { mode: 'specific', recipients: [recipient] },
    allowance: '10',
    networkId: 'polygon-amoy',
    assetId: 'pol'
  });
  mockedWaas.sessions.set(sessionId, {
    credentialId: approval.credentialId,
    session: nativeSession(sessionId, 'authoritative-wallet', recipient, approval.expiresAt),
    usage: [],
    listed: true,
    active: true
  });
  await requestJson(`/api/approvals/${encodeURIComponent(approval.approvalToken)}/approve`, {
    method: 'POST',
    body: { walletAddress, sessionId }
  });
  const approvedOverview = await overview(token);
  const sessionRecord = approvedOverview.sessions.find(
    (candidate) => candidate.sessionId === sessionId
  );
  if (!sessionRecord) throw new Error('Approved session was not returned by the overview');
  return { ...approval, sessionId, sessionRecordId: sessionRecord.id };
}

async function createApprovedUsdcSession(
  token: string,
  recipients: string[] | 'any',
  walletAddress: string,
  sessionId: string
) {
  const approval = await createApproval(token, {
    recipientScope: recipients === 'any' ? { mode: 'any' } : { mode: 'specific', recipients },
    allowance: '10',
    networkId: 'polygon',
    assetId: 'usdc'
  });
  const grants =
    recipients === 'any'
      ? [
          {
            kind: 'erc20Transfer' as const,
            token: SMART_SESSION_ASSETS.usdc.tokenAddress,
            limit: 10n,
            cumulative: true
          }
        ]
      : recipients.map((recipient) => ({
          kind: 'erc20Transfer' as const,
          token: SMART_SESSION_ASSETS.usdc.tokenAddress,
          to: recipient as `0x${string}`,
          limit: 10n,
          cumulative: true
        }));
  mockedWaas.sessions.set(sessionId, {
    credentialId: approval.credentialId,
    session: {
      sessionId,
      walletId: 'authoritative-wallet',
      signerAddress: sessionSigner,
      grants,
      chainId: 137,
      expiresAt: approval.expiresAt
    },
    usage: [],
    listed: true,
    active: true
  });
  await requestJson(`/api/approvals/${encodeURIComponent(approval.approvalToken)}/approve`, {
    method: 'POST',
    body: { walletAddress, sessionId }
  });
  const approvedOverview = await overview(token);
  const sessionRecord = approvedOverview.sessions.find(
    (candidate) => candidate.sessionId === sessionId
  );
  if (!sessionRecord) throw new Error('Approved session was not returned by the overview');
  return { ...approval, sessionId, sessionRecordId: sessionRecord.id };
}

async function createApproval(token: string, policy: Omit<CreateApprovalBody, 'expiresAt'>) {
  await bootstrapAdmin(token);
  await adminRequest(token, '/api/admin/rac', { method: 'POST' }, 201);
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const created = await adminRequest<CreatedApproval>(
    token,
    '/api/admin/approvals',
    { method: 'POST', body: { ...policy, expiresAt } },
    201
  );
  const approvalToken = new URL(created.approvalPath, origin).searchParams.get('request');
  if (!approvalToken) throw new Error('Approval response did not contain a request token');
  const request = await requestJson<ApprovalRequest>(
    `/api/approvals/${encodeURIComponent(approvalToken)}`
  );
  return {
    approvalId: created.id,
    approvalToken,
    credentialId: request.credentialId,
    expiresAt
  };
}

function nativeSession(
  sessionId: string,
  walletId: string,
  recipient: string,
  expiresAt: string
): RemoteAccessSession {
  return {
    sessionId,
    walletId,
    signerAddress: sessionSigner,
    grants: [
      {
        kind: 'nativeTransfer',
        to: recipient as `0x${string}`,
        limit: 10n
      }
    ],
    chainId: 80002,
    expiresAt
  };
}

async function bootstrapAdmin(token: string): Promise<void> {
  await requestJson('/api/admin/bootstrap', { method: 'POST', body: { token } }, 201);
}

function overview(token: string): Promise<AdminOverview> {
  return adminRequest(token, '/api/admin/overview');
}

function adminRequest<T>(
  token: string,
  pathname: string,
  options?: RequestOptions,
  expectedStatus = 200
): Promise<T> {
  return requestJson(
    pathname,
    {
      ...options,
      headers: { ...options?.headers, Authorization: `Bearer ${token}` }
    },
    expectedStatus
  );
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

async function requestJson<T = unknown>(
  pathname: string,
  options: RequestOptions = {},
  expectedStatus = 200
): Promise<T> {
  const request = new Request(`${origin}${pathname}`, {
    method: options.method,
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const response = await worker.fetch(request, testEnv as never);
  expect(response.status, await response.clone().text()).toBe(expectedStatus);
  return (await response.json()) as T;
}
