import { base64DecodeBytes, base64EncodeBytes, utf8 } from './encoding.js';
import { WalletError } from './errors.js';

/**
 * Durable key-value storage scoped to a single wallet identity.
 * Implementations must complete durable persistence before `write` resolves.
 */
export interface StateStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

/**
 * Durable key-value storage partitioned by an SDK-computed identity namespace.
 * Implementations must isolate records by `namespace` and finish persistence before `write` resolves.
 */
export interface NamespacedStateStore {
  read(namespace: string, key: string): Promise<string | null>;
  write(namespace: string, key: string, value: string): Promise<void>;
}

/**
 * Cross-instance exclusive ownership boundary for one wallet identity.
 * `run` must hold exclusive ownership for the entire async task, including remote I/O.
 */
export interface ExclusiveExecutor {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/** Provider that returns the `ExclusiveExecutor` for an SDK-computed identity namespace. */
export type ExecutorProvider = (namespace: string) => ExclusiveExecutor;

/** Suitable for a single Node process or one Durable Object instance, not a clustered deployment. */
export class SerialExecutor implements ExclusiveExecutor {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * Create an in-process `ExclusiveExecutor` for a single Node process or one per-wallet Durable
 * Object instance. Clustered multi-process deployments must supply a distributed coordinator.
 */
export function createSingleProcessExecutor(): ExclusiveExecutor {
  return new SerialExecutor();
}

/**
 * Create an in-process per-namespace `ExecutorProvider` for a single Node process.
 * Reuses one queue per active namespace and reclaims an entry only once no owner or queued work
 * remains for that namespace. Clustered deployments must supply a distributed coordinator.
 */
export function createSingleProcessExecutorPool(): ExecutorProvider {
  const active = new Map<string, { executor: SerialExecutor; pending: number }>();
  return (namespace: string): ExclusiveExecutor => ({
    async run<T>(task: () => Promise<T>): Promise<T> {
      let entry = active.get(namespace);
      if (!entry) {
        entry = { executor: new SerialExecutor(), pending: 0 };
        active.set(namespace, entry);
      }
      entry.pending++;
      try {
        return await entry.executor.run(task);
      } finally {
        entry.pending--;
        if (entry.pending === 0 && active.get(namespace) === entry) active.delete(namespace);
      }
    }
  });
}

/**
 * Compute the canonical storage namespace and AES-GCM encryption context.
 * Uses the routed WaaS API origin (never the application's HTTP Origin header).
 */
export function computeIdentityNamespace(params: {
  waasOrigin: string;
  projectId: string;
  issuer: string;
  audience: string;
  subject: string;
}): string {
  return JSON.stringify([
    params.waasOrigin,
    params.projectId,
    params.issuer,
    params.audience,
    params.subject
  ]);
}

/** Bind a `NamespacedStateStore` to one SDK-computed namespace. */
export function scopeNamespacedStore(store: NamespacedStateStore, namespace: string): StateStore {
  return {
    read: (key) => store.read(namespace, key),
    write: (key, value) => store.write(namespace, key, value)
  };
}

/** Authenticated AES-256-GCM encryption bound to the identity namespace and record key. */
export class EncryptedStore implements StateStore {
  private readonly key: Promise<CryptoKey>;
  constructor(
    private readonly inner: StateStore,
    secret: string,
    private readonly context: string
  ) {
    const bytes = base64DecodeBytes(secret);
    if (bytes.length !== 32)
      throw new WalletError(
        'CONFIGURATION',
        'ENCRYPTION_KEY must contain 32 base64-encoded bytes.',
        503
      );
    this.key = crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async read(key: string): Promise<string | null> {
    const raw = await this.inner.read(key);
    if (raw === null) return null;
    try {
      const envelope: { v: number; iv: string; data: string } = JSON.parse(raw);
      if (envelope.v !== 1) throw new Error('Unsupported encryption version');
      const plain = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: base64DecodeBytes(envelope.iv),
          additionalData: utf8(`${this.context}:${key}:v1`)
        },
        await this.key,
        base64DecodeBytes(envelope.data)
      );
      return new TextDecoder().decode(plain);
    } catch {
      throw new WalletError(
        'STORAGE_INTEGRITY',
        'Encrypted wallet state could not be authenticated.',
        500
      );
    }
  }
  async write(key: string, value: string): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8(`${this.context}:${key}:v1`) },
      await this.key,
      utf8(value)
    );
    await this.inner.write(
      key,
      JSON.stringify({
        v: 1,
        iv: base64EncodeBytes(iv),
        data: base64EncodeBytes(new Uint8Array(data))
      })
    );
  }
}
