import type { DemoUser, Mode, UserDetail } from '../shared';
import { short } from './ui';

export interface FlowHelpers {
  post<T = unknown>(action: string, body?: Record<string, unknown>): Promise<T>;
  reload(): Promise<UserDetail>;
}

type Quoted = { id: string; family: 'evm'; reviewId?: string; quote?: { txnId: string } };
type Memo = { op?: Quoted };

export interface Step {
  readonly label: string;
  readonly explain: string;
  /** An error code this step should get. Getting it counts as success. */
  readonly expect?: string;
  run(helpers: FlowHelpers, memo: Memo): Promise<string | void>;
}

export interface Flow {
  readonly id: string;
  readonly mode: Mode;
  readonly title: string;
  readonly why: string;
  readonly takeaway: string;
  readonly steps: readonly Step[];
}

const quote: Step = {
  label: 'Get a quote',
  explain: 'WaaS prices a sponsored call on Amoy and returns a reviewId. Nothing is sent.',
  async run(h, memo) {
    memo.op = await h.post<Quoted>('prepare', { family: 'evm' });
    return `Quoted. Its receipt number (txnId) is ${short(memo.op.quote?.txnId ?? '')}.`;
  }
};
const restart: Step = {
  label: 'Simulate a restart',
  explain: 'Drop the in-memory wallet handle, as a server crash or deploy would.',
  async run(h) {
    await h.post('toggle');
    return 'In-memory state cleared: the session ended and the Operations list is empty.';
  }
};
const signBackIn: Step = {
  label: 'Sign back in',
  explain: 'Sign in with a fresh ID token and reconnect to the same wallets.',
  async run(h) {
    const user = await h.post<DemoUser>('setup');
    return `Reconnected to the same wallets (EVM ${user.wallets.evm?.slice(0, 10)}…); nothing new was created.`;
  }
};

