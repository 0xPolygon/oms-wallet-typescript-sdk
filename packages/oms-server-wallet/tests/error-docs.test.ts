import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

it('documents every WalletErrorCode in docs/ERRORS.md, and nothing else', () => {
  const union = readFileSync(new URL('../src/errors.ts', import.meta.url), 'utf8');
  const codes = [...union.matchAll(/^ {2}\| '([A-Z_]+)';?$/gm)].map((match) => match[1]);
  const docs = readFileSync(new URL('../docs/ERRORS.md', import.meta.url), 'utf8');
  const documented = [...docs.matchAll(/^\|\s*`([A-Z_]+)`\s*\|/gm)].map((match) => match[1]);
  expect(codes.length).toBeGreaterThan(50);
  expect([...documented].sort()).toEqual([...codes].sort());
});
