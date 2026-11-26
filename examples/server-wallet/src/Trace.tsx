import { useEffect, useMemo, useRef, useState } from 'react';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@ui-sdk/react/collapsible';
import { Switch, SwitchThumb } from '@ui-sdk/react/switch';

import type { DemoEvent, DemoUser } from '../shared';
import { codeFor, LANES, size, STATUS, storedThings, waasSentence } from './explain';
import { clock, CopyButton, duration, Hint, ModeBadge, short } from './ui';

type ActionEvent = Extract<DemoEvent, { kind: 'action' }>;
type Group = { id: number; start?: ActionEvent; end?: ActionEvent; events: DemoEvent[] };

/** One line of a card: a single event, or several database writes in a row merged into one. */
type Row = { id: number; at: number; lane: DemoEvent['lane']; tone: string; text: React.ReactNode };

export function TracePanel(props: { events: DemoEvent[]; selected?: string; users: DemoUser[] }) {
  const [onlySelected, setOnlySelected] = useState(true);
  const [toggled, setToggled] = useState<Record<number, boolean>>({});
  const [clearedAt, setClearedAt] = useState(0);
  const names = useMemo(
    () => Object.fromEntries(props.users.map((u) => [u.subject, u.name])),
    [props.users]
  );
  const groups = useMemo(() => {
    const byAction = new Map<number, Group>();
    for (const event of props.events) {
      if (event.id <= clearedAt || event.action === undefined) continue;
      if (onlySelected && event.subject !== props.selected) continue;
      const group = byAction.get(event.action) ?? { id: event.action, events: [] };
      byAction.set(event.action, group);
      if (event.kind === 'action' && event.phase === 'start') group.start = event;
      else if (event.kind === 'action') group.end = event;
      else group.events.push(event);
    }
    return [...byAction.values()].filter((group) => group.start).slice(-60);
  }, [props.events, onlySelected, props.selected, clearedAt]);
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
      <div className="trace-tools">
        <span className="hint">Every call your server makes, grouped by action.</span>
        <button
          className="link"
          onClick={() => setToggled(Object.fromEntries(groups.map((g) => [g.id, false])))}
          disabled={!groups.length}
        >
          Collapse all
        </button>
        <button
          className="link"
          onClick={() => setClearedAt(props.events.at(-1)?.id ?? 0)}
          disabled={!groups.length}
        >
          Clear view
        </button>
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
            showName={!onlySelected}
            open={toggled[group.id] ?? group.id === latest}
            onOpenChange={(open) => setToggled((t) => ({ ...t, [group.id]: open }))}
          />
        ))}
        {groups.length === 0 && <Legend />}
      </div>
    </section>
  );
}

