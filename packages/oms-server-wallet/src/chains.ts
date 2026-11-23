import { z } from 'zod';

import type { ChainQuote, FeeOption, NetworkFamily, RemoteWallet } from './protocol.js';
import type { State } from './state.js';

import { UpstreamError, WalletError } from './errors.js';
import { base58Decode } from './internal/protocol/addresses.js';
import { WaasErrorCode } from './internal/protocol/waasErrors.js';
import { chainQuoteSchema } from './protocol.js';

/** Solana and Tron, whose wallets are EOAs addressed by network name rather than chain ID. */
export type ChainFamily = Exclude<NetworkFamily, 'evm'>;
export type ChainOperationStatus =
  | 'preparing'
  | 'quoted'
  | 'submitting'
  | 'pending'
  | 'executed'
  | 'failed'
  | 'unknown'
  | 'signed'
  /** The quote expired before anything was broadcast. Prepare again under a new ID. */
  | 'expired';
export interface ChainOperation {
  id: string;
  family: ChainFamily;
  kind: string;
  /** Network name, such as `solana:devnet`; absent for network-independent signatures. */
  network?: string;
  inputHash: string;
  createdAt: string;
  status: ChainOperationStatus;
  quote?: ChainQuote;
  /** The fee option the wallet pays, when the transaction is not sponsored. */
  fee?: FeeOption;
  /** Its position in `quote.feeOptions`, sent with the token symbol to select it. */
  feeIndex?: number;
  signature?: string;
  verified?: boolean;
  txnHash?: string;
  error?: string;
}

/** What a family's wallet needs from the `ServerWallet` that owns its state and credential. */
export interface WalletContext {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Load state and make sure `family` has a wallet bound to a current credential. */
  open(family: ChainFamily): Promise<{ state: State; wallet: RemoteWallet }>;
  load(): Promise<State>;
  /** An authenticated call that re-authenticates once on a verified credential failure. */
  call(
    state: State,
    family: ChainFamily,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown>;
  /** An unauthenticated, still attested, call such as signature verification. */
  verify(method: string, params: Record<string, unknown>): Promise<unknown>;
  existing(
    id: string,
    family: ChainFamily,
    kind: string,
    input: unknown
  ): Promise<{ operation: ChainOperation | null; hash: string }>;
  read(id: string): Promise<ChainOperation | null>;
  write(operation: ChainOperation): Promise<void>;
  list(): Promise<ChainOperation[]>;
}

/**
 * WaaS answers this both for an expired quote and for a transaction another Execute already
 * claimed, so it never proves on its own that nothing was sent.
 */
const TRANSACTION_EXPIRED = WaasErrorCode.TransactionExpired;
/**
 * Execute refusals WaaS v1.2.0 returns only before it claims a Solana or Tron transaction, so
 * the request sent nothing. Any other error, such as a failed broadcast, can follow the claim.
 */
const PRE_CLAIM_REFUSALS: ReadonlySet<number> = new Set([
  WaasErrorCode.DataIntegrityError,
  WaasErrorCode.InvalidRequest,
  WaasErrorCode.Unauthorized,
  WaasErrorCode.UnsupportedNetwork,
  WaasErrorCode.UnsupportedTransactionMode,
  WaasErrorCode.TransactionFailed,
  WaasErrorCode.WalletProviderError,
  WaasErrorCode.TransactionNotFound,
  WaasErrorCode.InvalidFeeOption
]);
const FEE_REFUSED = WaasErrorCode.InvalidFeeOption;
/**
 * How long after a quote's expiry an unconfirmed submission can still be claimed by an Execute
 * that started in time; until then an expired quote does not prove nothing was sent.
 */
const CLAIM_GRACE_MS = 120_000;
const expired = () =>
  new WalletError(
    'TRANSACTION_EXPIRED',
    'The quote expired before it was submitted; nothing was sent. Prepare it again under a new ID.',
    409
  );
const signatureSchema = z.object({ signature: z.string().min(1).max(512) });
const validSchema = z.object({ isValid: z.boolean() });

const isSolanaSignature = (value: string) => base58Decode(value)?.length === 64;
const isTronTxid = (value: string) => /^[0-9a-f]{64}$/.test(value);

/** Shared prepare, execute, status and signing flow for Solana and Tron wallets. */
export abstract class ChainWallet<Op extends ChainOperation> {
  protected abstract readonly family: ChainFamily;
  constructor(protected readonly context: WalletContext) {}

