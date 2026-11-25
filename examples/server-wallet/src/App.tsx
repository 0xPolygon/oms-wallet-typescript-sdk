import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@ui-sdk/react/alert-dialog';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@ui-sdk/react/collapsible';
import { Field, FieldDescription, FieldLabel } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import { Listbox, ListboxItem } from '@ui-sdk/react/listbox';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover';
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem
} from '@ui-sdk/react/segmented-control';
import { Switch, SwitchThumb } from '@ui-sdk/react/switch';
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastRegion,
  ToastTitle,
  toast
} from '@ui-sdk/react/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@ui-sdk/react/tooltip';

import type {
  DemoConfig,
  DemoEvent,
  DemoUser,
  Family,
  Mode,
  OperationView,
  UserDetail
} from '../shared';
import { call } from './api';
import { codeFor, plainMethod, SETUP_CODE } from './explain';
import { FLOWS, type Flow, type FlowHelpers } from './flows';

const FAMILIES: Family[] = ['evm', 'solana', 'tron'];
const FAMILY_LABEL: Record<Family, string> = {
  evm: 'EVM · Amoy',
  solana: 'Solana · devnet',
  tron: 'Tron · Nile'
};
const FAUCETS: Record<Family, string> = {
  evm: 'https://faucet.polygon.technology/',
  solana: 'https://faucet.solana.com/',
  tron: 'https://nileex.io/join/getJoinPage'
};

function showError(failure: unknown) {
  const message = failure instanceof Error ? failure.message : String(failure);
  const [code, ...rest] = message.split(': ');
  toast.error(rest.length ? code! : 'Request failed', {
    description: rest.join(': ') || message
  });
}

export function App() {
  const [config, setConfig] = useState<DemoConfig>();
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<UserDetail>();
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [busy, setBusy] = useState<string>();

  const loadUsers = useCallback(
    () =>
      call<DemoUser[]>('/api/users').then((list) => {
        setUsers(list);
        setSelected((current) => current ?? list[0]?.subject);
      }),
    []
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const loadDetail = useCallback(async (subject = selectedRef.current) => {
    if (!subject) return undefined;
    const next = await call<UserDetail>(`/api/users/${encodeURIComponent(subject)}`);
    if (subject === selectedRef.current) setDetail(next);
    return next;
  }, []);

  useEffect(() => {
    void call<DemoConfig>('/api/config').then(setConfig);
    void loadUsers();
  }, [loadUsers]);
  useEffect(() => {
    void loadDetail(selected);
  }, [selected, loadDetail]);

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as DemoEvent;
      if (event.kind === 'reset') {
        setEvents([]);
        setSelected(undefined);
        setDetail(undefined);
        void loadUsers();
        return;
      }
      setEvents((current) =>
        current.some((e) => e.id === event.id) ? current : [...current.slice(-599), event]
      );
      if (
        event.subject === selectedRef.current &&
        (event.kind === 'operation' || (event.kind === 'action' && event.phase !== 'start'))
      )
        void loadDetail(event.subject);
    };
    return () => source.close();
  }, [loadDetail]);

  async function run(label: string, task: () => Promise<unknown>) {
    setBusy(label);
    try {
      await task();
      return true;
    } catch (failure) {
      showError(failure);
      return false;
    } finally {
      setBusy(undefined);
      void loadUsers();
      void loadDetail();
    }
  }

  // Keep showing the last user's panel until the selected one has loaded, so switching never
  // flashes an empty card.
  const stale = !!detail && detail.user.subject !== selected;

  return (
    <div className="page">
      <ToastRegion>
        {() => (
          <Toast>
            <div className="stack">
              <ToastTitle />
              <ToastDescription />
            </div>
            <ToastClose aria-label="Dismiss">✕</ToastClose>
          </Toast>
        )}
      </ToastRegion>
      <header className="top">
        <div className="title">
          <p className="eyebrow">OMS Server Wallet SDK · live demo</p>
          <h1>Custodial wallets, traced live</h1>
          <p className="model">
            Your server signs each user in with an ID token it mints. <b>WaaS</b>, a signer in an
            AWS Nitro enclave, holds the keys and proves every reply with an attestation. The trace
            on the right shows each step.
          </p>
        </div>
        <div className="row">
          <span className="sandbox">Shared testnet sandbox</span>
          <Popover>
            <PopoverTrigger className="link">Connection &amp; setup</PopoverTrigger>
            <PopoverContent className="popover">
              <PopoverTitle>Connection</PopoverTitle>
              <dl>
                <dt>ID token issuer</dt>
                <dd>
                  <code>{config?.issuer ?? '…'}</code>
                </dd>
                <dt>Networks</dt>
                <dd>Polygon Amoy (sponsored), Solana devnet, Tron Nile</dd>
                <dt>Approval</dt>
                <dd>
                  <code>allow-immediate</code> here, so “Send now” exists. The SDK default is{' '}
                  <code>two-phase</code>: quote, approve, send.
                </dd>
              </dl>
              <pre className="code">{SETUP_CODE}</pre>
            </PopoverContent>
          </Popover>
        </div>
      </header>
      <main className="columns">
        <UsersPanel
          config={config}
          onReset={(key) => void run('reset', () => call('/api/reset', { key }))}
          users={users}
          selected={selected}
          busy={busy}
          onSelect={setSelected}
          onCreate={(name, mode) =>
            void run('create', async () => {
              const user = await call<DemoUser>('/api/users', { name, mode });
              setSelected(user.subject);
            })
          }
        />
        {detail ? (
          <UserPanel
            key={detail.user.subject}
            detail={detail}
            stale={stale}
            busy={busy}
            users={users}
            run={run}
            reload={async () => (await loadDetail(detail.user.subject))!}
          />
        ) : (
          <section className="card empty">
            <p className="muted">
              {selected
                ? 'Loading…'
                : 'Create a user. Each one gets an EVM, Solana and Tron wallet.'}
            </p>
          </section>
        )}
        <TracePanel events={events} selected={selected} users={users} />
      </main>
    </div>
  );
}

