// The HTTP API, the OIDC issuer endpoints and the live event stream, as one fetch handler that
// runs under Node (server/main.ts) and in a Cloudflare Durable Object (server/worker.ts).
import { WalletError } from '@polygonlabs/oms-server-wallet-sdk';

import type { DemoConfig, Family, Mode } from '../shared.ts';
import { createIssuer } from './oidc.ts';
import { createWallets, MAX_USERS, subscribe, type Persistence } from './wallets.ts';

type Body = {
  name?: string;
  mode?: Mode;
  family?: Family;
  to?: string;
  amount?: string;
  idempotencyKey?: string;
  reviewId?: string;
  txnId?: string;
  key?: string;
};

export async function createApp(env: Record<string, string | undefined>, persistence: Persistence) {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Set ${name} (see examples/server-wallet/.env.example).`);
    return value;
  };
  const issuer = await createIssuer({
    issuer: required('OIDC_ISSUER'),
    audience: required('OIDC_AUDIENCE'),
    privateJwk: required('OIDC_PRIVATE_JWK')
  });
  const wallets = await createWallets(issuer, env, persistence);
  const config: DemoConfig = {
    issuer: issuer.issuer,
    networks: { evm: 'Polygon Amoy (80002)', solana: 'solana:devnet', tron: 'tron:nile' },
    maxUsers: MAX_USERS,
    resetNeedsKey: !!env.RESET_KEY
  };

  const actions: Record<string, (body: Body, subject: string) => Promise<unknown>> = {
    setup: (_, subject) => wallets.setup(subject),
    balances: (_, subject) => wallets.balances(subject),
    sign: (body, subject) => wallets.sign(subject, family(body)),
    prepare: (body, subject) => wallets.prepare(subject, family(body), body.to, body.amount),
    execute: (body, subject) =>
      wallets.execute(subject, family(body), text(body.idempotencyKey), text(body.reviewId)),
    cancel: (body, subject) => wallets.cancel(subject, family(body), text(body.idempotencyKey)),
    send: (body, subject) => wallets.send(subject, family(body), body.to, body.amount),
    recover: (body, subject) => wallets.recover(subject, text(body.txnId)),
    retry: (body, subject) => wallets.retry(subject, text(body.idempotencyKey)),
    rotate: (_, subject) => wallets.rotate(subject),
    toggle: (_, subject) => wallets.toggle(subject)
  };

  async function route(request: Request, path: string): Promise<Response | undefined> {
    // WaaS fetches these to verify the ID tokens this server mints, when OIDC_ISSUER points here.
    if (path === '/.well-known/openid-configuration') return json(200, issuer.discovery());
    if (path === '/oidc/jwks') return json(200, issuer.jwks());
    if (path === '/api/events') return events();
    if (path === '/api/config') return json(200, config);
    if (path === '/api/users' && request.method === 'GET') return json(200, wallets.listUsers());
    const body = (request.method === 'POST' ? await request.json().catch(() => ({})) : {}) as Body;
    if (path === '/api/users' && request.method === 'POST')
      return json(
        200,
        await wallets.addUser(text(body.name), body.mode === 'memory' ? 'memory' : 'durable')
      );
    if (path === '/api/reset' && request.method === 'POST') {
      if (env.RESET_KEY && body.key !== env.RESET_KEY)
        throw new WalletError('INVALID_INPUT', 'Wrong reset key.', 403);
      await wallets.reset();
      return json(200, { ok: true });
    }
    const match = /^\/api\/users\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
    if (!match) return undefined;
    const subject = decodeURIComponent(match[1]!);
    if (!match[2]) return json(200, await wallets.detail(subject));
    const action = actions[match[2]];
    if (action && request.method === 'POST') return json(200, await action(body, subject));
    return undefined;
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      try {
        return (await route(request, path)) ?? json(404, { code: 'NOT_FOUND', message: path });
      } catch (error) {
        if (error instanceof WalletError)
          return json(error.status, { code: error.code, message: error.message });
        console.error(error);
        return json(500, {
          code: 'INTERNAL',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };
}

/** Server-sent events: the recent history, then every new event. */
function events() {
  const encoder = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      const unsubscribe = subscribe((event) => send(`data: ${JSON.stringify(event)}\n\n`));
      const ping = setInterval(() => send(': ping\n\n'), 15_000);
      stop = () => {
        clearInterval(ping);
        unsubscribe();
      };
    },
    cancel: () => stop()
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }
  });
}

function json(status: number, value: unknown) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
function family(body: Body): Family {
  if (body.family === 'evm' || body.family === 'solana' || body.family === 'tron')
    return body.family;
  throw new WalletError('INVALID_INPUT', 'family must be evm, solana or tron.', 400);
}
function text(value: unknown) {
  if (typeof value !== 'string' || !value)
    throw new WalletError('INVALID_INPUT', 'Missing a required field.', 400);
  return value;
}
