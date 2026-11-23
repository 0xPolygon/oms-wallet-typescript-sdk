import { hashTypedData } from 'viem';
import { z } from 'zod';

import { tronToHex } from './addresses.js';
import { requireChain } from './environment.js';
import { WalletError } from './errors.js';
import { canonicalJson } from './json.js';

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v as `0x${string}`);
const schema = z
  .object({
    domain: z
      .object({
        name: z.string().max(256).optional(),
        version: z.string().max(64).optional(),
        chainId: z.union([
          z
            .string()
            .regex(/^[1-9][0-9]*$/)
            .max(16),
          z.number().int().positive().safe()
        ]),
        verifyingContract: address,
        salt: z
          .string()
          .regex(/^0x[0-9a-fA-F]{64}$/)
          .transform((v) => v as `0x${string}`)
          .optional()
      })
      .strict(),
    types: z.record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      z
        .array(
          z
            .object({
              name: z.string().min(1).max(128),
              type: z.string().min(1).max(128)
            })
            .strict()
        )
        .max(64)
    ),
    primaryType: z.string().min(1).max(128),
    message: z.record(z.string(), z.unknown())
  })
  .strict();

/** Require an explicit chain and verifying contract for backend authorizations. */
export function validateTypedData(input: unknown, chainId: number) {
  requireChain(chainId);
  try {
    return normalize(JSON.parse(canonicalJson(input, 65_536)), chainId);
  } catch {
    throw new WalletError(
      'INVALID_TYPED_DATA',
      'Provide valid bounded EIP-712 data for the selected chain and contract.'
    );
  }
}

/**
 * TIP-712 is EIP-712 with Base58Check addresses. As WaaS does, rewrite every `address` the types
 * declare to its 20-byte hex form; the digest is the same either way.
 */
export function validateTronTypedData(input: unknown, chainId: number) {
  try {
    const data = JSON.parse(canonicalJson(input, 65_536));
    const types: Record<string, { name: string; type: string }[]> = data.types;
    const rewrite = (type: string, value: unknown): unknown => {
      const array = /^(.*)\[[0-9]*\]$/.exec(type);
      if (array) {
        if (!Array.isArray(value)) throw new Error('Expected an array');
        return value.map((item) => rewrite(array[1], item));
      }
      if (type === 'address')
        return typeof value === 'string' && value.startsWith('T') ? tronToHex(value) : value;
      if (!Object.hasOwn(types, type) || type === 'EIP712Domain') return value;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected a struct');
      const struct = value as Record<string, unknown>;
      for (const field of types[type])
        if (Object.hasOwn(struct, field.name))
          struct[field.name] = rewrite(field.type, struct[field.name]);
      return struct;
    };
    if (data.domain && typeof data.domain === 'object')
      data.domain.verifyingContract = rewrite('address', data.domain.verifyingContract);
    data.message = rewrite(data.primaryType, data.message);
    return normalize(data, chainId);
  } catch {
    throw new WalletError(
      'INVALID_TYPED_DATA',
      'Provide valid bounded TIP-712 data for the selected network and contract.'
    );
  }
}

function normalize(json: unknown, chainId: number) {
  const data = schema.parse(json);
  if (
    BigInt(data.domain.chainId) !== BigInt(chainId) ||
    data.primaryType === 'EIP712Domain' ||
    !data.types[data.primaryType]
  )
    throw new Error('Typed data domain/type mismatch');
  const domainTypes = [
    ...(data.domain.name === undefined ? [] : [{ name: 'name', type: 'string' }]),
    ...(data.domain.version === undefined ? [] : [{ name: 'version', type: 'string' }]),
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
    ...(data.domain.salt === undefined ? [] : [{ name: 'salt', type: 'bytes32' }])
  ];
  if (
    data.types.EIP712Domain &&
    canonicalJson(data.types.EIP712Domain) !== canonicalJson(domainTypes)
  )
    throw new Error('Domain type must bind the selected chain and contract');
  const types: typeof data.types = { ...data.types, EIP712Domain: domainTypes };
  const normalized = { ...data, domain: { ...data.domain, chainId }, types };
  const digest = hashTypedData(normalized);
  return { typedData: normalized, digest };
}
