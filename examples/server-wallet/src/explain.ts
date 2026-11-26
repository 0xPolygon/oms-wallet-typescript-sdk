import type { DemoEvent, Family, Mode } from '../shared';

/** What WaaS did, as a sentence about this user. */
export function waasSentence(method: string, name: string, chain?: string) {
  const wallet = chain ? `${name}'s ${chain} wallet` : `${name}'s wallet`;
  switch (method) {
    case 'CommitVerifier':
      return 'WaaS started sign-in';
    case 'CompleteAuth':
      return `WaaS signed ${name} in with the ID token`;
    case 'CreateWallet':
      return `WaaS created ${wallet}`;
    case 'UseWallet':
      return `WaaS reconnected ${wallet}`;
    case 'ListWallets':
      return `WaaS listed ${name}'s wallets`;
    case 'Execute':
      return 'WaaS sent the transaction';
    case 'TransactionStatus':
      return "WaaS checked the transaction's status";
    case 'SignMessage':
      return 'WaaS signed the message';
    case 'IsValidMessageSignature':
      return 'WaaS confirmed the signature is valid';
    case 'RevokeCredential':
      return `WaaS ended ${name}'s session`;
    default:
      return method.startsWith('Prepare') ? 'WaaS quoted the transaction' : `WaaS: ${method}`;
  }
}

/** What a set of stored keys holds, in words: "the operation and alice's session". */
export function storedThings(keys: readonly string[], name: string) {
  const things = new Set<string>();
  for (const key of keys)
    things.add(
      key === 'wallet'
        ? `${name}'s session`
        : key.startsWith('operation:')
          ? 'the operation'
          : /[Ii]ndex/.test(key)
            ? 'a lookup index'
            : key
    );
  const order = (thing: string) =>
    thing === 'the operation' ? 0 : thing.endsWith('session') ? 1 : 2;
  const list = [...things].sort((a, b) => order(a) - order(b));
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0]!;
}