function UsersPanel(props: {
  config?: DemoConfig;
  onReset(key: string): void;
  users: DemoUser[];
  selected?: string;
  busy?: string;
  onSelect(subject: string): void;
  onCreate(name: string, mode: Mode): void;
}) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<Mode>('durable');
  const [resetKey, setResetKey] = useState('');
  const max = props.config?.maxUsers;
  const full = max !== undefined && props.users.length >= max;
  return (
    <section className="card users">
      <div className="users-head">
        <h2>Users</h2>
        {max !== undefined && (
          <span className="users-count">
            <span className={`muted small ${full ? 'urgent' : ''}`}>
              {props.users.length} / {max}
            </span>
            <Hint
              text={`Demo only: this public sandbox stops at ${max} users because each one creates real testnet wallets. The SDK has no user limit.`}
            >
              <button type="button" className="limit-hint" aria-label="About the user limit">
                ?
              </button>
            </Hint>
          </span>
        )}
      </div>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          props.onCreate(name, mode);
          setName('');
        }}
      >
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="alice"
            required
          />
        </Field>
        <Field>
          <FieldLabel>Mode</FieldLabel>
          <SegmentedControl
            className="segmented"
            value={mode}
            onValueChange={(value) => value && setMode(value as Mode)}
          >
            <SegmentedControlIndicator />
            <SegmentedControlItem value="durable">Durable</SegmentedControlItem>
            <SegmentedControlItem value="memory">In-memory</SegmentedControlItem>
          </SegmentedControl>
          <FieldDescription>
            {mode === 'durable'
              ? 'The SDK keeps an encrypted record of every call in your database. It survives restarts.'
              : 'The SDK saves nothing. Your app keeps the receipts (txnIds) it needs.'}
          </FieldDescription>
        </Field>
        <button className="primary" disabled={!!props.busy || full}>
          {props.busy === 'create' ? 'Creating…' : 'Create user + wallets'}
        </button>
        {full && <p className="hint urgent">The sandbox is full. Reset it to start over.</p>}
      </form>
      {props.users.length > 0 && (
        <Listbox
          aria-label="Users"
          className="user-list"
          value={props.selected ?? null}
          onValueChange={(value) => value && props.onSelect(value as string)}
        >
          {props.users.map((user) => (
            <ListboxItem key={user.subject} value={user.subject}>
              <span>{user.name}</span>
              <ModeBadge mode={user.mode} />
            </ListboxItem>
          ))}
        </Listbox>
      )}
      <AlertDialog>
        <AlertDialogTrigger className="link reset" disabled={!!props.busy}>
          Reset sandbox
        </AlertDialogTrigger>
        <AlertDialogContent className="dialog">
          <AlertDialogTitle>Reset the sandbox?</AlertDialogTitle>
          <AlertDialogDescription>
            Removes every user, record and trace here, for everyone using this demo, and ends the
            in-memory sessions. The wallets stay in WaaS: create a user with the same name and mode
            to get the same addresses back.
          </AlertDialogDescription>
          {props.config?.resetNeedsKey && (
            <Input
              aria-label="Reset key"
              type="password"
              value={resetKey}
              onChange={(e) => setResetKey(e.target.value)}
              placeholder="Reset key"
            />
          )}
          <div className="row end">
            <AlertDialogClose>Cancel</AlertDialogClose>
            <AlertDialogClose
              className="danger"
              value="confirm"
              onClick={() => props.onReset(resetKey)}
            >
              Reset
            </AlertDialogClose>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function Hint(props: { text: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipContent className="tooltip">{props.text}</TooltipContent>
    </Tooltip>
  );
}

