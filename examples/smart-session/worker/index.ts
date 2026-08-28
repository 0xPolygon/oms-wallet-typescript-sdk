import {
  OMSWallet,
  TransactionStatus,
  feeOptionSelection,
  isOMSWalletError
} from '@polygonlabs/oms-wallet';
import { encodeFunctionData, isAddress } from 'viem';
import { generatePrivateKey } from 'viem/accounts';

import type {
  AdminActivityStatuses,
  AdminApproval,
  AdminOverview,
  AdminSmartSession,
  AdminTransaction,
  ApiError,
  ApprovalRequest,
  ApprovalStatus,
  ApproveRequestBody,
  ClientConfig,
  CreateApprovalBody,
  CreateTransactionBody,
  CreatedApproval,
  RecipientScope,
  RevokeSessionBody,
  SessionRevocationResult
} from '../shared/api.js';
import type { SmartSessionAssetId, SmartSessionNetworkId } from '../shared/networks.js';
import {
  getSmartSessionAsset,
  getSmartSessionNetwork,
  isSmartSessionAssetId,
  isSmartSessionNetworkId
} from '../shared/networks.js';
import {
  requireAllowedTransactionRecipient,
  validateRecipientScope
} from '../shared/permissions.js';
import { createSessionRevocationMessage } from '../shared/sessionRevocation.js';
import { serializeWaasError } from './errors.js';
import { createRacContext, RAC_LIFETIME_SECONDS, type RacContext } from './rac.js';
import { verifySessionRevocation } from './sessionRevocation.js';

const erc20TransferAbi = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  }
] as const;

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  OMS_PUBLISHABLE_KEY: string;
}

interface CredentialRow {
  signer_id: string;
  credential_id: string;
  registered_at: string;
  expires_at: string;
}

interface AdminContext {
  racId: string;
}

interface ApprovalRow {
  id: string;
  rac_id: string;
  credential_id: string;
  network_id: SmartSessionNetworkId;
  asset_id: SmartSessionAssetId;
  recipient_mode: RecipientScope['mode'];
  recipients: string;
  allowance: string;
  expires_at: string;
  status: 'pending' | 'approved';
  wallet_id: string | null;
  wallet_address: string | null;
  session_id: string | null;
  created_at: string;
  approved_at: string | null;
  rejected_at: string | null;
}

interface SessionRow {
  id: string;
  rac_id: string;
  wallet_id: string;
  wallet_address: string;
  session_id: string;
  credential_id: string;
  network_id: SmartSessionNetworkId;
  asset_id: SmartSessionAssetId;
  recipient_mode: RecipientScope['mode'];
  recipients: string;
  allowance: string;
  expires_at: string;
  created_at: string;
  status: 'active' | 'revoked';
  revoked_at: string | null;
}

