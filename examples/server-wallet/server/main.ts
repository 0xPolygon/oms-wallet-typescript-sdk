// Local run: one Node process serves the API, the issuer endpoints, the live event stream and the
// browser app (Vite in middleware mode). Data goes to .data/store.json.
//
//   pnpm dev:server-wallet-example   →   http://localhost:5190
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

import { createServer as createVite } from 'vite';

import { createApp } from './app.ts';
import type { Persistence } from './wallets.ts';

const FILE = '.data/store.json';
mkdirSync('.data', { recursive: true });
const data: Record<string, string> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
const persistence: Persistence = {
  get: async (key) => data[key] ?? null,
  async put(key, value) {
    data[key] = value;
    writeFileSync(FILE, JSON.stringify(data), { mode: 0o600 });
  },
  list: async (prefix) => new Map(Object.entries(data).filter(([key]) => key.startsWith(prefix))),
  async delete(keys) {
    for (const key of keys) delete data[key];
    writeFileSync(FILE, JSON.stringify(data), { mode: 0o600 });
  }
};

const app = await createApp(process.env, persistence);
const vite = await createVite({ server: { middlewareMode: true }, appType: 'spa' });
const port = Number(process.env.PORT ?? 5190);

createServer(async (req, res) => {
  if (!/^\/(api|\.well-known|oidc)\//.test(req.url ?? '/')) return vite.middlewares(req, res);
  const response = await app.fetch(await toRequest(req));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return res.end();
  const body = Readable.fromWeb(response.body as never);
  res.on('close', () => body.destroy());
  body.pipe(res);
}).listen(port, () => console.log(`Server wallet example on http://localhost:${port}`));

async function toRequest(req: IncomingMessage) {
  let body = '';
  if (req.method === 'POST') for await (const chunk of req) body += chunk;
  return new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: req.method === 'POST' ? body : undefined
  });
}