function Legend() {
  return (
    <div className="legend">
      <p>Run an action or a flow. Each call lands in one of these lanes:</p>
      <ul>
        {LANES.map((lane) => (
          <li key={lane.id}>
            <i className={`dot ${lane.id}`} />
            <b>{lane.label}</b> {lane.hint}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActionCard(props: {
  group: Group;
  name: string;
  showName: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { group, name } = props;
  const start = group.start!;
  const end = group.end;
  const waas = group.events.filter((e) => e.kind === 'waas');
  const attested = waas.length > 0 && waas.every((e) => e.kind === 'waas' && e.attested);
  const writes = group.events.filter((e) => e.kind === 'store').length;
  const waited = group.events.reduce(
    (max, e) => (e.kind === 'lock' && e.waitedMs ? Math.max(max, e.waitedMs) : max),
    0
  );
  const [showCode, setShowCode] = useState(false);
  const code = codeFor(start.name, start.mode);
  const rows = useMemo(() => toRows(group.events, name), [group.events, name]);
  const memory = start.mode === 'memory';
  return (
    <Collapsible
      className={`action-card ${end?.phase ?? 'running'}`}
      open={props.open}
      onOpenChange={(open) => props.onOpenChange(open)}
    >
      <CollapsibleTrigger className="action-head">
        <span className={`result ${end?.phase ?? 'running'}`} aria-label={end?.phase ?? 'running'}>
          {end?.phase === 'error' ? '✕' : end ? '✓' : <i className="pulse" />}
        </span>
        <span className="action-title">
          {props.showName && <strong>{name} · </strong>}
          {start.name}
        </span>
        <span className="summary">
          {waas.length > 0 && (
            <span>
              {waas.length} WaaS {waas.length === 1 ? 'call' : 'calls'}
              {attested ? (waas.length === 1 ? ', attested' : ', all attested') : ''}
            </span>
          )}
          {writes > 0 && (
            <span>
              {writes} database {writes === 1 ? 'write' : 'writes'}
            </span>
          )}
          {waited >= 10 && <span className="lock-wait">waited {duration(waited)}</span>}
          <span>{end ? `${duration(end.at - start.at)} total` : 'running'}</span>
        </span>
        <span className="time">{clock(start.at)}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel className="action-body">
        {end?.detail && (
          <p className={`outcome ${end.phase}`}>{STATUS[end.detail] ?? end.detail}</p>
        )}
        <div className="lanes header">
          <span />
          {LANES.map((lane) => {
            const unused = memory && (lane.id === 'lock' || lane.id === 'store');
            return (
              <Hint
                key={lane.id}
                side="top"
                text={unused ? `${lane.hint} Not used by this in-memory user.` : lane.hint}
              >
                <span className={`lane-title ${lane.id} ${unused ? 'dim' : ''}`} tabIndex={0}>
                  {lane.label}
                </span>
              </Hint>
            );
          })}
          <span />
        </div>
        {rows.map((row) => {
          const target = LANES.findIndex((lane) => lane.id === row.lane);
          return (
            <div key={row.id} className={`lanes ${row.tone}`}>
              <span className="time">+{duration(Math.max(0, row.at - start.at))}</span>
              {LANES.map((lane, index) => (
                <span
                  key={lane.id}
                  className={`cell ${lane.id} ${index === 0 && target > 0 ? 'from' : ''} ${index > 0 && index < target ? 'through' : ''} ${index === target ? 'hit' : ''} ${memory && (lane.id === 'lock' || lane.id === 'store') ? 'unused' : ''}`}
                >
                  {index === target && <i className="marker" />}
                </span>
              ))}
              <span className="text">
                <span className={`lane-pill ${row.lane}`}>{LANES[target]?.label}</span>
                {row.text}
              </span>
            </div>
          );
        })}
        {code && (
          <div className="code-peek">
            <button className="link" onClick={() => setShowCode((v) => !v)}>
              {showCode ? 'Hide the SDK code' : 'Show the SDK code'}
            </button>
            {showCode && (
              <div className="code-block">
                <CopyButton value={code} />
                <pre className="code">{code}</pre>
              </div>
            )}
          </div>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}

function toRows(events: DemoEvent[], name: string): Row[] {
  const rows: Row[] = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (event.kind === 'store') {
      const run = [event];
      while (events[index + 1]?.kind === 'store') run.push(events[++index] as typeof event);
      const bytes = run.reduce((sum, write) => sum + write.bytes, 0);
      rows.push({
        id: event.id,
        at: event.at,
        lane: 'store',
        tone: '',
        text: (
          <span title={run.map((write) => `${write.key} (${write.bytes} B)`).join('\n')}>
            Saved{' '}
            {storedThings(
              run.map((write) => write.key),
              name
            )}{' '}
            to your database <span className="muted">(encrypted, {size(bytes)})</span>
          </span>
        )
      });
      continue;
    }
    if (event.kind === 'lock') {
      const acquired = events
        .slice(index + 1)
        .find((e): e is Extract<DemoEvent, { kind: 'lock' }> => e.kind === 'lock');
      if (event.phase === 'queued' && (acquired?.waitedMs ?? 0) < 5) continue;
      // A turn with nothing in it (a quick local read) says nothing worth a row.
      const following = events[index + 1];
      if (
        event.phase === 'acquired' &&
        (event.waitedMs ?? 0) < 5 &&
        following?.kind === 'lock' &&
        following.phase === 'released'
      ) {
        index++;
        continue;
      }
      rows.push({
        id: event.id,
        at: event.at,
        lane: 'lock',
        tone: '',
        text:
          event.phase === 'queued' ? (
            <>{name} was busy with another call, so this one waited</>
          ) : event.phase === 'acquired' ? (
            (event.waitedMs ?? 0) >= 5 ? (
              <>
                Started after waiting <b>{duration(event.waitedMs!)}</b>
              </>
            ) : (
              <>{name} was free, so this call started right away</>
            )
          ) : (
            <>
              Finished in {duration(event.heldMs ?? 0)}. {name} is free again
            </>
          )
      });
      continue;
    }
    rows.push({
      id: event.id,
      at: event.at,
      lane: event.lane,
      tone: tone(event),
      text: <Describe event={event} name={name} />
    });
  }
  return rows;
}

function tone(event: DemoEvent) {
  if (event.kind === 'waas' || event.kind === 'indexer') return event.status >= 400 ? 'bad' : '';
  if (event.kind === 'operation') {
    if (['executed', 'signed'].includes(event.operation.status)) return 'good';
    if (['failed', 'unknown', 'expired'].includes(event.operation.status)) return 'bad';
  }
  return '';
}

function Describe({ event, name }: { event: DemoEvent; name: string }) {
  switch (event.kind) {
    case 'hook':
      return (
        <span title={event.title}>
          <b>{event.name}</b> <span className="muted">{event.detail}</span>
        </span>
      );
    case 'operation':
      return (
        <>
          <b>{STATUS[event.operation.status] ?? event.operation.status}</b>
          {event.operation.txnId ? (
            <span className="muted"> · txnId {short(event.operation.txnId)}</span>
          ) : null}
        </>
      );
    case 'waas':
      return (
        <>
          <b>{waasSentence(event.method, name, event.chain)}</b> <Latency ms={event.ms} />{' '}
          {event.attested && (
            <Hint
              side="top"
              text="The reply carried an AWS Nitro attestation. Before using it, the SDK checks the enclave measurement (PCR0), the signature, freshness, and that it answers this exact request. A failed check fails the action."
            >
              <span className="attested" tabIndex={0}>
                ✓ attested
              </span>
            </Hint>
          )}{' '}
          <span className="muted method">{event.method}</span>
        </>
      );
    case 'indexer':
      return (
        <>
          <b>
            Read {name}'s {event.chain ? `${event.chain} ` : ''}balance
          </b>{' '}
          <Latency ms={event.ms} /> <span className="muted">not attested</span>
        </>
      );
    default:
      return null;
  }
}

function Latency({ ms }: { ms: number }) {
  return (
    <span className="latency">
      <i style={{ width: `${Math.max(2, Math.min(40, ms / 25))}px` }} />
      {duration(ms)}
    </span>
  );
}