interface TransactionRow {
  id: string;
  smart_session_id: string;
  wallet_address: string;
  txn_id: string;
  recipient: string;
  amount: string;
  network_id: SmartSessionNetworkId;
  asset_id: SmartSessionAssetId;
  status: string;
  txn_hash: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: ApiError['details']
  ) {
    super(message);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname === '/') {
        return env.ASSETS.fetch(request);
      }
      if (url.pathname === '/health') {
        return json({ ok: true });
      }
      if (!url.pathname.startsWith('/api/')) {
        return env.ASSETS.fetch(request);
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/bootstrap') {
        await bootstrapAdmin(env, await readJson<{ token: string }>(request));
        return json({ ok: true }, 201);
      }

      if (request.method === 'GET' && url.pathname === '/api/client-config') {
        requireConfiguration(env);
        return json({ publishableKey: env.OMS_PUBLISHABLE_KEY } satisfies ClientConfig);
      }

      const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
      if (request.method === 'GET' && approvalMatch) {
        return json(await getApproval(env, approvalMatch[1], url.origin));
      }

      const approveMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
      if (request.method === 'POST' && approveMatch) {
        await approveRequest(
          env,
          approveMatch[1],
          await readJson<ApproveRequestBody>(request),
          url.origin
        );
        return json({ ok: true });
      }

      const rejectMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/reject$/);
      if (request.method === 'POST' && rejectMatch) {
        await rejectRequest(env, rejectMatch[1], url.origin);
        return json({ ok: true });
      }

      if (request.method === 'POST' && url.pathname === '/api/session-revocations') {
        return json(
          await recordSessionRevocation(env, await readJson<RevokeSessionBody>(request), url.origin)
        );
      }

      if (url.pathname.startsWith('/api/admin/')) {
        const admin = await requireAdmin(request, env);
        if (request.method === 'GET' && url.pathname === '/api/admin/overview') {
          return json(await getAdminOverview(env, admin.racId, url.origin));
        }
        if (request.method === 'GET' && url.pathname === '/api/admin/activity-statuses') {
          return json(await getAdminActivityStatuses(env, admin.racId, url.origin));
        }
        if (request.method === 'POST' && url.pathname === '/api/admin/rac') {
          await generateBackendRac(env, admin.racId);
          return json({ ok: true }, 201);
        }
        if (request.method === 'POST' && url.pathname === '/api/admin/rac/rotate') {
          await rotateBackendRac(env, admin.racId, url.origin);
          return json({ ok: true });
        }
        if (request.method === 'POST' && url.pathname === '/api/admin/approvals') {
          return json(
            await createApproval(
              env,
              admin.racId,
              url,
              await readJson<CreateApprovalBody>(request)
            ),
            201
          );
        }

        const approvalLinkMatch = url.pathname.match(/^\/api\/admin\/approvals\/([^/]+)\/link$/);
        if (request.method === 'POST' && approvalLinkMatch) {
          return json(await getApprovalLink(env, admin.racId, approvalLinkMatch[1], url.origin));
        }

        const transactionMatch = url.pathname.match(
          /^\/api\/admin\/sessions\/([^/]+)\/transactions$/
        );
        if (request.method === 'POST' && transactionMatch) {
          return json(
            await createTransaction(
              env,
              admin.racId,
              transactionMatch[1],
              await readJson<CreateTransactionBody>(request),
              url.origin
            ),
            201
          );
        }

        const statusMatch = url.pathname.match(/^\/api\/admin\/transactions\/([^/]+)$/);
        if (request.method === 'GET' && statusMatch) {
          return json(await refreshTransaction(env, admin.racId, statusMatch[1], url.origin));
        }
      }

      throw new HttpError(404, 'Not found');
    } catch (error) {
      if (error instanceof HttpError) {
        return json(
          {
            error: error.message,
            ...(error.details === undefined ? {} : { details: error.details })
          } satisfies ApiError,
          error.status
        );
      }
      console.error(error);
      return json({ error: 'Internal server error' }, 500);
    }
  }
} satisfies ExportedHandler<Env>;

async function getApproval(env: Env, token: string, origin: string): Promise<ApprovalRequest> {
  const row = await env.DB.prepare(
    `SELECT id, rac_id, credential_id, network_id, asset_id, recipient_mode, recipients, allowance, expires_at,
      status, wallet_id, wallet_address, session_id, created_at, approved_at, rejected_at
     FROM approval_requests WHERE token_hash = ?`
  )
    .bind(await sha256(token))
    .first<ApprovalRow>();

  if (!row) throw new HttpError(404, 'Approval request not found');
  if (approvalStatus(row) === 'pending' && Date.parse(row.expires_at) <= Date.now()) {
    throw new HttpError(410, 'Approval request has expired');
  }
  const credential = await requireCredential(env, row.rac_id, origin);
  if (row.credential_id !== credential.credential_id) {
    throw new HttpError(409, 'This approval request belongs to a previous backend RAC');
  }

  return {
    id: row.id,
    recipientScope: recipientScopeFromRow(row),
    allowance: row.allowance,
    expiresAt: row.expires_at,
    status: approvalStatus(row),
    credentialId: credential.credential_id,
    publishableKey: env.OMS_PUBLISHABLE_KEY,
    networkId: row.network_id,
    assetId: row.asset_id
  };
}

