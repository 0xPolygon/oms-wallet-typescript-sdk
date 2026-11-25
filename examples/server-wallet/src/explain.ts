import type { Mode } from '../shared';

const METHODS: Record<string, string> = {
  CommitVerifier: 'Start sign-in',
  CompleteAuth: 'Sign in with ID token',
  CreateWallet: 'Create wallet',
  UseWallet: 'Reconnect wallet',
  ListWallets: 'List wallets',
  Execute: 'Send',
  TransactionStatus: 'Check status',
  SignMessage: 'Sign',
  IsValidMessageSignature: 'Verify signature',
  RevokeCredential: 'End session'
};

export const plainMethod = (method: string) =>
  METHODS[method] ?? (method.startsWith('Prepare') ? 'Quote' : method);

export const SETUP_CODE = `import { createServerWalletService, createSingleProcessExecutorPool }
  from '@polygonlabs/oms-server-wallet-sdk';

const oidc = { issuer, audience, getIdToken: (subject) => mintIdToken(subject) };

// Durable: encrypted records in your store, one call at a time per user.
const durable = createServerWalletService({
  publishableKey, oidc,
  storage: { adapter: yourStore, encryptionKey },
  executor: createSingleProcessExecutorPool()
});

// In-memory: no store, no lock. Your app keeps the txnIds it needs.
const memory = createServerWalletService({ publishableKey, oidc, storage: 'memory' });

const wallet = durable.forSubject(userId);`;

const SNIPPETS: [RegExp, (mode?: Mode) => string][] = [
  [
    /^create or restore/,
    (mode) =>
      mode === 'memory'
        ? `const wallet = memory.forSubject(userId);
await wallet.create({ families: ['evm', 'solana', 'tron'] });  // first time
await wallet.restore({ families: ['evm', 'solana', 'tron'] }); // later: never creates`
        : `const wallet = durable.forSubject(userId);
await wallet.createOrRestore({ families: ['evm', 'solana', 'tron'] });`
  ],
  [
    /^prepare/,
    () => `const op = await wallet.evm.prepareCall({
  idempotencyKey, chainId: 80002, to, value: '0', data: '0x'
});
// op.status === 'quoted': show op.reviewId and op.quote to your approver`
  ],
  [
    /^execute/,
    () => `await wallet.evm.execute({ idempotencyKey, reviewId });
const result = await wallet.evm.waitForOperation(idempotencyKey, { timeoutMs: 60_000 });`
  ],
  [
    /^send/,
    () => `await wallet.evm.sendCall({
  idempotencyKey, chainId: 80002, to, value: '0', data: '0x',
  // Runs before the transaction is sent: save the receipt first.
  onPrepared: (op) => db.saveTxn(op.quote.txnId, op.quote.expiresAt)
});`
  ],
  [
    /^retry/,
    () => `// The same call with the same idempotencyKey.
await wallet.evm.prepareCall({ idempotencyKey, chainId: 80002, to, value: '0', data: '0x' });
// Durable: returns the stored operation. In-memory: only while the handle lives.`
  ],
  [
    /^recover/,
    () => `const { txnId, expiresAt } = await db.loadTxn(paymentId);
const result = await wallet.evm.waitForTransaction({ txnId, expiresAt }, { timeoutMs: 120_000 });
// result.outcome: 'executed' | 'failed' | 'reconciliation-required' | …`
  ],
  [/^rotate/, () => `await wallet.rotateCredential();`],
  [/^simulate restart/, () => `await memory.evict(userId); // ends the session, forgets records`],
  [/^disable/, () => `await wallet.disable(); // every call refuses with WALLET_DISABLED`],
  [/^enable/, () => `await wallet.enable();`],
  [/^cancel/, () => `await wallet.evm.cancel({ idempotencyKey }); // provenUnsent: true`],
  [
    /^sign/,
    () => `const op = await wallet.evm.signMessage({ idempotencyKey, chainId: 80002, message });
// op.signature, verified by WaaS`
  ],
  [
    /^read balances/,
    () => `await wallet.indexer.getEvmBalances({ chainIds: [80002] }); // unattested, display only`
  ]
];

export const codeFor = (action: string, mode?: Mode) =>
  SNIPPETS.find(([pattern]) => pattern.test(action))?.[1](mode);