export const FLOWS: readonly Flow[] = [
  {
    id: 'approve',
    mode: 'durable',
    title: 'Approve before sending',
    why: 'Two steps: WaaS quotes the exact transaction, then your approver sends exactly that quote.',
    takeaway: 'The reviewId tied the send to the quoted terms; nothing else could have been sent.',
    steps: [
      quote,
      {
        label: 'Approve and send',
        explain: 'execute() with the reviewId sends exactly what was quoted.',
        async run(h, memo) {
          await h.post('execute', {
            family: 'evm',
            idempotencyKey: memo.op!.id,
            reviewId: memo.op!.reviewId
          });
        }
      },
      {
        label: 'Wait until it lands',
        explain: 'The SDK polls WaaS until the transaction is executed on chain.',
        async run(h, memo) {
          for (let tries = 0; tries < 40; tries++) {
            const op = (await h.reload()).operations.find((o) => o.id === memo.op!.id);
            if (op?.status === 'executed')
              return 'Confirmed on chain. The explorer link is on the operation card.';
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
          throw new Error('TIMEOUT: still not executed after 80s');
        }
      }
    ]
  },
  {
    id: 'kill',
    mode: 'durable',
    title: 'Kill switch',
    why: 'disable() stops every call for one user at once, for example while you investigate.',
    takeaway: 'While disabled, nothing could sign or send for this user.',
    steps: [
      {
        label: 'Disable the wallet',
        explain: 'The wallet is marked disabled and its WaaS session is ended.',
        async run(h) {
          if (!(await h.reload()).session.disabled) await h.post('toggle');
        }
      },
      {
        label: 'Try to sign',
        explain: 'Any call is refused.',
        expect: 'WALLET_DISABLED',
        run: (h) =>
          h.post('sign', { family: 'evm' }).then(() => {
            throw new Error('UNEXPECTED: the call went through');
          })
      },
      {
        label: 'Enable it again',
        explain: 'enable() allows calls again.',
        async run(h) {
          if ((await h.reload()).session.disabled) await h.post('toggle');
        }
      }
    ]
  },
  {
    id: 'rotate',
    mode: 'durable',
    title: 'Old quotes die with the session',
    why: 'Only the session that made a quote can send it. Rotating the credential voids open quotes.',
    takeaway: 'The old quote could not be sent, and the SDK proved nothing went out.',
    steps: [
      quote,
      {
        label: 'Rotate the credential',
        explain: 'End the WaaS session and start a new one.',
        run: (h) => h.post('rotate').then(() => undefined)
      },
      {
        label: 'Try to send the old quote',
        explain: 'execute() refuses: the quote belongs to the old session.',
        expect: 'CREDENTIAL_CHANGED',
        run: (h, memo) =>
          h
            .post('execute', {
              family: 'evm',
              idempotencyKey: memo.op!.id,
              reviewId: memo.op!.reviewId
            })
            .then(() => {
              throw new Error('UNEXPECTED: the old quote was sent');
            })
      }
    ]
  },
  {
    id: 'retry',
    mode: 'durable',
    title: 'Safe retries',
    why: 'Every call takes an idempotencyKey. Retrying with the same key never does the work twice.',
    takeaway: 'Retries after a timeout or crash are safe: the stored operation comes back.',
    steps: [
      quote,
      {
        label: 'Retry with the same key',
        explain: 'Send the same call again, as you would after a timeout.',
        async run(h, memo) {
          const { reused } = await h.post<{ reused: boolean }>('retry', {
            idempotencyKey: memo.op!.id
          });
          return reused
            ? 'Returned the stored operation. No second quote was created.'
            : 'Created a new quote.';
        }
      }
    ]
  },
  {
    id: 'lock',
    mode: 'durable',
    title: 'One call at a time',
    why: "A durable user's calls take turns through a per-user call queue, so two servers never race.",
    takeaway: 'The second call waited for the first: its trace card says “waited”.',
    steps: [
      {
        label: 'Run two signatures at once',
        explain:
          'Both calls start together. Watch the Queue lane: the second one waits for the first to finish.',
        async run(h) {
          await Promise.all([h.post('sign', { family: 'evm' }), h.post('sign', { family: 'evm' })]);
        }
      }
    ]
  },
  {
    id: 'restart',
    mode: 'memory',
    title: 'Survive a restart',
    why: 'In-memory wallets lose local state on restart. The receipt your app saved is enough to find out what happened.',
    takeaway:
      'No SDK records survived the restart, yet the txnId from your own ledger told you the outcome.',
    steps: [
      {
        label: 'Send now',
        explain: 'onPrepared saves the txnId to your ledger before the transaction is sent.',
        async run(h, memo) {
          memo.op = await h.post<Quoted>('send', { family: 'evm' });
          return `Sent. Receipt ${short(memo.op.quote?.txnId ?? '')} is in your ledger.`;
        }
      },
      restart,
      signBackIn,
      {
        label: 'Check the receipt',
        explain: 'Ask WaaS about the saved txnId. No local record of the operation is needed.',
        async run(h, memo) {
          const entry = await h.post<{ outcome?: string }>('recover', {
            txnId: memo.op!.quote!.txnId
          });
          return `WaaS reported: ${entry.outcome}.`;
        }
      }
    ]
  },
  {
    id: 'memory-retry',
    mode: 'memory',
    title: 'Why your app keeps records',
    why: "In-memory idempotency lasts only until a restart. After that, the SDK can't recognize a retry.",
    takeaway:
      'After a restart, a retry created a new quote. Check your own ledger before retrying.',
    steps: [
      quote,
      restart,
      signBackIn,
      {
        label: 'Retry with the same key',
        explain: 'Send the same call again after the restart.',
        async run(h, memo) {
          const { reused } = await h.post<{ reused: boolean }>('retry', {
            idempotencyKey: memo.op!.id
          });
          return reused
            ? 'Returned the existing operation.'
            : 'Created a new quote: after the restart, the SDK had no record of this key.';
        }
      }
    ]
  }
];
