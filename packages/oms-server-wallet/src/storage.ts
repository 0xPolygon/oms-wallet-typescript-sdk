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
 * Uses the routed WaaS API origin (never the application's HTTP Origin header). A trailing slash on
 * the issuer is ignored, as when WaaS-authenticated identities are compared, so one identity always
 * maps to one namespace, executor and set of swap reservations.
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
    params.issuer.replace(/\/$/, ''),
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

/**
 * Process-memory `StateStore` for the ephemeral signer. Internal: it is not exported, so callers
 * cannot pass non-durable storage to the durable factories. Never logged or persisted.
 */
export class MemoryStateStore implements StateStore {
  private readonly values = new Map<string, string>();
  async read(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async write(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

/** Decode and check a configured 32-byte base64 encryption key. */
function encryptionKeyBytes(secret: unknown): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    if (typeof secret === 'string') bytes = base64DecodeBytes(secret);
  } catch {
    bytes = undefined;
  }
  if (!bytes || bytes.length !== 32)
    throw new WalletError(
      'CONFIGURATION',
      'ENCRYPTION_KEY must contain 32 base64-encoded bytes.',
      503
    );
  return bytes;
}

/**
 * AES-256-GCM sealing with a key derived (HKDF-SHA256) from the configured secret for one purpose
 * and one wallet namespace. Each wallet namespace gets its own key, so the volume of random-IV
 * encryptions under any single key stays per-wallet even when one secret serves every tenant, and
 * wallet state and swap records never share a key.
 */
export class NamespaceCipher {
  private readonly key: Promise<CryptoKey>;

  /** Validates the secret synchronously so misconfiguration fails at construction. */
  constructor(secret: string, purpose: 'wallet-state' | 'trails-swap', namespace: string) {
    const bytes = encryptionKeyBytes(secret);
    this.key = crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']).then((master) =>
      crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: utf8('oms-server-wallet:v2'),
          info: utf8(JSON.stringify([purpose, namespace]))
        },
        master,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      )
    );
  }

  /** Encrypt `plaintext` bound to `aad`; returns a JSON envelope. */
  async seal(plaintext: string, aad: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8(aad) },
      await this.key,
      utf8(plaintext)
    );
    return JSON.stringify({
      v: 2,
      iv: base64EncodeBytes(iv),
      data: base64EncodeBytes(new Uint8Array(data))
    });
  }

  /** Decrypt an envelope from `seal` bound to the same `aad`; any mismatch returns null. */
  async open(envelope: string, aad: string): Promise<string | null> {
    try {
      const parsed: { v: number; iv: string; data: string } = JSON.parse(envelope);
      if (parsed.v !== 2) return null;
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64DecodeBytes(parsed.iv), additionalData: utf8(aad) },
        await this.key,
        base64DecodeBytes(parsed.data)
      );
      return new TextDecoder().decode(plain);
    } catch {
      return null;
    }
  }
}

/** Authenticated AES-256-GCM encryption bound to the identity namespace and record key. */
export class EncryptedStore implements StateStore {
  private readonly cipher: NamespaceCipher;
  constructor(
    private readonly inner: StateStore,
    secret: string,
    private readonly context: string
  ) {
    this.cipher = new NamespaceCipher(secret, 'wallet-state', context);
  }
  private aad(key: string): string {
    return JSON.stringify(['oms-server-wallet:wallet-state:v2', this.context, key]);
  }
  async read(key: string): Promise<string | null> {
    const raw = await this.inner.read(key);
    if (raw === null) return null;
    const plain = await this.cipher.open(raw, this.aad(key));
    if (plain === null)
      throw new WalletError(
        'STORAGE_INTEGRITY',
        'Encrypted wallet state could not be authenticated.',
        500
      );
    return plain;
  }
  async write(key: string, value: string): Promise<void> {
    await this.inner.write(key, await this.cipher.seal(value, this.aad(key)));
  }
}