async function createApproval(
  env: Env,
  racId: string,
  requestUrl: URL,
  body: CreateApprovalBody
): Promise<CreatedApproval> {
  const { network, asset } = requireSmartSessionConfig(body.networkId, body.assetId);
  const recipientScope = requireRecipientScope(body.recipientScope, asset.kind);
  const allowance = positiveBigInt(body.allowance, 'allowance');
  const expiresAt = validFutureDate(body.expiresAt, 'expiresAt');
  const credential = await requireCredential(env, racId, requestUrl.origin);
  if (expiresAt.getTime() > Date.parse(credential.expires_at)) {
    throw new HttpError(400, 'Approval expiry cannot exceed the RAC expiry');
  }

  const id = crypto.randomUUID();
  const token = randomToken();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO approval_requests
      (id, rac_id, token, token_hash, credential_id, network_id, asset_id, recipient_mode,
       recipients, allowance,
       expires_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(
      id,
      racId,
      token,
      await sha256(token),
      credential.credential_id,
      network.id,
      asset.id,
      recipientScope.mode,
      JSON.stringify(recipientScope.mode === 'specific' ? recipientScope.recipients : []),
      allowance.toString(),
      expiresAt.toISOString(),
      now
    )
    .run();

  return {
    id,
    approvalPath: `/?request=${encodeURIComponent(token)}`,
    expiresAt: expiresAt.toISOString()
  };
}

async function getApprovalLink(
  env: Env,
  racId: string,
  id: string,
  origin: string
): Promise<CreatedApproval> {
  const approval = await env.DB.prepare(
    `SELECT id, token, credential_id, expires_at, status, rejected_at
     FROM approval_requests WHERE id = ? AND rac_id = ?`
  )
    .bind(id, racId)
    .first<{
      id: string;
      token: string;
      credential_id: string;
      expires_at: string;
      status: 'pending' | 'approved';
      rejected_at: string | null;
    }>();
  if (!approval) throw new HttpError(404, 'Approval request not found');
  if (approval.status !== 'pending' || approval.rejected_at) {
    throw new HttpError(409, 'Approval request was already used');
  }
  if (Date.parse(approval.expires_at) <= Date.now()) {
    throw new HttpError(410, 'Approval request has expired');
  }
  const credential = await requireCredential(env, racId, origin);
  if (approval.credential_id !== credential.credential_id) {
    throw new HttpError(409, 'This approval request belongs to a previous backend RAC');
  }

  return {
    id: approval.id,
    approvalPath: `/?request=${encodeURIComponent(approval.token)}`,
    expiresAt: approval.expires_at
  };
}

async function approveRequest(
  env: Env,
  token: string,
  body: ApproveRequestBody,
  origin: string
): Promise<void> {
  if (!body.walletId?.trim()) throw new HttpError(400, 'walletId is required');
  if (!body.sessionId?.trim()) throw new HttpError(400, 'sessionId is required');
  if (!isAddress(body.walletAddress)) throw new HttpError(400, 'walletAddress is invalid');
  const effectiveExpiry = validFutureDate(body.expiresAt, 'expiresAt');
  const approval = await env.DB.prepare(
    `SELECT id, rac_id, credential_id, network_id, asset_id, recipient_mode, recipients, allowance, expires_at,
      status, wallet_id, wallet_address, session_id, created_at, approved_at, rejected_at
     FROM approval_requests WHERE token_hash = ?`
  )
    .bind(await sha256(token))
    .first<ApprovalRow>();

  if (!approval) throw new HttpError(404, 'Approval request not found');
  if (approval.status !== 'pending' || approval.rejected_at) {
    throw new HttpError(409, 'Approval request was already used');
  }
  if (Date.parse(approval.expires_at) <= Date.now()) {
    throw new HttpError(410, 'Approval request has expired');
  }
  if (effectiveExpiry.getTime() > Date.parse(approval.expires_at)) {
    throw new HttpError(400, 'Authorized expiry exceeds the requested expiry');
  }
  const credential = await requireCredential(env, approval.rac_id, origin);
  if (
    body.credentialId !== credential.credential_id ||
    approval.credential_id !== credential.credential_id
  ) {
    throw new HttpError(409, 'The backend RAC changed; reload and approve a new request');
  }

  const now = new Date().toISOString();
  const sessionRecordId = crypto.randomUUID();
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE approval_requests
         SET status = 'approved', wallet_id = ?, wallet_address = ?, session_id = ?, approved_at = ?
         WHERE id = ? AND rac_id = ? AND status = 'pending' AND rejected_at IS NULL`
      ).bind(body.walletId, body.walletAddress, body.sessionId, now, approval.id, approval.rac_id),
      env.DB.prepare(
        `INSERT INTO smart_sessions
          (id, rac_id, approval_id, wallet_id, wallet_address, session_id, credential_id,
           network_id, asset_id, recipient_mode, recipients, allowance, expires_at, created_at)
         SELECT ?, rac_id, id, ?, ?, ?, ?, network_id, asset_id, recipient_mode, recipients,
           allowance, ?, ?
         FROM approval_requests WHERE id = ? AND rac_id = ? AND status = 'approved'`
      ).bind(
        sessionRecordId,
        body.walletId,
        body.walletAddress,
        body.sessionId,
        credential.credential_id,
        effectiveExpiry.toISOString(),
        now,
        approval.id,
        approval.rac_id
      )
    ]);
    if (results.some((result) => result.meta.changes !== 1)) {
      throw new HttpError(409, 'Approval request was already completed');
    }
  } catch {
    throw new HttpError(409, 'Approval request was already completed');
  }
}

async function rejectRequest(env: Env, token: string, origin: string): Promise<void> {
  const approval = await env.DB.prepare(
    `SELECT id, rac_id, credential_id, expires_at, status, rejected_at
     FROM approval_requests WHERE token_hash = ?`
  )
    .bind(await sha256(token))
    .first<
      Pick<ApprovalRow, 'id' | 'rac_id' | 'credential_id' | 'expires_at' | 'status' | 'rejected_at'>
    >();

  if (!approval) throw new HttpError(404, 'Approval request not found');
  if (approval.status !== 'pending' || approval.rejected_at) {
    throw new HttpError(409, 'Approval request was already used');
  }
  if (Date.parse(approval.expires_at) <= Date.now()) {
    throw new HttpError(410, 'Approval request has expired');
  }
  const credential = await requireCredential(env, approval.rac_id, origin);
  if (approval.credential_id !== credential.credential_id) {
    throw new HttpError(409, 'This approval request belongs to a previous backend RAC');
  }

  const result = await env.DB.prepare(
    `UPDATE approval_requests SET rejected_at = ?
     WHERE id = ? AND rac_id = ? AND status = 'pending' AND rejected_at IS NULL`
  )
    .bind(new Date().toISOString(), approval.id, approval.rac_id)
    .run();
  if (result.meta.changes !== 1) {
    throw new HttpError(409, 'Approval request was already completed');
  }
}

async function recordSessionRevocation(
  env: Env,
  body: RevokeSessionBody,
  origin: string
): Promise<SessionRevocationResult> {
  if (!body.credentialId?.trim()) throw new HttpError(400, 'credentialId is required');
  if (!body.sessionId?.trim()) throw new HttpError(400, 'sessionId is required');
  if (!body.signature?.trim()) throw new HttpError(400, 'signature is required');

  const session = await env.DB.prepare(
    `SELECT id, wallet_address, network_id
     FROM smart_sessions
     WHERE credential_id = ? AND session_id = ?`
  )
    .bind(body.credentialId, body.sessionId)
    .first<Pick<SessionRow, 'id' | 'wallet_address' | 'network_id'>>();
  if (!session) throw new HttpError(404, 'Smart session not found');
  if (!isAddress(session.wallet_address)) {
    throw new HttpError(500, 'Smart session contains an invalid wallet address');
  }

  const network = getSmartSessionNetwork(session.network_id).network;
  const message = createSessionRevocationMessage({
    origin,
    credentialId: body.credentialId,
    sessionId: body.sessionId,
    walletAddress: session.wallet_address,
    chainId: network.id
  });
  let isValid: boolean;
  try {
    isValid = await verifySessionRevocation({
      publishableKey: env.OMS_PUBLISHABLE_KEY,
      network,
      walletAddress: session.wallet_address,
      message,
      signature: body.signature
    });
  } catch (error) {
    throw waasError('Unable to verify the session revocation', error);
  }
  if (!isValid) throw new HttpError(403, 'Invalid session revocation signature');

  const result = await env.DB.prepare(
    `UPDATE smart_sessions SET status = 'revoked', revoked_at = ?
     WHERE id = ? AND status = 'active'`
  )
    .bind(new Date().toISOString(), session.id)
    .run();

  return { recorded: result.meta.changes > 0 };
}

async function getAdminOverview(env: Env, racId: string, origin: string): Promise<AdminOverview> {
  const credential = await requireCredential(env, racId, origin);
  const [approvalResult, sessionResult, transactionResult] = await Promise.all([
    env.DB.prepare(
      `SELECT id, rac_id, credential_id, network_id, asset_id, recipient_mode, recipients,
        allowance, expires_at,
        status, wallet_id, wallet_address, session_id, created_at, approved_at, rejected_at
       FROM approval_requests WHERE rac_id = ? ORDER BY created_at DESC LIMIT 50`
    )
      .bind(racId)
      .all<ApprovalRow>(),
    env.DB.prepare(
      `SELECT id, rac_id, wallet_id, wallet_address, session_id, credential_id, recipient_mode,
        recipients, network_id, asset_id, allowance, expires_at, created_at, status, revoked_at
       FROM smart_sessions
       WHERE rac_id = ? AND credential_id = ?
       ORDER BY created_at DESC LIMIT 50`
    )
      .bind(racId, credential.credential_id)
      .all<SessionRow>(),
    env.DB.prepare(
      `SELECT transactions.id, transactions.smart_session_id, smart_sessions.wallet_address,
        smart_sessions.network_id, smart_sessions.asset_id, transactions.txn_id,
        transactions.recipient, transactions.amount, transactions.status, transactions.txn_hash,
        transactions.error,
        transactions.created_at, transactions.updated_at
       FROM transactions
       JOIN smart_sessions ON smart_sessions.id = transactions.smart_session_id
       WHERE smart_sessions.rac_id = ?
       ORDER BY transactions.created_at DESC LIMIT 50`
    )
      .bind(racId)
      .all<TransactionRow>()
  ]);
  const sessionBalances = await getSessionBalances(
    env,
    sessionResult.results.filter((session) => sessionStatus(session) === 'usable')
  );

  return {
    credential: {
      id: credential.credential_id,
      expiresAt: credential.expires_at
    },
    approvals: approvalResult.results.map(toAdminApproval),
    sessions: sessionResult.results.map((row) => ({
      ...toAdminSession(row),
      balance: sessionBalances.get(row.id)
    })),
    transactions: transactionResult.results.map(toAdminTransaction)
  };
}

async function getAdminActivityStatuses(
  env: Env,
  racId: string,
  origin: string
): Promise<AdminActivityStatuses> {
  const credential = await requireCredential(env, racId, origin);
  const [approvalResult, sessionResult] = await Promise.all([
    env.DB.prepare(
      `SELECT id, status, approved_at, rejected_at
       FROM approval_requests WHERE rac_id = ? ORDER BY created_at DESC LIMIT 50`
    )
      .bind(racId)
      .all<Pick<ApprovalRow, 'id' | 'status' | 'approved_at' | 'rejected_at'>>(),
    env.DB.prepare(
      `SELECT id, expires_at, status, revoked_at
       FROM smart_sessions WHERE rac_id = ? AND credential_id = ? ORDER BY created_at DESC LIMIT 50`
    )
      .bind(racId, credential.credential_id)
      .all<Pick<SessionRow, 'id' | 'expires_at' | 'status' | 'revoked_at'>>()
  ]);

  return {
    approvals: approvalResult.results.map((row) => ({
      id: row.id,
      status: approvalStatus(row),
      approvedAt: row.approved_at ?? undefined,
      rejectedAt: row.rejected_at ?? undefined
    })),
    sessions: sessionResult.results.map((row) => ({
      id: row.id,
      status: sessionStatus(row),
      revokedAt: row.revoked_at ?? undefined
    }))
  };
}

async function getSessionBalances(
  env: Env,
  sessions: SessionRow[]
): Promise<Map<string, string | undefined>> {
  if (sessions.length === 0) return new Map();

  const groups = new Map<
    string,
    { walletAddress: string; networkId: SmartSessionNetworkId; sessions: SessionRow[] }
  >();
  for (const session of sessions) {
    const key = `${session.wallet_address.toLowerCase()}:${session.network_id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.sessions.push(session);
    } else {
      groups.set(key, {
        walletAddress: session.wallet_address,
        networkId: session.network_id,
        sessions: [session]
      });
    }
  }

  const indexer = new OMSWallet({ publishableKey: env.OMS_PUBLISHABLE_KEY }).indexer;
  const balances = new Map<string, string | undefined>();
  await Promise.all(
    Array.from(groups.values(), async (group) => {
      const network = getSmartSessionNetwork(group.networkId);
      const tokenAddresses = Array.from(
        new Set(
          group.sessions.flatMap((session) => {
            const asset = getSmartSessionAsset(session.network_id, session.asset_id);
            return asset.kind === 'erc20' ? [asset.tokenAddress] : [];
          })
        )
      );
      try {
        const result = await indexer.getBalances({
          walletAddress: group.walletAddress,
          networks: [network.network],
          contractAddresses: tokenAddresses.length ? tokenAddresses : undefined,
          includeMetadata: false
        });
        for (const session of group.sessions) {
          const asset = getSmartSessionAsset(session.network_id, session.asset_id);
          const balance =
            asset.kind === 'native'
              ? result.nativeBalances.find((candidate) => candidate.chainId === network.network.id)
                  ?.balance
              : result.balances.find(
                  (candidate) =>
                    candidate.chainId === network.network.id &&
                    candidate.contractAddress.toLowerCase() === asset.tokenAddress.toLowerCase()
                )?.balance;
          balances.set(session.id, balance ?? '0');
        }
      } catch {
        for (const session of group.sessions) balances.set(session.id, undefined);
      }
    })
  );
  return balances;
}

