import { useEffect, useState, type ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@ui-sdk/react/tooltip';

import type { Family, Mode } from '../shared';

export const FAMILIES: Family[] = ['evm', 'solana', 'tron'];
export const CHAIN: Record<
  Family,
  { name: string; network: string; symbol: string; decimals: number }
> = {
  evm: { name: 'EVM', network: 'Polygon Amoy', symbol: 'POL', decimals: 18 },
  solana: { name: 'Solana', network: 'devnet', symbol: 'SOL', decimals: 9 },
  tron: { name: 'Tron', network: 'Nile', symbol: 'TRX', decimals: 6 }
};
export const FAUCETS: Record<Family, string> = {
  evm: 'https://faucet.polygon.technology/',
  solana: 'https://faucet.solana.com/',
  tron: 'https://nileex.io/join/getJoinPage'
};

export function Hint(props: { text: string; children: ReactElement; side?: 'top' | 'bottom' }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipContent className="tooltip" side={props.side ?? 'bottom'}>
        {props.text}
      </TooltipContent>
    </Tooltip>
  );
}

export function ModeBadge({ mode }: { mode: Mode }) {
  return <span className={`badge ${mode}`}>{mode === 'durable' ? 'durable' : 'in-memory'}</span>;
}

/** A button with a plain label and the SDK call it makes underneath. */
export function Action(props: {
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

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="copy"
      aria-label={`${label}: ${value}`}
      onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

export const short = (value: string) =>
  value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;

export const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

export function duration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function formatUnits(value: string, decimals: number) {
  const padded = value.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals || undefined);
  const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, '') : '';
  return fraction ? `${whole}.${fraction.slice(0, 6)}` : whole;
}

/** "0.001" SOL → "1000000" lamports. Undefined when the text is not a positive amount. */
export function parseUnits(text: string, decimals: number) {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  const fraction = (match[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  const units = BigInt((match[1] || '0') + fraction);
  return units > 0n ? units.toString() : undefined;
}

export function useCountdown(until?: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  if (!until) return undefined;
  const seconds = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  return {
    seconds,
    text: seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
  };
}

export function explorer(family: Family, hash: string) {
  return family === 'evm'
    ? `https://amoy.polygonscan.com/tx/${hash}`
    : family === 'solana'
      ? `https://explorer.solana.com/tx/${hash}?cluster=devnet`
      : `https://nile.tronscan.org/#/transaction/${hash}`;
}
