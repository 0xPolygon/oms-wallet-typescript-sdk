// Shapes the server sends the browser. The browser never imports the SDK.

export type Mode = 'durable' | 'memory';
export type Family = 'evm' | 'solana' | 'tron';

export interface DemoUser {
  readonly subject: string;
  readonly name: string;
  readonly mode: Mode;
  readonly createdAt: string;
  wallets: Partial<Record<Family, string>>;
}

/** What the app itself records for an in-memory user, saved from `onPrepared`. */
export interface LedgerEntry {
  readonly subject: string;
  readonly family: Family;
  readonly idempotencyKey: string;
  readonly txnId: string;
  readonly expiresAt: string;
  readonly savedAt: string;
  outcome?: string;
  txnHash?: string;
}

export interface OperationView {
  readonly id: string;
  readonly family: Family;
  readonly kind: string;
  readonly status: string;
  readonly chain: string;
  readonly createdAt: string;
  readonly txnId?: string;
  readonly reviewId?: string;
  readonly expiresAt?: string;
  readonly txnHash?: string;
  readonly explorer?: string;
  readonly provenUnsent: boolean;
  readonly error?: string;
  readonly signature?: string;
  readonly next: { readonly action: string; readonly reason: string };
}

export interface StoreEntry {
  readonly key: string;
  readonly bytes: number;
  readonly preview: string;
  readonly writes: number;
  readonly updatedAt: string;
}

/** One line of the live trace. `lane` is where the dot is drawn. */
export type DemoEvent = {
  readonly id: number;
  readonly at: number;
  readonly subject?: string;
  readonly mode?: Mode;
  readonly action?: number;
} & (
  | {
      readonly lane: 'app';
      readonly kind: 'action';
      readonly phase: 'start' | 'end' | 'error';
      readonly name: string;
      readonly detail?: string;
    }
  | { readonly lane: 'app'; readonly kind: 'reset' }
  | {
      readonly lane: 'app';
      readonly kind: 'hook';
      readonly name: string;
      readonly detail: string;
      readonly title?: string;
    }
  | { readonly lane: 'app'; readonly kind: 'operation'; readonly operation: OperationView }
  | {
      readonly lane: 'lock';
      readonly kind: 'lock';
      readonly phase: 'queued' | 'acquired' | 'released';
      readonly waitedMs?: number;
      readonly heldMs?: number;
    }
  | {
      readonly lane: 'store';
      readonly kind: 'store';
      readonly key: string;
      readonly bytes: number;
      readonly preview: string;
    }
  | {
      readonly lane: 'waas';
      readonly kind: 'waas';
      readonly method: string;
      readonly chain?: string;
      readonly ms: number;
      readonly status: number;
      readonly attested: boolean;
    }
  | {
      readonly lane: 'indexer';
      readonly kind: 'indexer';
      readonly method: string;
      readonly chain?: string;
      readonly ms: number;
      readonly status: number;
    }
);

export interface UserDetail {
  readonly user: DemoUser;
  /** Read from the live handle, not from the app's records. */
  readonly session: {
    readonly signedIn: boolean;
    readonly expiresAt?: string;
    readonly disabled: boolean;
  };
  readonly operations: readonly OperationView[];
  readonly ledger: readonly LedgerEntry[];
  readonly store: readonly StoreEntry[];
}

export interface DemoConfig {
  readonly issuer: string;
  readonly networks: { readonly evm: string; readonly solana: string; readonly tron: string };
  readonly maxUsers: number;
  /** Fallback recipients when no other demo user has a wallet on that chain. */
  readonly sinks: Readonly<Record<Family, string>>;
  /** Whether resetting the sandbox asks for RESET_KEY. */
  readonly resetNeedsKey: boolean;
}

export interface Balance {
  readonly family: Family;
  readonly native: boolean;
  readonly symbol: string;
  /** In base units (wei, lamports, sun). */
  readonly balance: string;
  readonly decimals: number;
}