async function createTransaction(
  env: Env,
  racId: string,
  sessionRecordId: string,
  body: CreateTransactionBody,
  origin: string
): Promise<AdminTransaction> {
  const amount = positiveBigInt(body.amount, 'amount');
  const session = await env.DB.prepare(
    `SELECT id, rac_id, wallet_id, wallet_address, session_id, credential_id, recipient_mode,
      recipients, network_id, asset_id, allowance, expires_at, created_at, status, revoked_at
     FROM smart_sessions WHERE id = ? AND rac_id = ?`
  )
    .bind(sessionRecordId, racId)
    .first<SessionRow>();
  if (!session) throw new HttpError(404, 'Smart session not found');
  if (session.status === 'revoked') {
    throw new HttpError(410, 'Smart session has been revoked');
  }
  if (Date.parse(session.expires_at) <= Date.now()) {
    throw new HttpError(410, 'Smart session has expired');
  }
  if (amount > BigInt(session.allowance)) {
    throw new HttpError(400, 'Amount exceeds the session allowance');
  }

  const { network, asset } = requireSmartSessionConfig(session.network_id, session.asset_id);
  const recipientScope = recipientScopeFromRow(session);
  let recipient: `0x${string}`;
  try {
    recipient = requireAllowedTransactionRecipient(recipientScope, body.recipient);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Recipient is invalid');
  }

  const credential = await requireCredential(env, racId, origin);
  if (session.credential_id !== credential.credential_id) {
    throw new HttpError(409, 'This session belongs to a different backend RAC');
  }

  const rac = await createRac(env, racId);
  try {
    const prepared = await rac.client.prepareTransaction(
      asset.kind === 'native'
        ? {
            walletId: session.wallet_id,
            sessionId: session.session_id,
            network: network.network,
            to: recipient,
            value: amount
          }
        : {
            walletId: session.wallet_id,
            sessionId: session.session_id,
            network: network.network,
            to: asset.tokenAddress,
            data: encodeFunctionData({
              abi: erc20TransferAbi,
              functionName: 'transfer',
              args: [recipient, amount]
            })
          }
    );
    const feeOption = prepared.sponsored
      ? undefined
      : prepared.feeOptions[0]
        ? feeOptionSelection(prepared.feeOptions[0], 0)
        : undefined;
    if (!prepared.sponsored && !feeOption) {
      throw new HttpError(502, 'WaaS did not return a usable fee option');
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO transactions
        (id, smart_session_id, txn_id, recipient, amount, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, session.id, prepared.txnId, recipient, amount.toString(), prepared.status, now, now)
      .run();

    try {
      const executed = await rac.client.executeTransaction({
        txnId: prepared.txnId,
        feeOption
      });
      let status = executed.status;
      let txnHash: string | undefined;
      const current = await rac.client
        .getTransactionStatus({ txnId: prepared.txnId })
        .catch(() => undefined);
      if (current) {
        status = current.status;
        txnHash = current.txnHash;
      }
      const updatedAt = new Date().toISOString();
      await env.DB.prepare(
        'UPDATE transactions SET status = ?, txn_hash = ?, updated_at = ? WHERE id = ?'
      )
        .bind(status, txnHash ?? null, updatedAt, id)
        .run();
      return {
        id,
        smartSessionId: session.id,
        walletAddress: session.wallet_address,
        txnId: prepared.txnId,
        recipient,
        amount: amount.toString(),
        networkId: session.network_id,
        assetId: session.asset_id,
        status,
        txnHash,
        createdAt: now,
        updatedAt
      };
    } catch (error) {
      const detail = isOMSWalletError(error) ? error.message : 'Execute request failed';
      await env.DB.prepare('UPDATE transactions SET error = ?, updated_at = ? WHERE id = ?')
        .bind(detail, new Date().toISOString(), id)
        .run();
      throw waasError('WaaS transaction execution was not confirmed', error);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw waasError('WaaS rejected the smart-session transaction', error);
  }
}

async function refreshTransaction(
  env: Env,
  racId: string,
  id: string,
  origin: string
): Promise<AdminTransaction> {
  const row = await env.DB.prepare(
    `SELECT transactions.id, transactions.smart_session_id, smart_sessions.wallet_address,
      smart_sessions.network_id, smart_sessions.asset_id, transactions.txn_id,
      transactions.recipient, transactions.amount, transactions.status, transactions.txn_hash,
      transactions.error,
      transactions.created_at, transactions.updated_at
     FROM transactions
     JOIN smart_sessions ON smart_sessions.id = transactions.smart_session_id
     WHERE transactions.id = ? AND smart_sessions.rac_id = ?`
  )
    .bind(id, racId)
    .first<TransactionRow>();
  if (!row) throw new HttpError(404, 'Transaction not found');
  if (
    row.status === TransactionStatus.Failed ||
    (row.status === TransactionStatus.Executed && row.txn_hash)
  ) {
    return toAdminTransaction(row);
  }

  try {
    await requireCredential(env, racId, origin);
    const status = await (
      await createRac(env, racId)
    ).client.getTransactionStatus({
      txnId: row.txn_id
    });
    const updatedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE transactions SET status = ?, txn_hash = ?, error = NULL, updated_at = ? WHERE id = ?`
    )
      .bind(status.status, status.txnHash ?? null, updatedAt, id)
      .run();
    return {
      ...toAdminTransaction(row),
      status: status.status,
      txnHash: status.txnHash,
      error: undefined,
      updatedAt
    };
  } catch (error) {
    throw waasError('WaaS transaction status lookup failed', error);
  }
}

async function requireCredential(env: Env, racId: string, origin: string): Promise<CredentialRow> {
  requireConfiguration(env);
  const rac = await createRac(env, racId);
  const existing = await env.DB.prepare(
    `SELECT signer_id, credential_id, registered_at, expires_at
     FROM backend_racs WHERE id = ?`
  )
    .bind(racId)
    .first<Partial<CredentialRow>>();

  if (
    existing?.signer_id === rac.signerId &&
    existing.credential_id &&
    existing.registered_at &&
    existing.expires_at &&
    Date.parse(existing.expires_at) > Date.now()
  ) {
    return existing as CredentialRow;
  }

  try {
    const registered = await rac.client.registerCredential({
      lifetimeSeconds: RAC_LIFETIME_SECONDS,
      metadata: {
        appName: 'OMS Smart Session Admin',
        appUrl: `${origin}/dashboard/`,
        appLogoUrl: '',
        custom: { networks: 'polygon-amoy,polygon' }
      }
    });
    const registeredAt = new Date();
    const row: CredentialRow = {
      signer_id: rac.signerId,
      credential_id: registered.credentialId,
      registered_at: registeredAt.toISOString(),
      expires_at: new Date(registeredAt.getTime() + RAC_LIFETIME_SECONDS * 1000).toISOString()
    };
    await env.DB.prepare(
      `UPDATE backend_racs
       SET signer_id = ?, credential_id = ?, registered_at = ?, expires_at = ?
       WHERE id = ?`
    )
      .bind(row.signer_id, row.credential_id, row.registered_at, row.expires_at, racId)
      .run();
    return row;
  } catch (error) {
    throw waasError('Unable to register the backend RAC', error);
  }
}

async function createRac(env: Env, racId: string): Promise<RacContext> {
  requireConfiguration(env);
  const row = await env.DB.prepare('SELECT private_key FROM backend_racs WHERE id = ?')
    .bind(racId)
    .first<{ private_key: string | null }>();
  if (!row?.private_key) {
    throw new HttpError(409, 'Generate a backend RAC from the admin dashboard first');
  }
  return createRacContext(env.OMS_PUBLISHABLE_KEY, row.private_key, env.DB);
}

async function generateBackendRac(env: Env, racId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE backend_racs SET private_key = COALESCE(private_key, ?) WHERE id = ?`
  )
    .bind(generatePrivateKey(), racId)
    .run();
}

async function rotateBackendRac(env: Env, racId: string, origin: string): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT signer_id, credential_id, registered_at, expires_at
     FROM backend_racs WHERE id = ?`
  )
    .bind(racId)
    .first<Partial<CredentialRow>>();
  if (
    existing?.credential_id &&
    existing.expires_at &&
    Date.parse(existing.expires_at) > Date.now()
  ) {
    const rac = await createRac(env, racId);
    if (existing.signer_id === rac.signerId) {
      try {
        await rac.client.revokeCredential({ credentialId: existing.credential_id });
      } catch (error) {
        throw waasError('Unable to revoke the current backend RAC', error);
      }
    }
  }

  const statements = [
    env.DB.prepare(
      `DELETE FROM transactions
       WHERE smart_session_id IN (SELECT id FROM smart_sessions WHERE rac_id = ?)`
    ).bind(racId),
    env.DB.prepare('DELETE FROM smart_sessions WHERE rac_id = ?').bind(racId),
    env.DB.prepare('DELETE FROM approval_requests WHERE rac_id = ?').bind(racId),
    env.DB.prepare(
      `UPDATE backend_racs
       SET private_key = ?, signer_id = NULL, credential_id = NULL, registered_at = NULL,
         expires_at = NULL
       WHERE id = ?`
    ).bind(generatePrivateKey(), racId)
  ];
  if (existing?.signer_id) {
    statements.push(
      env.DB.prepare('DELETE FROM rac_nonces WHERE signer_id = ?').bind(existing.signer_id)
    );
  }
  await env.DB.batch(statements);
  await requireCredential(env, racId, origin);
}

async function bootstrapAdmin(env: Env, body: { token: string }): Promise<void> {
  const token = body.token?.trim();
  if (!token || token.length < 32) {
    throw new HttpError(400, 'Admin token must contain at least 32 characters');
  }

  const tokenHash = await sha256(token);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO backend_racs (id, token_hash, created_at)
     VALUES (?, ?, ?)`
  )
    .bind(crypto.randomUUID(), tokenHash, new Date().toISOString())
    .run();
}

