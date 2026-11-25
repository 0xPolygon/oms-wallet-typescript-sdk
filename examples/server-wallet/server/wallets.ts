// The SDK setup this example is about, plus the tracing that feeds the browser's live view.
//
// Two services share one issuer:
// - durable: encrypted state in a store the app provides (a JSON file under Node, Durable Object
//   storage on Workers) and a lock per user, so records and idempotency survive restarts;
// - memory: credentials and records live in a per-user handle in this process; the app keeps the
//   txnIds it needs itself (saved from onPrepared) and recovers by txnId after a restart.
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  createServerWalletService,
  createSingleProcessExecutorPool,
  describeOperation,
  WalletError,
  type ExecutorProvider,
  type NamespacedStateStore,
  type NetworkFamily,
  type WalletOperation,
  type WalletSnapshot
} from '@polygonlabs/oms-server-wallet-sdk';

import type {
  DemoEvent,
  DemoUser,
  Family,
  LedgerEntry,
  Mode,
  OperationView,
  StoreEntry,
  UserDetail
} from '../shared.ts';
import type { Issuer } from './oidc.ts';

export const FAMILIES: readonly Family[] = ['evm', 'solana', 'tron'];
const AMOY = 80002 as const;
/** Sponsored zero-value calls go here: they need no funds and change nothing. */
const SINK = '0x000000000000000000000000000000000000dEaD';
const TRON_MAX_FEE = '2000000'; // 2 TRX, in sun

// ---------------------------------------------------------------------------------------------
// Trace: every event carries the user and action it happened under (AsyncLocalStorage).

type TraceContext = { subject?: string; mode?: Mode; action?: number; quiet?: boolean };
const context = new AsyncLocalStorage<TraceContext>();
const history: DemoEvent[] = [];
const listeners = new Set<(event: DemoEvent) => void>();
let nextId = 1;

type EventBody = DemoEvent extends infer E
  ? E extends DemoEvent
    ? Omit<E, 'id' | 'at' | 'subject' | 'mode' | 'action'>
    : never
  : never;

export function emit(body: EventBody) {
  const ctx = context.getStore();
  if (ctx?.quiet) return;
  const event = {
    ...body,
    id: nextId++,
    at: Date.now(),
    subject: ctx?.subject,
    mode: ctx?.mode,
    action: ctx?.action
  } as DemoEvent;
  history.push(event);
  if (history.length > 500) history.shift();
  for (const listener of listeners) listener(event);
}

/** Forget the trace, and tell every open browser to clear theirs. */
function resetTrace() {
  history.length = 0;
  emit({ lane: 'app', kind: 'reset' });
}