  /** The persisted operation, polling its status while a transaction is in flight. */
  getOperation(id: string): Promise<Op | null> {
    return this.context.run(async () => {
      const op = await this.context.read(id);
      return op?.family === this.family ? ((await this.refresh(op)) as Op) : null;
    });
  }
  /** Reads persisted operations of this family without authenticating or polling. */
  listOperations(): Promise<Op[]> {
    return this.context.run(
      async () => (await this.context.list()).filter((op) => op.family === this.family) as Op[]
    );
  }

  /** Fee policy for a quote: return the option to pay, undefined when sponsored, or throw. */
  protected abstract payment(op: Op): FeeOption | undefined;

  protected async prepareLocked(
    id: string,
    kind: string,
    input: Record<string, unknown>,
    stored: Partial<Op>,
    request: (wallet: RemoteWallet) => { method: string; params: Record<string, unknown> }
  ): Promise<Op> {
    const { operation, hash } = await this.context.existing(id, this.family, kind, input);
    if (operation) return operation as Op;
    const { state, wallet } = await this.context.open(this.family);
    const { method, params } = request(wallet);
    const op = {
      id,
      family: this.family,
      kind,
      inputHash: hash,
      createdAt: new Date().toISOString(),
      status: 'preparing',
      ...stored
    } as Op;
    await this.context.write(op);
    try {
      op.quote = chainQuoteSchema.parse(
        await this.context.call(state, this.family, method, params)
      );
      const fee = this.payment(op);
      if (fee) {
        op.fee = fee;
        op.feeIndex = op.quote.feeOptions.indexOf(fee);
      }
      op.status = 'quoted';
      await this.context.write(op);
      return op;
    } catch (error) {
      op.status = 'failed';
      op.error = error instanceof WalletError ? error.code : 'PREPARATION_FAILED';
      await this.context.write(op);
      throw error;
    }
  }

  protected async executeLocked(id: string, kinds: string[]): Promise<Op> {
    const op = await this.context.read(id);
    if (!op || op.family !== this.family || !kinds.includes(op.kind) || !op.quote)
      throw new WalletError('NOT_FOUND', 'Prepared transaction not found.', 404);
    if (op.status !== 'quoted') return (await this.refresh(op)) as Op;
    if (!op.quote.sponsored && !op.fee)
      throw new WalletError('SPONSORSHIP_REQUIRED', 'This transaction is not sponsored.', 409);
    if (Date.parse(op.quote.expiresAt) <= Date.now()) {
      op.status = 'expired';
      op.error = 'TRANSACTION_EXPIRED';
      await this.context.write(op);
      throw expired();
    }
    const { state } = await this.context.open(this.family);
    op.status = 'submitting';
    await this.context.write(op);
    try {
      const result = this.statusSchema().parse(
        await this.context.call(state, this.family, 'Execute', {
          txnId: op.quote.txnId,
          ...(op.fee ? { feeOption: { token: op.fee.token.symbol, index: op.feeIndex } } : {})
        })
      );
      op.status = result.status === 'quoted' ? 'unknown' : result.status;
      if (result.txnHash) op.txnHash = result.txnHash;
    } catch (error) {
      if (error instanceof UpstreamError) await this.settle(state, op, error.upstreamCode);
      else {
        op.status = 'unknown';
        op.error = 'SUBMISSION_UNCERTAIN';
      }
    }
    await this.context.write(op);
    return op as Op;
  }

