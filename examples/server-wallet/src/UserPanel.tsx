import { useRef, useState } from 'react';
import { Field, FieldDescription, FieldLabel } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem
} from '@ui-sdk/react/segmented-control';

import type { Balance, DemoConfig, DemoUser, Family, OperationView, UserDetail } from '../shared';
import { call } from './api';
import { sdkCall } from './explain';
import { FLOWS, type Flow, type FlowHelpers } from './flows';
import {
  Action,
  CHAIN,
  CopyButton,
  explorer,
  FAMILIES,
  FAUCETS,
  formatUnits,
  Hint,
  ModeBadge,
  parseUnits,
  short,
  useCountdown
} from './ui';

type Run = (label: string, task: () => Promise<unknown>) => Promise<boolean>;

export function UserPanel(props: {
  detail: UserDetail;
  stale: boolean;
  config?: DemoConfig;
  users: DemoUser[];
  busy?: string;
  run: Run;
  reload(): Promise<UserDetail>;
}) {
  const { user, session } = props.detail;
  const [balances, setBalances] = useState<Balance[]>();
  const path = `/api/users/${encodeURIComponent(user.subject)}`;
  const post = <T,>(name: string, body: Record<string, unknown> = {}) =>
    call<T>(`${path}/${name}`, body);
  const act = (name: string, body: Record<string, unknown> = {}) =>
    void props.run(name, () => post(name, body));
  const readBalances = () =>
    props.run('balances', () => post<Balance[]>('balances').then(setBalances));
  const hasWallets = Object.keys(user.wallets).length > 0;
  const busy = !!props.busy;
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
            className={memory ? 'caution' : 'warn'}
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

      <Wallets user={user} balances={balances} busy={busy} onRead={readBalances} />

      <FlowPanel
        flows={FLOWS.filter((flow) => flow.mode === user.mode)}
        helpers={{ post, reload: props.reload }}
        busy={busy}
        run={props.run}
        disabled={!hasWallets}
      />

      <Workbench
        user={user}
        users={props.users}
        config={props.config}
        balances={balances}
        busy={busy}
        disabled={!hasWallets}
        run={props.run}
        post={post}
        readBalances={readBalances}
      />

      <Records detail={props.detail} busy={busy} act={act} />
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

const nativeBalance = (balances: Balance[] | undefined, family: Family) =>
  balances?.find((b) => b.family === family && b.native);

function Wallets(props: { user: DemoUser; balances?: Balance[]; busy: boolean; onRead(): void }) {
  return (
    <section className="section">
      <div className="section-head">
        <h3>Wallets</h3>
        <button className="small-button" onClick={props.onRead} disabled={props.busy}>
          {props.balances ? 'Refresh balances' : 'Read balances'}
        </button>
      </div>
      <div className="wallets">
        {FAMILIES.map((family) => {
          const address = props.user.wallets[family];
          const balance = nativeBalance(props.balances, family);
          const empty = balance?.balance === '0';
          return (
            <div key={family} className="wallet">
              <span className="chain">
                <b>{CHAIN[family].name}</b> {CHAIN[family].network}
              </span>
              <code className="address" title={address}>
                {address ?? '—'}
              </code>
              {address && <CopyButton value={address} />}
              <span className="balance">
                {family === 'evm' ? (
                  <span className="tag sponsored">sponsored</span>
                ) : balance ? (
                  empty ? (
                    <a href={FAUCETS[family]} target="_blank" rel="noreferrer">
                      0 {CHAIN[family].symbol} · get test {CHAIN[family].symbol} ↗
                    </a>
                  ) : (
                    `${formatUnits(balance.balance, balance.decimals)} ${CHAIN[family].symbol}`
                  )
                ) : (
                  <span className="muted">balance unknown</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {props.balances && (
        <p className="hint">Balances come from the indexer: not attested, for display only.</p>
      )}
    </section>
  );
}

type StepState = 'pending' | 'running' | 'done' | 'failed';

function FlowPanel(props: {
  flows: Flow[];
  helpers: FlowHelpers;
  busy: boolean;
  disabled: boolean;
  run: Run;
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
    setStates((s) => s.map((state, i) => (i === index ? 'running' : state)));
    const ok = await props.run(`flow-${index}`, async () => {
      try {
        const note = await step.run(props.helpers, memo.current);
        if (note) setNotes((n) => ({ ...n, [index]: note }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!step.expect || !message.startsWith(step.expect)) throw error;
        setNotes((n) => ({ ...n, [index]: `Refused, as expected: ${step.expect}` }));
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
    <section className="flows">
      <div className="flows-head">
        <h3>Try a flow</h3>
        <p className="hint">Each one runs real calls on testnet and explains what it shows.</p>
      </div>
      <div className="chips">
        {props.flows.map((candidate) => (
          <button
            key={candidate.id}
            className={`chip ${candidate.id === flowId ? 'on' : ''}`}
            aria-pressed={candidate.id === flowId}
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
                className={index === next ? `${states[index]} up-next` : states[index]}
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
                    {states[index] === 'running'
                      ? 'Running…'
                      : states[index] === 'failed'
                        ? 'Retry'
                        : 'Run'}
                  </button>
                )}
              </li>
            ))}
          </ol>
          {next !== -1 ? (
            <button
              className="run-all"
              onClick={() => void runAll()}
              disabled={props.busy || props.disabled}
            >
              Run all steps
            </button>
          ) : (
            <div className="flow-done">
              <p className="takeaway">{flow.takeaway}</p>
              <div className="row">
                <button onClick={() => pick(flow.id)} disabled={props.busy}>
                  Run again
                </button>
                <button className="link" onClick={() => setFlowId(undefined)}>
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Workbench(props: {
  user: DemoUser;
  users: DemoUser[];
  config?: DemoConfig;
  balances?: Balance[];
  busy: boolean;
  disabled: boolean;
  run: Run;
  post<T>(name: string, body?: Record<string, unknown>): Promise<T>;
  readBalances(): Promise<boolean>;
}) {
  const [family, setFamily] = useState<Family>('evm');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('0.001');
  const [error, setError] = useState<string>();
  const chain = CHAIN[family];
  const others = props.users.filter(
    (other) => other.subject !== props.user.subject && other.wallets[family]
  );
  const fallback = others[0]
    ? { address: others[0].wallets[family]!, label: `${others[0].name}'s ${chain.name} wallet` }
    : { address: props.config?.sinks[family] ?? '', label: 'a burn address' };
  const balance = nativeBalance(props.balances, family);
  const units = family === 'evm' ? '0' : parseUnits(amount, chain.decimals);
  const unfunded = family !== 'evm' && balance?.balance === '0';
  const transfer =
    family === 'evm' ? { family } : { family, to: to.trim() || fallback.address, amount: units };

  const run = (name: string, body: Record<string, unknown>) =>
    void props
      .run(name, () =>
        props.post(name, body).then(
          () => setError(undefined),
          (failure: unknown) => {
            setError(failure instanceof Error ? failure.message : String(failure));
            throw failure;
          }
        )
      )
      .then(() => undefined);

  return (
    <section className="section workbench">
      <div className="section-head">
        <h3>Do it yourself</h3>
      </div>
      <SegmentedControl
        aria-label="Network"
        className="segmented"
        value={family}
        onValueChange={(value) => {
          if (!value) return;
          setFamily(value as Family);
          setTo('');
          setError(undefined);
          if (value !== 'evm' && !props.balances) void props.readBalances();
        }}
      >
        <SegmentedControlIndicator />
        {FAMILIES.map((f) => (
          <SegmentedControlItem key={f} value={f}>
            {CHAIN[f].name} · {f === 'evm' ? 'Amoy' : CHAIN[f].network}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>

      {family === 'evm' ? (
        <p className="note">
          A sponsored zero-value call on Polygon Amoy. The project pays the gas, so the wallet needs
          no funds.
        </p>
      ) : (
        <>
          <Funding
            family={family}
            address={props.user.wallets[family]}
            name={props.user.name}
            balance={balance}
            busy={props.busy}
            onRefresh={() => void props.readBalances()}
          />
          <div className="form-row">
            <Field className="grow">
              <FieldLabel>Recipient</FieldLabel>
              <Input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder={short(fallback.address)}
                spellCheck={false}
              />
              <FieldDescription>
                Empty sends to {fallback.label}.
                {others.length > 0 && (
                  <>
                    {' '}
                    Or pick:{' '}
                    {others.map((other) => (
                      <button
                        key={other.subject}
                        type="button"
                        className="link inline"
                        onClick={() => setTo(other.wallets[family]!)}
                      >
                        {other.name}
                      </button>
                    ))}
                  </>
                )}
              </FieldDescription>
            </Field>
            <Field className="amount">
              <FieldLabel>Amount</FieldLabel>
              <div className="suffixed">
                <Input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                />
                <span>{chain.symbol}</span>
              </div>
            </Field>
          </div>
        </>
      )}

      <div className="row">
        <Action
          className="primary"
          label="Get a quote"
          code={sdkCall(family, 'prepare')}
          hint="WaaS prices the transaction and returns a reviewId. Nothing is sent until you approve."
          onClick={() => run('prepare', transfer)}
          disabled={props.busy || props.disabled || !units || unfunded}
        />
        <Action
          label="Send now"
          code={sdkCall(family, 'send')}
          hint="Quote and send in one call. onPrepared runs in between, so your app can save the txnId before anything is sent."
          onClick={() => run('send', transfer)}
          disabled={props.busy || props.disabled || !units || unfunded}
        />
        <Action
          label="Sign a message"
          code="signMessage()"
          hint="WaaS signs a short message with this wallet's key and verifies the signature. Needs no funds."
          onClick={() => run('sign', { family })}
          disabled={props.busy || props.disabled}
        />
      </div>
      {!units && family !== 'evm' && (
        <p className="inline-error">Enter an amount greater than 0.</p>
      )}
      {error && <p className="inline-error">{error}</p>}
    </section>
  );
}

function Funding(props: {
  family: Exclude<Family, 'evm'>;
  address?: string;
  name: string;
  balance?: Balance;
  busy: boolean;
  onRefresh(): void;
}) {
  const { symbol, name, network } = CHAIN[props.family];
  const amount = props.balance
    ? formatUnits(props.balance.balance, props.balance.decimals)
    : undefined;
  const empty = props.balance?.balance === '0';
  return (
    <div className={`funding ${empty ? 'unfunded' : ''}`}>
      <div>
        <strong>
          {amount === undefined
            ? `Checking ${props.name}'s ${symbol} balance…`
            : empty
              ? `${props.name}'s ${name} wallet has no ${symbol} yet`
              : `${props.name}'s ${name} wallet has ${amount} ${symbol}`}
        </strong>
        <p className="hint">
          {name} {network} transfers are not sponsored: the wallet pays its own fees.
          {empty ? ` Send it some test ${symbol} from the faucet, then refresh.` : ''} Signing
          messages needs no funds.
        </p>
      </div>
      <div className="row">
        {empty && props.address && (
          <>
            <CopyButton value={props.address} label="Copy address" />
            <a
              className="button-link"
              href={FAUCETS[props.family]}
              target="_blank"
              rel="noreferrer"
            >
              Open {name} faucet ↗
            </a>
          </>
        )}
        <button className="small-button" onClick={props.onRefresh} disabled={props.busy}>
          Refresh
        </button>
      </div>
    </div>
  );
}

function Records(props: {
  detail: UserDetail;
  busy: boolean;
  act(name: string, body?: Record<string, unknown>): void;
}) {
  const { user, operations, ledger, store } = props.detail;
  const memory = user.mode === 'memory';
  const [allOps, setAllOps] = useState(false);
  const [allRows, setAllRows] = useState(false);
  const shownOps = allOps ? operations : operations.slice(0, 3);
  return (
    <>
      <section className="section">
        <div className="section-head">
          <h3>
            Operations <span className="count">{operations.length}</span>
          </h3>
        </div>
        <p className="hint">
          {memory
            ? 'Kept by this handle only. After “Simulate restart” they are gone.'
            : 'Kept in your database, encrypted: they survive restarts.'}
        </p>
        {operations.length === 0 && <p className="empty-line">No operations yet.</p>}
        <div className="operations">
          {shownOps.map((op) => (
            <Operation
              key={op.id}
              op={op}
              busy={props.busy}
              onExecute={() =>
                props.act('execute', {
                  family: op.family,
                  idempotencyKey: op.id,
                  reviewId: op.reviewId
                })
              }
              onCancel={() => props.act('cancel', { family: op.family, idempotencyKey: op.id })}
              onRetry={() => props.act('retry', { idempotencyKey: op.id })}
            />
          ))}
        </div>
        {operations.length > 3 && (
          <button className="link" onClick={() => setAllOps((v) => !v)}>
            {allOps ? 'Show fewer' : `Show all ${operations.length}`}
          </button>
        )}
      </section>

      {memory ? (
        <section className="section">
          <div className="section-head">
            <h3>
              Your ledger <span className="count">{ledger.length}</span>
            </h3>
          </div>
          <p className="hint">
            Your own database: each transaction's receipt (txnId), saved before it was sent. It
            outlives the handle, so you can always ask WaaS what happened.
          </p>
          {ledger.length === 0 && (
            <p className="empty-line">No receipts yet. “Send now” saves one.</p>
          )}
          <div className="ledger-list">
            {ledger.map((entry) => (
              <div key={entry.txnId} className="ledger-row">
                <span className="tag">{CHAIN[entry.family].name}</span>
                <code title={entry.txnId}>{short(entry.txnId)}</code>
                <span className={`outcome-tag ${entry.outcome ?? ''}`}>
                  {entry.outcome ?? 'not checked'}
                </span>
                {entry.txnHash ? (
                  <a href={explorer(entry.family, entry.txnHash)} target="_blank" rel="noreferrer">
                    {short(entry.txnHash)} ↗
                  </a>
                ) : (
                  <span />
                )}
                <button
                  className="small-button"
                  onClick={() => props.act('recover', { txnId: entry.txnId })}
                  disabled={props.busy}
                >
                  Check receipt
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className="section">
          <div className="section-head">
            <h3>
              Your database <span className="count">{store.length}</span>
            </h3>
          </div>
          <p className="hint">
            What the SDK wrote to your database for {user.name}: AES-256-GCM ciphertext, readable
            only with your encryption key.
          </p>
          <div className="store-list">
            {(allRows ? store : store.slice(0, 5)).map((entry) => (
              <div key={entry.key} className="store-row">
                <code className="key" title={entry.key}>
                  {entry.key}
                </code>
                <code className="cipher" title={entry.preview}>
                  {entry.preview}
                </code>
                <span className="writes">
                  {entry.bytes} B · {entry.writes} {entry.writes === 1 ? 'write' : 'writes'}
                </span>
              </div>
            ))}
          </div>
          {store.length > 5 && (
            <button className="link" onClick={() => setAllRows((v) => !v)}>
              {allRows ? 'Show fewer' : `Show all ${store.length}`}
            </button>
          )}
        </section>
      )}
    </>
  );
}

const FLOW = ['preparing', 'quoted', 'submitting', 'pending', 'executed'];
const BAD = ['failed', 'expired', 'unknown'];
const KIND: Record<string, string> = {
  call: 'call',
  transfer: 'transfer',
  sign: 'message signature',
  signTypedData: 'typed-data signature'
};

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
  const success = op.status === 'executed' || op.status === 'signed';
  const left = useCountdown(op.status === 'quoted' ? op.expiresAt : undefined);
  return (
    <div className={`operation ${BAD.includes(op.status) ? 'bad' : ''}`}>
      <div className="op-head">
        <strong>
          {CHAIN[op.family].name} {KIND[op.kind] ?? op.kind}
        </strong>
        <span className="muted small">{op.chain}</span>
        <Hint text="The idempotencyKey: retrying with it never repeats the work.">
          <code className="muted small key-chip" tabIndex={0}>
            {op.id}
          </code>
        </Hint>
      </div>
      <ol className={`stepper ${success ? 'success' : ''}`}>
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
        {left && (
          <span className={left.seconds < 30 ? 'urgent' : ''}>quote expires in {left.text}</span>
        )}
        {op.signature && (
          <span title={op.signature}>
            signature <code>{short(op.signature)}</code> · verified by WaaS
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
        <Hint text="The SDK's describeOperation() says what is safe to do next with this operation.">
          <span className={`next-action ${op.next.action}`} tabIndex={0}>
            {op.next.action}
          </span>
        </Hint>{' '}
        {op.next.reason}
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
