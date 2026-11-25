// Cloudflare deployment: static assets for the browser app, and one Durable Object that runs the
// same app as server/main.ts. A single instance makes the in-process lock and in-memory handles
// correct, and its storage is the durable store. When it is evicted, in-memory handles go with it.
import { DurableObject } from 'cloudflare:workers';

import { createApp } from './app.ts';
import type { Persistence } from './wallets.ts';

interface Env {
  readonly DEMO: DurableObjectNamespace<Demo>;
  readonly ASSETS: Fetcher;
}

export class Demo extends DurableObject<Env> {
  private app?: ReturnType<typeof createApp>;

  override fetch(request: Request) {
    this.app ??= createApp(this.env as never, storagePersistence(this.ctx.storage)).catch(
      (error: unknown) => {
        this.app = undefined;
        throw error;
      }
    );
    return this.app.then((app) => app.fetch(request));
  }
}

function storagePersistence(storage: DurableObjectStorage): Persistence {
  return {
    get: async (key) => (await storage.get<string>(key)) ?? null,
    put: (key, value) => storage.put(key, value),
    list: async (prefix) => new Map(await storage.list<string>({ prefix })),
    async delete(keys) {
      // Durable Object storage deletes at most 128 keys per call.
      for (let start = 0; start < keys.length; start += 128)
        await storage.delete(keys.slice(start, start + 128));
    }
  };
}

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (/^\/(api|\.well-known|oidc)\//.test(pathname))
      return env.DEMO.getByName('demo').fetch(request);
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