export function size(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** What an operation status means, in a few words. */
export const STATUS: Record<string, string> = {
  preparing: 'Preparing the quote',
  quoted: 'Quoted, waiting for your approval',
  submitting: 'Being sent',
  pending: 'Sent, waiting for the chain',
  executed: 'Confirmed on chain',
  signed: 'Signed and verified by WaaS',
  failed: 'Failed',
  cancelled: 'Cancelled: nothing was sent',
  expired: 'Quote expired: nothing was sent',
  unknown: 'Outcome unknown: reconcile before retrying'
};

export const LANES = [
  { id: 'app', label: 'Server', hint: 'Your backend: it runs the SDK and mints ID tokens.' },
  {
    id: 'lock',
    label: 'Queue',
    hint: "Durable users run one call at a time, so two servers never act on the same user at once. In-memory users don't use it."
  },
  {
    id: 'store',
    label: 'Your DB',
    hint: 'Your database. It only ever receives AES-256-GCM ciphertext from the SDK. In-memory users skip it.'
  },
  {
    id: 'waas',
    label: 'WaaS',
    hint: 'The signer in an AWS Nitro enclave. It holds the keys, and every reply carries an attestation the SDK checks.'
  },
  {
    id: 'indexer',
    label: 'Indexer',
    hint: 'The balance service. Its replies are not attested, so balances are for display only.'
  }
] as const satisfies readonly { id: DemoEvent['lane']; label: string; hint: string }[];

export const SETUP_CODE = `import {
  createServerWalletService,
  createSingleProcessExecutorPool
} from '@polygonlabs/oms-server-wallet-sdk';

const oidc = {
  issuer,
  audience,
  getIdToken: (subject) => mintIdToken(subject)
};

// Durable: encrypted records in your database,
// one call at a time per user.
const durable = createServerWalletService({
  publishableKey,
  oidc,
  storage: { adapter: yourStore, encryptionKey },
  executor: createSingleProcessExecutorPool()
});

// In-memory: no database, no lock.
// Your app keeps the txnIds it needs.
const memory = createServerWalletService({
  publishableKey,
  oidc,
  storage: 'memory'
});

const wallet = durable.forSubject(userId);`;

const FACET: Record<Family, string> = { evm: 'evm', solana: 'solana', tron: 'tron' };

function familyOf(action: string): Family {
  return /Solana/.test(action) ? 'solana' : /Tron/.test(action) ? 'tron' : 'evm';
}

/** The SDK call to quote or send on each chain, as shown on buttons and in code. */
export function sdkCall(family: Family, step: 'prepare' | 'send') {
  const name = family === 'evm' ? 'Call' : 'Transfer';
  return step === 'prepare' ? `prepare${name}()` : `send${name}({ onPrepared })`;
}

function input(family: Family) {
  if (family === 'evm') return `idempotencyKey, chainId: 80002, to, value: '0', data: '0x'`;
  if (family === 'solana')
    return `idempotencyKey, network: 'solana:devnet', to, asset: 'native', amount`;
  return `idempotencyKey, network: 'tron:nile', to, asset: 'native', amount,\n  maxQuotedFee: '2000000'`;
}

const SNIPPETS: [RegExp, (family: Family, mode?: Mode) => string][] = [
  [
    /^(Create|Sign back in)/,
    (_, mode) =>
      mode === 'memory'
        ? `const wallet = memory.forSubject(userId);
await wallet.create({ families: ['evm', 'solana', 'tron'] });  // first time
await wallet.restore({ families: ['evm', 'solana', 'tron'] }); // later: never creates`
        : `const wallet = durable.forSubject(userId);
await wallet.createOrRestore({ families: ['evm', 'solana', 'tron'] });`
  ],
  [
    /^Quote/,
    (
      family
    ) => `const op = await wallet.${FACET[family]}.${sdkCall(family, 'prepare').replace('()', '')}({
  ${input(family)}
});
// op.status === 'quoted': show op.reviewId and op.quote to your approver`
  ],
  [
    /^Approve/,
    (family) => `await wallet.${FACET[family]}.execute({ idempotencyKey, reviewId });
const result = await wallet.${FACET[family]}.waitForOperation(idempotencyKey, { timeoutMs: 60_000 });`
  ],
  [
    /^Send/,
    (family) => `await wallet.${FACET[family]}.${family === 'evm' ? 'sendCall' : 'sendTransfer'}({
  ${input(family)},
  // Runs before the transaction is sent: save the receipt first.
  onPrepared: (op) => db.saveTxn(op.quote.txnId, op.quote.expiresAt)
});`
  ],
  [
    /^Retry/,
    () => `// The same call with the same idempotencyKey.
await wallet.evm.prepareCall({ idempotencyKey, chainId: 80002, to, value: '0', data: '0x' });
// Durable: returns the stored operation. In-memory: only while the handle lives.`
  ],
  [
    /^Check receipt/,
    () => `const { txnId, expiresAt } = await db.loadTxn(paymentId);
const result = await wallet.evm.waitForTransaction({ txnId, expiresAt }, { timeoutMs: 120_000 });
// result.outcome: 'executed' | 'failed' | 'reconciliation-required' | …`
  ],
  [/^Rotate/, () => `await wallet.rotateCredential();`],
  [/^Simulate restart/, () => `await memory.evict(userId); // ends the session, forgets records`],
  [/^Disable/, () => `await wallet.disable(); // every call refuses with WALLET_DISABLED`],
  [/^Enable/, () => `await wallet.enable();`],
  [
    /^Cancel/,
    (family) => `await wallet.${FACET[family]}.cancel({ idempotencyKey }); // provenUnsent: true`
  ],
  [
    /^Sign .* message/,
    (family) =>
      family === 'evm'
        ? `const op = await wallet.evm.signMessage({ idempotencyKey, chainId: 80002, message });
// op.signature, verified by WaaS`
        : `const op = await wallet.${FACET[family]}.signMessage({ idempotencyKey, message });
// op.signature, verified by WaaS`
  ],
  [
    /^Read balances/,
    () => `await wallet.indexer.getEvmBalances({ chainIds: [80002] });
await wallet.indexer.getSolanaBalances({ networks: ['solana:devnet'] });
await wallet.indexer.getTronBalances({ networks: ['tron:nile'] });
// Not attested: for display only`
  ]
];

export const codeFor = (action: string, mode?: Mode) =>
  SNIPPETS.find(([pattern]) => pattern.test(action))?.[1](familyOf(action), mode);
