import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@ui-sdk/react/alert-dialog';
import { Field, FieldDescription, FieldLabel } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import { Listbox, ListboxItem } from '@ui-sdk/react/listbox';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover';
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem
} from '@ui-sdk/react/segmented-control';
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastRegion,
  ToastTitle,
  toast
} from '@ui-sdk/react/toast';

import type { DemoConfig, DemoEvent, DemoUser, Mode, UserDetail } from '../shared';
import { call } from './api';
import { SETUP_CODE } from './explain';
import { TracePanel } from './Trace';
import { CopyButton, Hint, ModeBadge } from './ui';
import { UserPanel } from './UserPanel';

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
            AWS Nitro enclave, holds the keys and proves every reply with an attestation. Pick a
            user, try a flow, and watch each step in the live trace.
          </p>
        </div>
        <div className="row">
          <span className="sandbox">Shared testnet sandbox</span>
          <Popover>
            <PopoverTrigger className="link">Connection &amp; setup</PopoverTrigger>
            <PopoverContent className="popover" align="end" collisionPadding={16}>
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
              <div className="code-block">
                <CopyButton value={SETUP_CODE} />
                <pre className="code">{SETUP_CODE}</pre>
              </div>
              <p className="links">
                <a
                  href="https://www.npmjs.com/package/@polygonlabs/oms-server-wallet-sdk"
                  target="_blank"
                  rel="noreferrer"
                >
                  npm package ↗
                </a>
                <a
                  href="https://github.com/0xPolygon/oms-wallet-typescript-sdk/tree/master/packages/oms-server-wallet"
                  target="_blank"
                  rel="noreferrer"
                >
                  SDK README ↗
                </a>
                <a
                  href="https://github.com/0xPolygon/oms-wallet-typescript-sdk/tree/master/examples/server-wallet"
                  target="_blank"
                  rel="noreferrer"
                >
                  This demo's code ↗
                </a>
              </p>
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
            config={config}
            busy={busy}
            users={users}
            run={run}
            reload={async () => (await loadDetail(detail.user.subject))!}
          />
        ) : (
          <Launchpad
            loading={!!selected}
            busy={busy}
            onStart={(people) =>
              void run('create', async () => {
                for (const person of people) await call<DemoUser>('/api/users', person);
                setSelected(`demo:${people[0]!.mode}:${people[0]!.name}`);
              })
            }
          />
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

function Launchpad(props: {
  loading: boolean;
  busy?: string;
  onStart(people: { name: string; mode: Mode }[]): void;
}) {
  if (props.loading)
    return (
      <section className="card empty">
        <p className="muted">Loading…</p>
      </section>
    );
  const busy = !!props.busy;
  return (
    <section className="card launchpad">
      <h2>Start the demo</h2>
      <p className="muted">
        Each user gets an EVM, a Solana and a Tron wallet. The SDK runs in one of two modes, so the
        fastest way to see the difference is one user of each.
      </p>
      <button
        className="primary big"
        disabled={busy}
        onClick={() =>
          props.onStart([
            { name: 'alice', mode: 'durable' },
            { name: 'bob', mode: 'memory' }
          ])
        }
      >
        {props.busy === 'create' ? 'Creating…' : 'Create alice (durable) and bob (in-memory)'}
      </button>
      <div className="modes">
        <div className="mode-card">
          <ModeBadge mode="durable" />
          <p>
            The SDK keeps an encrypted record of every call in your database and runs one call at a
            time per user. Retries, history and the kill switch survive restarts.
          </p>
          <button
            disabled={busy}
            onClick={() => props.onStart([{ name: 'alice', mode: 'durable' }])}
          >
            Create alice only
          </button>
        </div>
        <div className="mode-card">
          <ModeBadge mode="memory" />
          <p>
            No database and no lock. Your app saves each transaction's receipt (txnId) and can
            always ask WaaS what happened, even after a restart.
          </p>
          <button disabled={busy} onClick={() => props.onStart([{ name: 'bob', mode: 'memory' }])}>
            Create bob only
          </button>
        </div>
      </div>
    </section>
  );
}