  /**
   * Settle an attested Execute refusal. A refusal WaaS returns only before claiming means this
   * request sent nothing, and it is the only Execute for the operation. Anything else stays
   * unknown unless the status shows the claim: WaaS reads transaction status without strong
   * consistency, so a `quoted` or expired answer just after the request may predate the claim.
   */
  private async settle(state: State, op: ChainOperation, code: number): Promise<void> {
    if (PRE_CLAIM_REFUSALS.has(code)) {
      op.status = 'failed';
      op.error = code === FEE_REFUSED ? 'FEE_ABOVE_QUOTE' : 'EXECUTE_REFUSED';
      return;
    }
    op.status = 'unknown';
    op.error = 'SUBMISSION_UNCERTAIN';
    try {
      const status = await this.status(state, op);
      if (status.status === 'quoted') return;
      op.status = status.status;
      op.error = undefined;
      if (status.txnHash) op.txnHash = status.txnHash;
    } catch {
      // Still unknown; getOperation polls again.
    }
  }

  private async refresh(op: ChainOperation): Promise<ChainOperation> {
    if (!op.quote || !['submitting', 'pending', 'unknown'].includes(op.status)) return op;
    const state = await this.context.load();
    let status;
    try {
      status = await this.status(state, op);
    } catch (error) {
      // TransactionStatus answers TransactionExpired only while the row still reads as quoted.
      // Only past the grace period can no Execute that started in time still claim it, and
      // has every claim long since reached the replica WaaS reads from.
      if (
        !(error instanceof UpstreamError) ||
        error.upstreamCode !== TRANSACTION_EXPIRED ||
        Date.now() < Date.parse(op.quote.expiresAt) + CLAIM_GRACE_MS
      )
        throw error;
      op.status = 'expired';
      op.error = 'TRANSACTION_EXPIRED';
      await this.context.write(op);
      return op;
    }
    // An ambiguous Execute is never automatically retried, even when status still says quoted.
    if (status.status === 'quoted') op.status = 'unknown';
    else {
      op.status = status.status;
      op.error = undefined;
    }
    if (status.txnHash) op.txnHash = status.txnHash;
    await this.context.write(op);
    return op;
  }

  private statusSchema() {
    const valid = this.family === 'solana' ? isSolanaSignature : isTronTxid;
    return z.object({
      status: z.enum(['quoted', 'pending', 'executed', 'failed']),
      txnHash: z
        .string()
        .refine(valid)
        .optional()
        .or(z.literal('').transform(() => undefined))
    });
  }
  private async status(state: State, op: ChainOperation) {
    return this.statusSchema().parse(
      await this.context.call(state, this.family, 'TransactionStatus', {
        txnId: op.quote!.txnId
      })
    );
  }

  /**
   * Sign with the family's wallet and check the signature with WaaS before returning it. A
   * failed request is recorded as failed; signing again needs a new ID.
   */
  protected signLocked(
    id: string,
    kind: string,
    input: Record<string, unknown>,
    sign: (wallet: RemoteWallet) => { method: string; params: Record<string, unknown> },
    check: (
      wallet: RemoteWallet,
      signature: string
    ) => {
      valid: boolean;
      method: string;
      params: Record<string, unknown>;
    },
    stored: Partial<Op> = {}
  ): Promise<Op> {
    return this.context.run(async () => {
      const { operation, hash } = await this.context.existing(id, this.family, kind, input);
      if (operation) return operation as Op;
      const { state, wallet } = await this.context.open(this.family);
      const op = {
        id,
        family: this.family,
        kind,
        inputHash: hash,
        createdAt: new Date().toISOString(),
        status: 'unknown',
        ...stored
      } as Op;
      await this.context.write(op);
      try {
        const request = sign(wallet);
        const { signature } = signatureSchema.parse(
          await this.context.call(state, this.family, request.method, request.params)
        );
        const verification = check(wallet, signature);
        if (!verification.valid)
          throw new WalletError('INVALID_RESPONSE', 'WaaS returned a malformed signature.', 502);
        const { isValid } = validSchema.parse(
          await this.context.verify(verification.method, verification.params)
        );
        if (!isValid)
          throw new WalletError(
            'SIGNATURE_INVALID',
            'WaaS returned a signature that did not verify.',
            502
          );
        op.signature = signature;
        op.verified = true;
        op.status = 'signed';
      } catch (error) {
        op.status = 'failed';
        op.error = error instanceof WalletError ? error.code : 'SIGNING_FAILED';
        await this.context.write(op);
        throw error;
      }
      await this.context.write(op);
      return op;
    });
  }
}
