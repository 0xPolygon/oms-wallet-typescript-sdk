import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test, vi } from 'vitest';

import type {
  AdminActivityStatuses,
  AdminOverview,
  AdminTransaction,
  CreatedApproval,
  SessionRevocationResult
} from '../shared/api.js';
import { createSessionRevocationMessage } from '../shared/sessionRevocation.js';
import worker from '../worker/index.js';

const mockedWaas = vi.hoisted(() => ({
  nextTransaction: 0,
  revokedCredentialIds: [] as string[],
  verifiedRevocations: [] as Array<{
    walletAddress: string;
    chainId: number;
    message: string;
    signature: string;
  }>
}));

vi.mock('../worker/rac.js', () => ({
  RAC_LIFETIME_SECONDS: 30 * 24 * 60 * 60,
  createRacContext: async (_publishableKey: string, privateKey: string) => {
    const racSuffix = privateKey.slice(-12);
    return {
      signerId: `signer-${racSuffix}`,
      client: {
        registerCredential: async () => ({ credentialId: `credential-${racSuffix}` }),
        revokeCredential: async ({ credentialId }: { credentialId: string }) => {
          mockedWaas.revokedCredentialIds.push(credentialId);
        },
        prepareTransaction: async () => {
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

vi.mock('../worker/sessionRevocation.js', () => ({
  verifySessionRevocation: async (params: {
    walletAddress: string;
    network: { id: number };
    message: string;
    signature: string;
  }) => {
    mockedWaas.verifiedRevocations.push({
      walletAddress: params.walletAddress,
      chainId: params.network.id,
      message: params.message,
      signature: params.signature
    });
    return params.signature === `proof:${params.walletAddress.toLowerCase()}`;
  }
}));

interface TestEnv {
  DB: D1Database;
  OMS_PUBLISHABLE_KEY: string;
  TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as TestEnv;
const origin = 'https://smart-session.example';
const adminAToken = 'admin-a-token-that-is-at-least-32-characters';
const adminBToken = 'admin-b-token-that-is-at-least-32-characters';
const recipientA = '0x1000000000000000000000000000000000000001';
const recipientB = '0x2000000000000000000000000000000000000002';
const walletA = '0x3000000000000000000000000000000000000003';
const walletB = '0x4000000000000000000000000000000000000004';

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(() => {
  mockedWaas.nextTransaction = 0;
  mockedWaas.revokedCredentialIds.length = 0;
  mockedWaas.verifiedRevocations.length = 0;
});

test('rotating one backend RAC removes only its activity', async () => {
  await bootstrapAdmin(adminAToken);
  await bootstrapAdmin(adminBToken);
  await adminRequest(adminAToken, '/api/admin/rac', { method: 'POST' }, 201);
  await adminRequest(adminBToken, '/api/admin/rac', { method: 'POST' }, 201);

  const activityA = await createActivity({
    token: adminAToken,
    recipient: recipientA,
    walletAddress: walletA,
    walletId: 'wallet-a',
    sessionId: 'session-a'
  });
  const activityB = await createActivity({
    token: adminBToken,
    recipient: recipientB,
    walletAddress: walletB,
    walletId: 'wallet-b',
    sessionId: 'session-b'
  });

  expect(activityA.overview.approvals.map(({ id }) => id)).toEqual([activityA.approvalId]);
  expect(activityA.overview.sessions.map(({ id }) => id)).toEqual([activityA.sessionRecordId]);
  expect(activityA.overview.transactions.map(({ id }) => id)).toEqual([activityA.transactionId]);
  expect(activityB.overview.approvals.map(({ id }) => id)).toEqual([activityB.approvalId]);
  expect(activityB.overview.sessions.map(({ id }) => id)).toEqual([activityB.sessionRecordId]);
  expect(activityB.overview.transactions.map(({ id }) => id)).toEqual([activityB.transactionId]);

  await adminRequest(
    adminAToken,
    `/api/admin/approvals/${activityB.approvalId}/link`,
    { method: 'POST' },
    404
  );
  await adminRequest(
    adminAToken,
    `/api/admin/sessions/${activityB.sessionRecordId}/transactions`,
    { method: 'POST', body: { recipient: recipientB, amount: '1' } },
    404
  );
  await adminRequest(
    adminAToken,
    `/api/admin/transactions/${activityB.transactionId}`,
    undefined,
    404
  );

  await adminRequest(adminAToken, '/api/admin/rac/rotate', { method: 'POST' });

  const rotatedA = await overview(adminAToken);
  const preservedB = await overview(adminBToken);
  expect(rotatedA.credential.id).not.toBe(activityA.overview.credential.id);
  expect(rotatedA.approvals).toEqual([]);
  expect(rotatedA.sessions).toEqual([]);
  expect(rotatedA.transactions).toEqual([]);
  expect(preservedB).toEqual(activityB.overview);
  expect(mockedWaas.revokedCredentialIds).toEqual([activityA.overview.credential.id]);
});

async function bootstrapAdmin(token: string): Promise<void> {
  await requestJson('/api/admin/bootstrap', { method: 'POST', body: { token } }, 201);
}

async function createActivity(params: {
  token: string;
  recipient: string;
  walletAddress: string;
  walletId: string;
  sessionId: string;
}): Promise<{
  approvalId: string;
  sessionRecordId: string;
  transactionId: string;
  overview: AdminOverview;
}> {
  const approvalExpiry = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  const sessionExpiry = new Date(Date.now() + 30 * 60 * 1_000).toISOString();
  const approval = await adminRequest<CreatedApproval>(
    params.token,
    '/api/admin/approvals',
    {
      method: 'POST',
      body: {
        recipientScope: { mode: 'specific', recipients: [params.recipient] },
        allowance: '10',
        expiresAt: approvalExpiry,
        networkId: 'polygon-amoy',
        assetId: 'pol'
      }
    },
    201
  );
  const approvalToken = new URL(approval.approvalPath, origin).searchParams.get('request');
  if (!approvalToken) throw new Error('Approval response did not contain a request token');

  const initialOverview = await overview(params.token);
  await requestJson(`/api/approvals/${encodeURIComponent(approvalToken)}/approve`, {
    method: 'POST',
    body: {
      credentialId: initialOverview.credential.id,
      walletId: params.walletId,
      walletAddress: params.walletAddress,
      sessionId: params.sessionId,
      expiresAt: sessionExpiry
    }
  });

  const activityStatuses = await adminRequest<AdminActivityStatuses>(
    params.token,
    '/api/admin/activity-statuses'
  );
  const session = activityStatuses.sessions[0];
  if (!session) throw new Error('Approved smart session was not returned by the admin status API');
  const transaction = await adminRequest<AdminTransaction>(
    params.token,
    `/api/admin/sessions/${session.id}/transactions`,
    { method: 'POST', body: { recipient: params.recipient, amount: '1' } },
    201
  );
  await requestJson(
    '/api/session-revocations',
    {
      method: 'POST',
      body: {
        credentialId: initialOverview.credential.id,
        sessionId: params.sessionId,
        signature: 'invalid-proof'
      }
    },
    403
  );
  const activeStatus = await adminRequest<AdminActivityStatuses>(
    params.token,
    '/api/admin/activity-statuses'
  );
  expect(activeStatus.sessions.find(({ id }) => id === session.id)?.status).toBe('usable');
  await requestJson(
    '/api/session-revocations',
    {
      method: 'POST',
      body: {
        credentialId: 'credential-from-another-rac',
        sessionId: params.sessionId,
        signature: `proof:${params.walletAddress.toLowerCase()}`
      }
    },
    404
  );
  const revocation = await requestJson<SessionRevocationResult>('/api/session-revocations', {
    method: 'POST',
    body: {
      credentialId: initialOverview.credential.id,
      sessionId: params.sessionId,
      signature: `proof:${params.walletAddress.toLowerCase()}`
    }
  });
  expect(revocation.recorded).toBe(true);
  expect(mockedWaas.verifiedRevocations.at(-1)).toEqual({
    walletAddress: params.walletAddress,
    chainId: 80002,
    message: createSessionRevocationMessage({
      origin,
      credentialId: initialOverview.credential.id,
      sessionId: params.sessionId,
      walletAddress: params.walletAddress,
      chainId: 80002
    }),
    signature: `proof:${params.walletAddress.toLowerCase()}`
  });
  const replay = await requestJson<SessionRevocationResult>('/api/session-revocations', {
    method: 'POST',
    body: {
      credentialId: initialOverview.credential.id,
      sessionId: params.sessionId,
      signature: `proof:${params.walletAddress.toLowerCase()}`
    }
  });
  expect(replay.recorded).toBe(false);

  return {
    approvalId: approval.id,
    sessionRecordId: session.id,
    transactionId: transaction.id,
    overview: await overview(params.token)
  };
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