function ModeBadge({ mode }: { mode: Mode }) {
  return <span className={`badge ${mode}`}>{mode === 'durable' ? 'durable' : 'in-memory'}</span>;
}

function Action(props: {
  label: string;
  code: string;
  hint: string;
  onClick(): void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Hint text={props.hint}>
      <button
        className={`action-button ${props.className ?? ''}`}
        onClick={props.onClick}
        disabled={props.disabled}
      >
        <span>{props.label}</span>
        <code>{props.code}</code>
      </button>
    </Hint>
  );
}

type Balance = { chain: string; symbol: string; balance: string; decimals: number };

function UserPanel(props: {
  detail: UserDetail;
  stale: boolean;
  users: DemoUser[];
  busy?: string;
  run(label: string, task: () => Promise<unknown>): Promise<boolean>;
  reload(): Promise<UserDetail>;
}) {
  const { user, session, operations, ledger, store } = props.detail;
  const [family, setFamily] = useState<Family>('evm');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [balances, setBalances] = useState<Balance[]>();
  const path = `/api/users/${encodeURIComponent(user.subject)}`;
  const post = <T,>(name: string, body: Record<string, unknown> = {}) =>
    call<T>(`${path}/${name}`, body);
  const act = (name: string, body: Record<string, unknown> = {}) =>
    void props.run(name, () => post(name, body));
  const others = props.users.filter(
    (other) => other.subject !== user.subject && other.wallets[family]
  );
  const hasWallets = Object.keys(user.wallets).length > 0;
  const busy = !!props.busy;
  const transfer = family === 'evm' ? { family } : { family, to, amount };
  const memory = user.mode === 'memory';

  return (
    <section className={`card user ${props.stale ? 'stale' : ''}`} aria-busy={props.stale}>
      <div className="user-head">
        <div>
          <h2>
            {user.name} <ModeBadge mode={user.mode} />
          </h2>
          <p className="muted small">
            <code>{user.subject}</code> · <SessionStatus session={session} />
          </p>
        </div>
        <div className="row">
          <Action
            label={memory ? (hasWallets ? 'Sign back in' : 'Create wallets') : 'Create or restore'}
            code={memory ? (hasWallets ? 'restore()' : 'create()') : 'createOrRestore()'}
            hint={
              memory
                ? hasWallets
                  ? 'Signs in with a fresh ID token and reconnects to the same wallets. Never creates new ones.'
                  : 'Signs in and creates the EVM, Solana and Tron wallets.'
                : 'Reconnects to the wallets WaaS holds for this user, creating any that are missing.'
            }
            onClick={() => act('setup')}
            disabled={busy}
          />
          <Action
            label="Rotate credential"
            code="rotateCredential()"
            hint="Ends this user's WaaS session and starts a new one. Quotes made in the old session can no longer be sent."
            onClick={() => act('rotate')}
            disabled={busy || !hasWallets}
          />
          <Action
            className="warn"
            label={memory ? 'Simulate restart' : session.disabled ? 'Enable' : 'Disable'}
            code={memory ? 'evict()' : session.disabled ? 'enable()' : 'disable()'}
            hint={
              memory
                ? 'Throws the handle away, as a server restart would: the session ends and its records are gone. The wallets stay in WaaS.'
                : session.disabled
                  ? 'Allows calls again.'
                  : 'The kill switch: every call for this user is refused until you enable it.'
            }
            onClick={() => act('toggle')}
            disabled={busy}
          />
        </div>
      </div>

      <FlowPanel
        flows={FLOWS.filter((flow) => flow.mode === user.mode)}
        helpers={{ post, reload: props.reload }}
        busy={busy}
        run={props.run}
        disabled={!hasWallets}
      />

      <div className="wallets">
        {FAMILIES.map((f) => (
          <div key={f} className="wallet">
            <span className="label">{FAMILY_LABEL[f]}</span>
            <code title={user.wallets[f]}>{user.wallets[f] ?? '—'}</code>
            <a href={FAUCETS[f]} target="_blank" rel="noreferrer">
              faucet
            </a>
          </div>
        ))}
      </div>
      <div className="row">
        <button
          onClick={() =>
            void props.run('balances', () => post<Balance[]>('balances').then(setBalances))
          }
          disabled={busy || !hasWallets}
        >
          Read balances
        </button>
        {FAMILIES.map((f) => (
          <button key={f} onClick={() => act('sign', { family: f })} disabled={busy || !hasWallets}>
            Sign {f}
          </button>
        ))}
        <Hint
          text={
            memory
              ? 'Two signatures at once. One handle runs one call at a time, inside this process only.'
              : "Two signatures at once. They queue for this user's lock: watch the Lock lane."
          }
        >
          <button
            onClick={() =>
              void props.run('burst', () =>
                Promise.all([post('sign', { family: 'evm' }), post('sign', { family: 'evm' })])
              )
            }
            disabled={busy || !hasWallets}
          >
            Run 2 at once
          </button>
        </Hint>
      </div>
      {balances && (
        <div className="balances">
          {balances.length === 0 && <span className="muted small">No balances yet.</span>}
          {balances.map((b) => (
            <span key={`${b.chain}-${b.symbol}`} className="pill">
              {formatUnits(b.balance, b.decimals)} {b.symbol} <small>{b.chain}</small>
            </span>
          ))}
          <span className="hint">From the indexer: not attested, for display only.</span>
        </div>
      )}

      <div className="send">
        <SegmentedControl
          aria-label="Network"
          className="segmented"
          value={family}
          onValueChange={(value) => {
            if (!value) return;
            setFamily(value as Family);
            setTo('');
            setAmount('');
          }}
        >
          <SegmentedControlIndicator />
          {FAMILIES.map((f) => (
            <SegmentedControlItem key={f} value={f}>
              {FAMILY_LABEL[f]}
              {f !== 'evm' && <small className="muted"> · needs faucet</small>}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        {family === 'evm' ? (
          <p className="hint">A sponsored zero-value call on Amoy: needs no funds.</p>
        ) : (
          <div className="row">
            <input
              list="recipients"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder={`to (default: own ${family} address)`}
            />
            <datalist id="recipients">
              {others.map((other) => (
                <option key={other.subject} value={other.wallets[family]}>
                  {other.name}
                </option>
              ))}
            </datalist>
            <input
              className="amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={family === 'solana' ? '1000000 lamports' : '1 sun'}
            />
          </div>
        )}
        <div className="row">
          <Action
            className="primary"
            label="Get a quote"
            code="prepare…()"
            hint="WaaS prices the transaction and returns a reviewId. Nothing is sent until you approve."
            onClick={() => act('prepare', transfer)}
            disabled={busy || !hasWallets}
          />
          <Action
            label="Send now"
            code="send…({ onPrepared })"
            hint="Quote and send in one call. onPrepared runs in between, so your app can save the txnId first."
            onClick={() => act('send', transfer)}
            disabled={busy || !hasWallets}
          />
        </div>
      </div>

      <section className="records">
        <h3>
          Operations <span className="count">{operations.length}</span>
        </h3>
        <p className="hint">
          {memory
            ? 'Kept by this handle only. After “Simulate restart” they are gone.'
            : 'Kept in the encrypted store: they survive restarts.'}
        </p>
        <div className="operations">
          {operations.map((op) => (
            <Operation
              key={op.id}
              op={op}
              busy={busy}
              onExecute={() =>
                act('execute', { family: op.family, idempotencyKey: op.id, reviewId: op.reviewId })
              }
              onCancel={() => act('cancel', { family: op.family, idempotencyKey: op.id })}
              onRetry={() => act('retry', { idempotencyKey: op.id })}
            />
          ))}
        </div>
      </section>

      {memory ? (
        <section className="records">
          <h3>
            App ledger <span className="count">{ledger.length}</span>
          </h3>
          <p className="hint">
            Your own database: the receipt (txnId) of each transaction, saved before it is sent. It
            outlives the handle, so you can always ask WaaS what happened.
          </p>
          <table className="table">
            <tbody>
              {ledger.map((entry) => (
                <tr key={entry.txnId}>
                  <td>{entry.family}</td>
                  <td>
                    <code>{short(entry.txnId)}</code>
                  </td>
                  <td>
                    {entry.outcome ?? '—'}
                    {entry.txnHash && (
                      <>
                        {' '}
                        <a
                          href={explorer(entry.family, entry.txnHash)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {short(entry.txnHash)} ↗
                        </a>
                      </>
                    )}
                  </td>
                  <td>
                    <button onClick={() => act('recover', { txnId: entry.txnId })} disabled={busy}>
                      Check receipt
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <section className="records">
          <h3>
            Encrypted store <span className="count">{store.length}</span>
          </h3>
          <p className="hint">
            What your database holds: AES-256-GCM ciphertext, readable only with your encryption key
            and only for this user.
          </p>
          <table className="table">
            <tbody>
              {store.map((entry) => (
                <tr key={entry.key}>
                  <td>
                    <code>{entry.key}</code>
                  </td>
                  <td className="cipher">
                    <code>{entry.preview}…</code>
                  </td>
                  <td>{entry.writes} writes</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </section>
  );
}

function SessionStatus({ session }: { session: UserDetail['session'] }) {
  if (session.disabled) return <span className="state off">disabled</span>;
  if (!session.signedIn) return <span className="state">not signed in</span>;
  return (
    <span className="state on">
      signed in until{' '}
      {new Date(session.expiresAt!).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
    </span>
  );
}

type StepState = 'pending' | 'done' | 'failed';

function FlowPanel(props: {
  flows: Flow[];
  helpers: FlowHelpers;
  busy: boolean;
  disabled: boolean;
  run(label: string, task: () => Promise<unknown>): Promise<boolean>;
}) {
  const [flowId, setFlowId] = useState<string>();
  const [states, setStates] = useState<StepState[]>([]);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const memo = useRef({});
  const flow = props.flows.find((candidate) => candidate.id === flowId);
  const next = states.findIndex((state) => state !== 'done');

  function pick(id: string) {
    const picked = props.flows.find((candidate) => candidate.id === id)!;
    setFlowId(id);
    setStates(picked.steps.map(() => 'pending'));
    setNotes({});
    memo.current = {};
  }

  async function runStep(index: number) {
    const step = flow!.steps[index]!;
    const ok = await props.run(`flow-${index}`, async () => {
      try {
        const note = await step.run(props.helpers, memo.current);
        if (note) setNotes((n) => ({ ...n, [index]: note }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!step.expect || !message.startsWith(step.expect)) throw error;
        setNotes((n) => ({ ...n, [index]: `Refused as expected: ${step.expect}` }));
      }
    });
    setStates((s) => s.map((state, i) => (i === index ? (ok ? 'done' : 'failed') : state)));
    return ok;
  }

  async function runAll() {
    for (let index = Math.max(0, next); index < flow!.steps.length; index++)
      if (!(await runStep(index))) return;
  }

  return (
    <div className="flows">
      <div className="row">
        <span className="label">Try a flow</span>
        {props.flows.map((candidate) => (
          <button
            key={candidate.id}
            className={`chip ${candidate.id === flowId ? 'on' : ''}`}
            onClick={() => (candidate.id === flowId ? setFlowId(undefined) : pick(candidate.id))}
          >
            {candidate.title}
          </button>
        ))}
      </div>
      {flow && (
        <div className="flow">
          <p className="flow-why">{flow.why}</p>
          <ol>
            {flow.steps.map((step, index) => (
              <li
                key={step.label}
                className={index === next ? `${states[index]} next` : states[index]}
              >
                <div>
                  <strong>{step.label}</strong>
                  <p className="hint">{notes[index] ?? step.explain}</p>
                </div>
                {index === next && (
                  <button
                    className="primary"
                    onClick={() => void runStep(index)}
                    disabled={props.busy || props.disabled}
                  >
                    {states[index] === 'failed' ? 'Retry' : 'Run'}
                  </button>
                )}
              </li>
            ))}
          </ol>
          {next !== -1 ? (
            <button onClick={() => void runAll()} disabled={props.busy || props.disabled}>
              Run the rest
            </button>
          ) : (
            <p className="takeaway">{flow.takeaway}</p>
          )}
        </div>
      )}
    </div>
  );
}

const FLOW = ['preparing', 'quoted', 'submitting', 'pending', 'executed'];
const BAD = ['failed', 'expired', 'unknown'];

function Operation(props: {
  op: OperationView;
  busy: boolean;
  onExecute(): void;
  onCancel(): void;
  onRetry(): void;
}) {
  const { op } = props;
  const signing = op.kind.startsWith('sign');
  const steps = signing ? ['preparing', 'signed'] : FLOW;
  const stopped = BAD.includes(op.status) || op.status === 'cancelled';
  const reached = stopped ? (op.txnHash ? 3 : op.txnId ? 2 : 1) : steps.indexOf(op.status);
  const left = useCountdown(op.status === 'quoted' ? op.expiresAt : undefined);
  return (
    <div className={`operation ${BAD.includes(op.status) ? 'bad' : ''}`}>
      <div className="op-head">
        <strong>
          {op.family} {op.kind}
        </strong>
        <span className="muted small">{op.chain}</span>
        <code className="muted small" title="idempotencyKey">
          {op.id}
        </code>
      </div>
      <ol className="stepper">
        {steps.map((step, index) => (
          <li
            key={step}
            className={index < reached ? 'done' : index === reached && !stopped ? 'current' : ''}
          >
            {step}
          </li>
        ))}
        {stopped && (
          <li className={`current ${op.status === 'cancelled' ? 'neutral' : 'bad'}`}>
            {op.status}
          </li>
        )}
      </ol>
      <div className="op-meta">
        {op.txnId && (
          <span title="WaaS transaction ID: the receipt number">
            txnId <code>{short(op.txnId)}</code>
          </span>
        )}
        {op.reviewId && op.status === 'quoted' && (
          <span title="Binds sending to exactly these quoted terms">
            reviewId <code>{short(op.reviewId)}</code>
          </span>
        )}
        {left !== undefined && (
          <span className={left < 15 ? 'urgent' : ''}>quote expires in {left}s</span>
        )}
        {op.signature && (
          <span title={op.signature}>
            signature <code>{short(op.signature)}</code>, verified by WaaS
          </span>
        )}
        {op.explorer && (
          <a href={op.explorer} target="_blank" rel="noreferrer">
            {short(op.txnHash!)} ↗
          </a>
        )}
        {op.error && <span className="urgent">{op.error}</span>}
        {op.provenUnsent && <span>nothing was sent (provenUnsent)</span>}
      </div>
      <p className="next">
        <span className={`next-action ${op.next.action}`}>{op.next.action}</span> {op.next.reason}
      </p>
      <div className="row">
        {op.status === 'quoted' && (
          <>
            <button className="primary" onClick={props.onExecute} disabled={props.busy}>
              Approve &amp; send
            </button>
            <button onClick={props.onCancel} disabled={props.busy}>
              Cancel
            </button>
          </>
        )}
        {!signing && (
          <Hint text="Calls again with the same idempotencyKey. A durable wallet returns this same operation and sends nothing twice.">
            <button onClick={props.onRetry} disabled={props.busy}>
              Retry same key
            </button>
          </Hint>
        )}
      </div>
    </div>
  );
}

const LANES = [
  { id: 'app', label: 'Server' },
  { id: 'lock', label: 'Lock' },
  { id: 'store', label: 'Store' },
  { id: 'waas', label: 'WaaS' },
  { id: 'indexer', label: 'Indexer' }
] as const;

type ActionEvent = Extract<DemoEvent, { kind: 'action' }>;
type Group = { id: number; start?: ActionEvent; end?: ActionEvent; events: DemoEvent[] };

function TracePanel(props: { events: DemoEvent[]; selected?: string; users: DemoUser[] }) {
  const [onlySelected, setOnlySelected] = useState(true);
  const [toggled, setToggled] = useState<Record<number, boolean>>({});
  const names = useMemo(
    () => Object.fromEntries(props.users.map((u) => [u.subject, u.name])),
    [props.users]
  );
  const groups = useMemo(() => {
    const byAction = new Map<number, Group>();
    for (const event of props.events) {
      if (onlySelected && event.subject !== props.selected) continue;
      if (event.action === undefined) continue;
      const group = byAction.get(event.action) ?? { id: event.action, events: [] };
      byAction.set(event.action, group);
      if (event.kind === 'action' && event.phase === 'start') group.start = event;
      else if (event.kind === 'action') group.end = event;
      else group.events.push(event);
    }
    return [...byAction.values()].filter((group) => group.start).slice(-60);
  }, [props.events, onlySelected, props.selected]);
  const latest = groups.at(-1)?.id;

  const body = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    if (pinned.current && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [props.events.length]);

  return (
    <section className="card trace">
      <div className="trace-head">
        <h2>Live trace</h2>
        <label className="small switch-label">
          Selected user only
          <Switch checked={onlySelected} onCheckedChange={setOnlySelected}>
            <SwitchThumb />
          </Switch>
        </label>
      </div>
      <div
        className="trace-body"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {groups.map((group) => (
          <ActionCard
            key={group.id}
            group={group}
            name={names[group.start!.subject ?? ''] ?? group.start!.subject ?? ''}
            open={toggled[group.id] ?? group.id === latest}
            onOpenChange={(open) => setToggled((t) => ({ ...t, [group.id]: open }))}
          />
        ))}
        {groups.length === 0 && (
          <p className="muted small pad">
            Run an action: every call your server makes shows up here, grouped by action.
          </p>
        )}
      </div>
    </section>
  );
}

function ActionCard(props: {
  group: Group;
  name: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { group } = props;
  const start = group.start!;
  const end = group.end;
  const waas = group.events.filter((e) => e.kind === 'waas');
  const attested = waas.every((e) => e.kind === 'waas' && e.attested);
  const writes = group.events.filter((e) => e.kind === 'store').length;
  const waited = group.events.reduce(
    (max, e) => (e.kind === 'lock' && e.waitedMs ? Math.max(max, e.waitedMs) : max),
    0
  );
  const [showCode, setShowCode] = useState(false);
  const code = codeFor(start.name, start.mode);
  return (
    <Collapsible
      className={`action-card ${end?.phase ?? 'running'}`}
      open={props.open}
      onOpenChange={(open) => props.onOpenChange(open)}
    >
      <CollapsibleTrigger className="action-head">
        <span className={`result ${end?.phase ?? 'running'}`}>
          {end?.phase === 'error' ? '✕' : end ? '✓' : '…'}
        </span>
        <span className="action-title">
          <strong>{props.name}</strong> {start.name}
        </span>
        <span className="summary">
          {waas.length > 0 && (
            <span>
              {waas.length} WaaS{attested ? ' · attested' : ''}
            </span>
          )}
          {writes > 0 && <span>{writes} saves</span>}
          {waited > 0 && <span className="lock-wait">waited {waited}ms</span>}
          <span>{end ? `${end.at - start.at}ms` : 'running'}</span>
        </span>
        <span className="time">{time(start.at)}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel className="action-body">
        {end?.detail && <p className={`outcome ${end.phase}`}>{end.detail}</p>}
        {start.mode === 'memory' && (
          <p className="hint">In-memory: no lock and no store, by design. Only WaaS is called.</p>
        )}
        <div className="lanes header">
          <span />
          {LANES.map((lane) => (
            <span
              key={lane.id}
              className={`lane-title ${lane.id} ${start.mode === 'memory' && (lane.id === 'lock' || lane.id === 'store') ? 'dim' : ''}`}
            >
              {lane.label}
            </span>
          ))}
          <span />
        </div>
        {group.events.map((event) => {
          const target = LANES.findIndex((lane) => lane.id === event.lane);
          return (
            <div key={event.id} className={`lanes ${tone(event)}`}>
              <span className="time">{time(event.at)}</span>
              {LANES.map((lane, index) => (
                <span
                  key={lane.id}
                  className={`cell ${lane.id} ${index === 0 && target > 0 ? 'from' : ''} ${index > 0 && index < target ? 'through' : ''} ${index === target ? 'hit' : ''}`}
                >
                  {index === target && <i className="marker" />}
                </span>
              ))}
              <span className="text">
                <Describe event={event} />
              </span>
            </div>
          );
        })}
        {code && (
          <div className="code-peek">
            <button className="link" onClick={() => setShowCode((v) => !v)}>
              {showCode ? 'Hide SDK code' : 'Show SDK code'}
            </button>
            {showCode && <pre className="code">{code}</pre>}
          </div>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}

function tone(event: DemoEvent) {
  if (event.kind === 'waas' || event.kind === 'indexer') return event.status >= 400 ? 'bad' : '';
  if (event.kind === 'operation') {
    if (['executed', 'signed'].includes(event.operation.status)) return 'good';
    if (['failed', 'unknown', 'expired'].includes(event.operation.status)) return 'bad';
  }
  return '';
}

function Describe({ event }: { event: DemoEvent }) {
  switch (event.kind) {
    case 'action':
      return null;
    case 'hook':
      return (
        <>
          <b>{event.name}</b> <span className="muted">{event.detail}</span>
        </>
      );
    case 'operation':
      return (
        <>
          Operation is now <b>{event.operation.status}</b>
          {event.operation.txnId ? (
            <span className="muted"> · txnId {short(event.operation.txnId)}</span>
          ) : null}
        </>
      );
    case 'lock':
      return event.phase === 'queued' ? (
        <>Wait for this user's lock</>
      ) : event.phase === 'acquired' ? (
        <>Lock acquired{event.waitedMs ? ` after waiting ${event.waitedMs}ms` : ''}</>
      ) : (
        <>Lock released after {event.heldMs}ms</>
      );
    case 'store':
      return (
        <>
          Save <code>{event.key}</code>{' '}
          <span className="muted">
            {event.bytes}B ciphertext {event.preview.slice(0, 16)}…
          </span>
        </>
      );
    case 'waas':
      return (
        <>
          <b>{plainMethod(event.method)}</b> <span className="muted">{event.method}</span>{' '}
          <Latency ms={event.ms} />{' '}
          {event.attested && (
            <span
              className="attested"
              title="The reply carried an AWS Nitro attestation. Before using it, the SDK checks the enclave measurement (PCR0), the signature, freshness, and that it answers this exact request. A failed check fails the action."
            >
              attestation
            </span>
          )}
        </>
      );
    case 'indexer':
      return (
        <>
          <b>Read balances</b> <span className="muted">{event.method}</span>{' '}
          <Latency ms={event.ms} /> <span className="muted">not attested</span>
        </>
      );
  }
}

function Latency({ ms }: { ms: number }) {
  return (
    <span className="latency">
      <i style={{ width: `${Math.max(2, Math.min(40, ms / 25))}px` }} />
      {ms}ms
    </span>
  );
}

function useCountdown(until?: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return until ? Math.max(0, Math.round((Date.parse(until) - now) / 1000)) : undefined;
}

function explorer(family: Family, hash: string) {
  return family === 'evm'
    ? `https://amoy.polygonscan.com/tx/${hash}`
    : family === 'solana'
      ? `https://explorer.solana.com/tx/${hash}?cluster=devnet`
      : `https://nile.tronscan.org/#/transaction/${hash}`;
}
const short = (value: string) =>
  value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });
function formatUnits(value: string, decimals: number) {
  const padded = value.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals || undefined);
  const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, '') : '';
  return fraction ? `${whole}.${fraction.slice(0, 6)}` : whole;
}