async function requireAdmin(request: Request, env: Env): Promise<AdminContext> {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Admin authorization required');
  }
  const token = authorization.slice('Bearer '.length);
  const stored = await env.DB.prepare('SELECT id FROM backend_racs WHERE token_hash = ?')
    .bind(await sha256(token))
    .first<{ id: string }>();
  if (!stored) {
    throw new HttpError(401, 'Admin authorization required');
  }
  return { racId: stored.id };
}

function requireConfiguration(env: Env): void {
  if (!env.OMS_PUBLISHABLE_KEY?.trim()) throw new HttpError(500, 'OMS_PUBLISHABLE_KEY is missing');
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

function requireSmartSessionConfig(networkId: string, assetId: string) {
  if (!isSmartSessionNetworkId(networkId)) {
    throw new HttpError(400, 'networkId is not supported');
  }
  if (!isSmartSessionAssetId(assetId)) {
    throw new HttpError(400, 'assetId is not supported');
  }
  try {
    return {
      network: getSmartSessionNetwork(networkId),
      asset: getSmartSessionAsset(networkId, assetId)
    };
  } catch {
    throw new HttpError(400, `${assetId.toUpperCase()} is not available on this network`);
  }
}

function requireRecipientScope(
  scope: RecipientScope,
  assetKind: 'native' | 'erc20'
): RecipientScope {
  try {
    return validateRecipientScope(scope, assetKind);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Recipient scope is invalid');
  }
}

function recipientScopeFromRow(
  row: Pick<ApprovalRow, 'network_id' | 'asset_id' | 'recipient_mode' | 'recipients'>
): RecipientScope {
  try {
    const asset = getSmartSessionAsset(row.network_id, row.asset_id);
    const scope: RecipientScope =
      row.recipient_mode === 'any'
        ? { mode: 'any' }
        : { mode: 'specific', recipients: JSON.parse(row.recipients) as string[] };
    return validateRecipientScope(scope, asset.kind);
  } catch {
    throw new HttpError(500, 'Stored recipient scope is invalid');
  }
}

function positiveBigInt(value: string, field: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, `${field} must be a positive integer string`);
  }
}

function validFutureDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    throw new HttpError(400, `${field} must be a future ISO date`);
  }
  return date;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function waasError(context: string, error: unknown): HttpError {
  const detail = isOMSWalletError(error) ? `: ${error.message}` : '';
  return new HttpError(502, `${context}${detail}`, serializeWaasError(error));
}

function toAdminApproval(row: ApprovalRow): AdminApproval {
  return {
    id: row.id,
    recipientScope: recipientScopeFromRow(row),
    allowance: row.allowance,
    expiresAt: row.expires_at,
    status: approvalStatus(row),
    networkId: row.network_id,
    assetId: row.asset_id,
    walletAddress: row.wallet_address ?? undefined,
    createdAt: row.created_at,
    approvedAt: row.approved_at ?? undefined,
    rejectedAt: row.rejected_at ?? undefined
  };
}

function approvalStatus(row: Pick<ApprovalRow, 'status' | 'rejected_at'>): ApprovalStatus {
  return row.rejected_at ? 'rejected' : row.status;
}

function toAdminSession(row: SessionRow): AdminSmartSession {
  return {
    id: row.id,
    walletId: row.wallet_id,
    walletAddress: row.wallet_address,
    sessionId: row.session_id,
    recipientScope: recipientScopeFromRow(row),
    allowance: row.allowance,
    networkId: row.network_id,
    assetId: row.asset_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    status: sessionStatus(row),
    revokedAt: row.revoked_at ?? undefined
  };
}

function sessionStatus(
  row: Pick<SessionRow, 'status' | 'expires_at'>
): AdminSmartSession['status'] {
  if (row.status === 'revoked') return 'revoked';
  return Date.parse(row.expires_at) <= Date.now() ? 'expired' : 'usable';
}

function toAdminTransaction(row: TransactionRow): AdminTransaction {
  return {
    id: row.id,
    smartSessionId: row.smart_session_id,
    walletAddress: row.wallet_address,
    txnId: row.txn_id,
    recipient: row.recipient,
    amount: row.amount,
    networkId: row.network_id,
    assetId: row.asset_id,
    status: row.status,
    txnHash: row.txn_hash ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
