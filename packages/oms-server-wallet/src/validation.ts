import type { z } from 'zod';

import { WalletError } from './errors.js';

/**
 * Validate with a schema and throw the given SDK error on failure, so a schema mismatch never
 * reaches callers as a raw validation error.
 */
export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  value: unknown,
  error: () => WalletError
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw error();
  return parsed.data;
}

/** Validate a WaaS response; a mismatch is `INVALID_RESPONSE` (502). */
export function parseWaas<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  return parseOrThrow(
    schema,
    value,
    () => new WalletError('INVALID_RESPONSE', 'WaaS returned an unexpected response.', 502)
  );
}