export function subscribe(listener: (event: DemoEvent) => void) {
  for (const event of history) listener(event);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every WaaS and indexer request, with its latency and whether it carried an attestation. */
const tracedFetch: typeof fetch = async (input, init) => {
  const started = performance.now();
  const response = await fetch(input, init);
  const ms = Math.round(performance.now() - started);
  const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
  const method = path.split('/').pop() ?? path;
  if (/^\/v1\/Waas(Public)?\//.test(path))
    emit({
      lane: 'waas',
      kind: 'waas',
      method,
      ms,
      status: response.status,
      attested: response.headers.has('X-Attestation-Document')
    });
  else emit({ lane: 'indexer', kind: 'indexer', method, ms, status: response.status });
  return response;
};

/** Where the app keeps its data: a JSON file under Node, Durable Object storage on Workers. */
export interface Persistence {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(prefix: string): Promise<Map<string, string>>;
  delete(keys: readonly string[]): Promise<void>;
}

/** Every user creates wallets in the WaaS project, so a public sandbox needs a ceiling. */
export const MAX_USERS = 50;

type QuoteInput = { family: Family; mode: 'prepare' | 'send'; to?: string; amount?: string };
type StoredState = { value: string; writes: number; updatedAt: string; subject?: string };

/** One queue per user in this process, traced so the browser can show calls waiting their turn. */
const pool = createSingleProcessExecutorPool();
const tracedExecutor: ExecutorProvider = (namespace) => {
  const inner = pool(namespace);
  return {
    run(task) {
      const queued = performance.now();
      emit({ lane: 'lock', kind: 'lock', phase: 'queued' });
      return inner.run(async () => {
        const acquired = performance.now();
        emit({
          lane: 'lock',
          kind: 'lock',
          phase: 'acquired',
          waitedMs: Math.round(acquired - queued)
        });
        try {
          return await task();
        } finally {
          emit({
            lane: 'lock',
            kind: 'lock',
            phase: 'released',
            heldMs: Math.round(performance.now() - acquired)
          });
        }
      });
    }
  };
};

// ---------------------------------------------------------------------------------------------
// The two services.

export async function createWallets(
  issuer: Issuer,
  env: Record<string, string | undefined>,
  persistence: Persistence
) {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Set ${name} (see examples/server-wallet/.env.example).`);
    return value;
  };

  // Durable storage. Values are already encrypted by the SDK (AES-256-GCM bound to the
  // namespace), so the app only stores opaque strings. Kept in memory too, for the store view.
  const state = new Map<string, Map<string, StoredState>>();
  // The namespace holds the issuer URL, so it is encoded to keep `/` out of the key.
  for (const [key, raw] of await persistence.list('state2/')) {
    const [, encoded, name] = key.split('/', 3) as [string, string, string];
    const namespace = decodeURIComponent(encoded);
    if (!state.has(namespace)) state.set(namespace, new Map());
    state.get(namespace)!.set(name, JSON.parse(raw) as StoredState);
  }
  const store: NamespacedStateStore = {
    async read(namespace, key) {
      return state.get(namespace)?.get(key)?.value ?? null;
    },
    async write(namespace, key, value) {
      if (!state.has(namespace)) state.set(namespace, new Map());
      const entries = state.get(namespace)!;
      const entry: StoredState = {
        value,
        writes: (entries.get(key)?.writes ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        subject: context.getStore()?.subject
      };
      await persistence.put(
        `state2/${encodeURIComponent(namespace)}/${key}`,
        JSON.stringify(entry)
      );
      entries.set(key, entry);
      emit({ lane: 'store', kind: 'store', key, bytes: value.length, preview: value.slice(0, 40) });
    }
  };

  // The app's own records: users, and the txnIds it saved for in-memory users.
  const app: {
    users: DemoUser[];
    ledger: LedgerEntry[];
    inputs: Record<string, QuoteInput>;
  } = { users: [], ledger: [], inputs: {}, ...JSON.parse((await persistence.get('app')) ?? '{}') };
  const saveApp = async () => {
    app.ledger = app.ledger.slice(0, 200);
    app.inputs = Object.fromEntries(Object.entries(app.inputs).slice(-200));
    await persistence.put('app', JSON.stringify(app));
  };
  const findUser = (subject: string) => {
    const user = app.users.find((candidate) => candidate.subject === subject);
    if (!user) throw new WalletError('INVALID_INPUT', `Unknown user ${subject}.`, 404);
    return user;
  };

  const pcr0s = (env.TRUSTED_PCR0S ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const shared = {
    publishableKey: required('OMS_PUBLISHABLE_KEY'),
    oidc: {
      issuer: issuer.issuer,
      audience: issuer.audience,
      // Only ever called for subjects this server has authenticated (here: users it created).
      getIdToken: async (subject: string) => {
        const minted = await issuer.mint(subject);
        emit({
          lane: 'app',
          kind: 'hook',
          name: 'ID token',
          detail: `minted { iss: ${issuer.issuer}, aud: ${issuer.audience}, sub: ${subject}, exp: +5 min }, single use`
        });
        return minted;
      }
    },
    // send* shortcuts on top of prepare → execute. Your own authorization runs before either.
    approval: 'allow-immediate',
    ...(pcr0s.length
      ? { attestation: { trustedPcr0s: pcr0s, allowDebugEnclave: pcr0s.includes('0'.repeat(96)) } }
      : {}),
    fetch: tracedFetch
  } as const;

  const durable = createServerWalletService({
    ...shared,
    storage: { adapter: store, encryptionKey: required('ENCRYPTION_KEY') },
    executor: tracedExecutor
  });
  const memory = createServerWalletService({ ...shared, storage: 'memory' });

  const handle = (user: DemoUser) =>
    user.mode === 'durable' ? durable.forSubject(user.subject) : memory.forSubject(user.subject);

  /** Run one browser-triggered action under a trace context. */
  let nextAction = 1;
  async function act<T>(
    subject: string,
    name: string,
    run: (user: DemoUser) => Promise<T>,
    describe?: (result: T) => string
  ) {
    const user = findUser(subject);
    return context.run({ subject, mode: user.mode, action: nextAction++ }, async () => {
      emit({ lane: 'app', kind: 'action', phase: 'start', name });
      try {
        const result = await run(user);
        emit({ lane: 'app', kind: 'action', phase: 'end', name, detail: describe?.(result) });
        return result;
      } catch (error) {
        const detail =
          error instanceof WalletError ? `${error.code}: ${error.message}` : String(error);
        emit({ lane: 'app', kind: 'action', phase: 'error', name, detail });
        throw error;
      }
    });
  }

  async function remember(user: DemoUser, snapshot: WalletSnapshot) {
    for (const family of FAMILIES) {
      const address = snapshot.wallets[family]?.address;
      if (address) user.wallets[family] = address;
    }
    await saveApp();
    return { ...user, expiresAt: snapshot.expiresAt, disabled: snapshot.disabled };
  }
  const families = FAMILIES as readonly NetworkFamily[];

  /** Follow an operation after execute or send, tracing each status change and status read. */
  function follow(user: DemoUser, family: Family, id: string, last?: string) {
    const deadline = Date.now() + 5 * 60_000;
    void (async () => {
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        let operation: WalletOperation | null;
        try {
          operation = await handle(user)[family].refreshOperation(id);
        } catch {
          continue;
        }
        if (!operation) return; // a dropped in-memory handle: its records are gone
        if (operation.status !== last) {
          last = operation.status;
          emit({ lane: 'app', kind: 'operation', operation: view(operation) });
        }
        const settled =
          ['failed', 'expired', 'cancelled', 'signed'].includes(operation.status) ||
          (operation.status === 'executed' && !!operation.txnHash) ||
          (operation.status === 'unknown' && operation.error === 'RECONCILIATION_REQUIRED');
        if (settled) return;
      }
    })();
  }

  const traced = (operation: WalletOperation) => {
    emit({ lane: 'app', kind: 'operation', operation: view(operation) });
    return operation;
  };

  /** Save the txnId before Execute, so an in-memory user's transfer is recoverable. */
  const onPrepared =
    (user: DemoUser, family: Family) =>
    async (operation: WalletOperation & { status: 'quoted' }) => {
      emit({ lane: 'app', kind: 'operation', operation: view(operation) });
      emit({
        lane: 'app',
        kind: 'hook',
        name: 'onPrepared',
        detail:
          user.mode === 'memory'
            ? `saved txnId ${operation.quote.txnId.slice(0, 10)}… to the app ledger`
            : 'quote ready; Execute follows'
      });
      await saveTxn(user, family, operation);
    };

  /** Prepare or send, saving the input so the same key can be retried. */
  async function quote(user: DemoUser, idempotencyKey: string, input: QuoteInput) {
    app.inputs[idempotencyKey] = input;
    await saveApp();
    const wallet = handle(user);
    const { family, to, amount } = input;
    const recipient = transferTo(user, family, to);
    const hook = input.mode === 'send' ? { onPrepared: onPrepared(user, family) } : {};
    const run =
      input.mode === 'send'
        ? {
            evm: () =>
              wallet.evm.sendCall({
                idempotencyKey,
                chainId: AMOY,
                to: recipient,
                value: '0',
                data: '0x',
                ...hook
              }),
            solana: () =>
              wallet.solana.sendTransfer({
                idempotencyKey,
                network: 'solana:devnet',
                to: recipient,
                asset: 'native',
                amount: amount || '1000000',
                ...hook
              }),
            tron: () =>
              wallet.tron.sendTransfer({
                idempotencyKey,
                network: 'tron:nile',
                to: recipient,
                asset: 'native',
                amount: amount || '1',
                maxQuotedFee: TRON_MAX_FEE,
                ...hook
              })
          }
        : {
            evm: () =>
              wallet.evm.prepareCall({
                idempotencyKey,
                chainId: AMOY,
                to: recipient,
                value: '0',
                data: '0x'
              }),
            solana: () =>
              wallet.solana.prepareTransfer({
                idempotencyKey,
                network: 'solana:devnet',
                to: recipient,
                asset: 'native',
                amount: amount || '1000000'
              }),
            tron: () =>
              wallet.tron.prepareTransfer({
                idempotencyKey,
                network: 'tron:nile',
                to: recipient,
                asset: 'native',
                amount: amount || '1',
                maxQuotedFee: TRON_MAX_FEE
              })
          };
    const operation = await run[family]();
    // An in-memory user's app records every quote's txnId, so it can recover after a restart.
    if (input.mode === 'prepare' && operation.status === 'quoted')
      await saveTxn(user, family, operation);
    if (input.mode === 'send') follow(user, family, operation.id, operation.status);
    return traced(operation);
  }

  async function saveTxn(
    user: DemoUser,
    family: Family,
    operation: WalletOperation & { status: 'quoted' }
  ) {
    if (user.mode !== 'memory' || app.ledger.some((entry) => entry.txnId === operation.quote.txnId))
      return;
    app.ledger.unshift({
      subject: user.subject,
      family,
      idempotencyKey: operation.id,
      txnId: operation.quote.txnId,
      expiresAt: operation.quote.expiresAt,
      savedAt: new Date().toISOString()
    });
    await saveApp();
  }

  const transferTo = (user: DemoUser, family: Family, to?: string) => {
    const recipient = to?.trim() || (family === 'evm' ? SINK : user.wallets[family]);
    if (!recipient)
      throw new WalletError('INVALID_INPUT', `Create the ${family} wallet first.`, 400);
    return recipient;
  };
  const key = (family: Family) =>
    `${family}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;

  return {
    listUsers: () => app.users,

    async addUser(name: string, mode: Mode) {
      const clean = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .slice(0, 40);
      if (!clean) throw new WalletError('INVALID_INPUT', 'Name the user.', 400);
      // One mode per identity: the mode is part of the subject.
      const subject = `demo:${mode}:${clean}`;
      if (!app.users.some((user) => user.subject === subject)) {
        if (app.users.length >= MAX_USERS)
          throw new WalletError(
            'INVALID_INPUT',
            `The sandbox is full (${MAX_USERS} users). Reset it, or pick an existing user.`,
            409
          );
        app.users.push({
          subject,
          name: clean,
          mode,
          createdAt: new Date().toISOString(),
          wallets: {}
        });
        await saveApp();
      }
      return this.setup(subject);
    },

    setup: (subject: string) =>
      act(
        subject,
        'create or restore wallets',
        async (user) => {
          const wallet = handle(user);
          const snapshot =
            'createOrRestore' in wallet
              ? await wallet.createOrRestore({ families })
              : Object.keys(user.wallets).length === FAMILIES.length
                ? await wallet.restore({ families })
                : await wallet.create({ families });
          return remember(user, snapshot);
        },
        (user) =>
          Object.entries(user.wallets)
            .map(([f, a]) => `${f} ${a.slice(0, 8)}…`)
            .join(', ')
      ),

    balances: (subject: string) =>
      act(
        subject,
        'read balances',
        async (user) => {
          const wallet = handle(user);
          const [evm, solana, tron] = await Promise.all([
            wallet.indexer.getEvmBalances({ chainIds: [AMOY] }),
            wallet.indexer.getSolanaBalances({ networks: ['solana:devnet'] }),
            wallet.indexer.getTronBalances({ networks: ['tron:nile'] })
          ]);
          return [...evm.items, ...solana.items, ...tron.items].map((item) => ({
            chain: 'chainId' in item ? `Amoy` : item.network,
            symbol: item.symbol,
            balance: item.balance,
            decimals: item.decimals ?? 18
          }));
        },
        (items) => `${items.length} balances`
      ),

    sign: (subject: string, family: Family) =>
      act(
        subject,
        `sign a ${family} message`,
        async (user) => {
          const wallet = handle(user);
          const input = { idempotencyKey: key(family), message: `Hello from ${user.name}` };
          const operation =
            family === 'evm'
              ? await wallet.evm.signMessage({ ...input, chainId: AMOY })
              : family === 'solana'
                ? await wallet.solana.signMessage(input)
                : await wallet.tron.signMessage(input);
          return traced(operation);
        },
        (op) => `signed, verified: ${op.status === 'signed'}`
      ),

    /** Step 1 of two-phase: quote only. Nothing is sent until execute. */
    prepare: (subject: string, family: Family, to?: string, amount?: string) =>
      act(
        subject,
        `prepare ${family}`,
        (user) => quote(user, key(family), { family, mode: 'prepare', to, amount }),
        (op) => op.status
      ),

    /** Step 2 of two-phase: the reviewId binds execution to exactly the quoted terms. */
    execute: (subject: string, family: Family, idempotencyKey: string, reviewId: string) =>
      act(
        subject,
        `execute ${family}`,
        async (user) => {
          const operation = await handle(user)[family].execute({ idempotencyKey, reviewId });
          follow(user, family, operation.id, operation.status);
          return traced(operation);
        },
        (op) => op.status
      ),

    cancel: (subject: string, family: Family, idempotencyKey: string) =>
      act(
        subject,
        `cancel ${family}`,
        async (user) => traced(await handle(user)[family].cancel({ idempotencyKey })),
        (op) => op.status
      ),

    /** One call: prepare, onPrepared (save the txnId), execute. */
    send: (subject: string, family: Family, to?: string, amount?: string) =>
      act(
        subject,
        `send ${family}`,
        (user) => quote(user, key(family), { family, mode: 'send', to, amount }),
        (op) => op.status
      ),

    /** The same call with the same idempotencyKey: a durable wallet returns the stored operation. */
    retry: (subject: string, idempotencyKey: string) =>
      act(
        subject,
        'retry with the same key',
        async (user) => {
          const input = app.inputs[idempotencyKey];
          if (!input) throw new WalletError('INVALID_INPUT', 'Unknown idempotencyKey.', 404);
          const started = Date.now();
          const operation = await quote(user, idempotencyKey, input);
          return { operation, reused: Date.parse(operation.createdAt) < started };
        },
        ({ reused }) =>
          reused
            ? 'same operation returned, nothing sent again'
            : 'no record of this key in this handle: a new quote was made'
      ),

    /** In-memory recovery: wait on a saved txnId from any handle, with no record of the operation. */
    recover: (subject: string, txnId: string) =>
      act(
        subject,
        'recover by txnId',
        async (user) => {
          const entry = app.ledger.find(
            (candidate) => candidate.txnId === txnId && candidate.subject === subject
          );
          if (!entry)
            throw new WalletError('INVALID_INPUT', 'No such txnId in the app ledger.', 404);
          const result = await handle(user)[entry.family].waitForTransaction(
            { txnId: entry.txnId, expiresAt: entry.expiresAt },
            { timeoutMs: 120_000, pollIntervalMs: 2500 }
          );
          entry.outcome = result.outcome;
          entry.txnHash = result.status?.txnHash;
          await saveApp();
          return entry;
        },
        (entry) => entry.outcome ?? ''
      ),

    rotate: (subject: string) =>
      act(
        subject,
        'rotate credential',
        async (user) => remember(user, await handle(user).rotateCredential()),
        (u) => `new credential until ${u.expiresAt}`
      ),

    /** Durable: the kill switch. In-memory: drop the handle (what a restart does). */
    async toggle(subject: string) {
      const user = findUser(subject);
      if (user.mode === 'memory')
        return act(
          subject,
          'simulate restart (drop handle)',
          // Revokes the credential and forgets every record of this handle.
          () => memory.evict(subject).then(() => user),
          () => 'handle dropped: records gone, credential revoked'
        );
      const wallet = durable.forSubject(subject);
      const disabled = (await context.run({ quiet: true }, () => wallet.inspect())).disabled;
      return act(
        subject,
        disabled ? 'enable wallet' : 'disable wallet (kill switch)',
        async () => remember(user, disabled ? await wallet.enable() : await wallet.disable()),
        (result) => (result.disabled ? 'disabled' : 'enabled')
      );
    },

    /**
     * Empty the sandbox: forget every user, record and trace, and end in-memory sessions. Wallets
     * stay in WaaS, so a user created again with the same name gets the same addresses back.
     */
    async reset() {
      await Promise.allSettled(
        app.users.filter((user) => user.mode === 'memory').map((user) => memory.evict(user.subject))
      );
      await persistence.delete([...(await persistence.list('')).keys()]);
      state.clear();
      app.users = [];
      app.ledger = [];
      app.inputs = {};
      resetTrace();
    },

    /** What the browser shows for one user. Read quietly so polling does not flood the trace. */
    async detail(subject: string): Promise<UserDetail> {
      const user = findUser(subject);
      return context.run({ subject, mode: user.mode, quiet: true }, async () => {
        const operations: OperationView[] = [];
        const wallet = handle(user);
        // A durable wallet's records survive restarts; an in-memory handle has only its own.
        if (user.mode === 'durable' || Object.keys(user.wallets).length) {
          for (const family of FAMILIES) {
            const page = await wallet[family]
              .listOperations({ status: 'all', limit: 25 })
              .catch(() => ({ items: [] }));
            operations.push(...page.items.map(view));
          }
        }
        operations.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const store: StoreEntry[] = [...state.values()].flatMap((entries) =>
          [...entries]
            .filter(([, entry]) => entry.subject === subject)
            .map(([key, entry]) => ({
              key,
              bytes: entry.value.length,
              preview: entry.value.slice(0, 40),
              writes: entry.writes,
              updatedAt: entry.updatedAt
            }))
        );
        const snapshot = await wallet.inspect().catch(() => undefined);
        const expiresAt = snapshot?.expiresAt;
        return {
          user,
          session: {
            signedIn: !!expiresAt && Date.parse(expiresAt) > Date.now(),
            expiresAt,
            disabled: !!snapshot?.disabled
          },
          operations,
          ledger: app.ledger.filter((entry) => entry.subject === subject),
          store
        };
      });
    }
  };
}

const EXPLORERS: Record<string, (hash: string) => string> = {
  evm: (hash) => `https://amoy.polygonscan.com/tx/${hash}`,
  solana: (hash) => `https://explorer.solana.com/tx/${hash}?cluster=devnet`,
  tron: (hash) => `https://nile.tronscan.org/#/transaction/${hash}`
};

export function view(operation: WalletOperation): OperationView {
  const next = describeOperation(operation);
  return {
    id: operation.id,
    family: operation.family,
    kind: operation.kind,
    status: operation.status,
    chain: operation.family === 'evm' ? 'Polygon Amoy' : (operation.network ?? operation.family),
    createdAt: operation.createdAt,
    txnId: operation.quote?.txnId,
    reviewId: operation.reviewId,
    expiresAt: operation.quote?.expiresAt,
    txnHash: operation.txnHash,
    explorer: operation.txnHash ? EXPLORERS[operation.family]!(operation.txnHash) : undefined,
    provenUnsent: operation.provenUnsent,
    error: operation.error,
    signature: operation.signature,
    next: { action: next.action, reason: next.reason }
  };
}
