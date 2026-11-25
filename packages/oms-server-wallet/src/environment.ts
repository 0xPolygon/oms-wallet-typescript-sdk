import type { EvmChainId } from './internal/protocol/networks.js';
import type { WaasMode, WaasStage } from './internal/protocol/publishableKey.js';

import { WalletError } from './errors.js';
import { normalizeTrustedPcr0s, trustsDebugEnclave } from './internal/protocol/attestation.js';
import {
  EVM_NETWORKS as PROTOCOL_EVM_NETWORKS,
  SOLANA_NETWORKS as PROTOCOL_SOLANA_NETWORKS,
  TRON_NETWORKS as PROTOCOL_TRON_NETWORKS
} from './internal/protocol/networks.js';
import { routePublishableKey } from './internal/protocol/publishableKey.js';

/** Chain ID of an EVM network the SDK accepts. */
export type SupportedEvmChainId = EvmChainId;

/** An EVM network the SDK accepts. */
export interface EvmNetwork {
  readonly id: SupportedEvmChainId;
  readonly name: string;
  readonly displayName: string;
  readonly nativeTokenSymbol: string;
  readonly explorerUrl: string;
}

/**
 * Every EVM network the SDK accepts, mainnets and testnets alike. The same list as the client
 * SDK's `Networks`; sponsorship is still configured per project and network in WaaS.
 */
export const EVM_NETWORKS: readonly EvmNetwork[] = PROTOCOL_EVM_NETWORKS;

/** Solana networks the SDK accepts. */
export const SOLANA_NETWORKS: readonly ('solana:mainnet' | 'solana:devnet')[] =
  PROTOCOL_SOLANA_NETWORKS;

/** Tron networks the SDK accepts. */
export const TRON_NETWORKS: readonly ('tron:mainnet' | 'tron:nile')[] = PROTOCOL_TRON_NETWORKS;

/** Whether a value is a supported EVM chain ID; narrows config or request input without a cast. */
export function isSupportedEvmChainId(chainId: unknown): chainId is SupportedEvmChainId {
  return EVM_NETWORKS.some((network) => network.id === chainId);
}

/** Internal lookup shape used by the indexer and validation. */
export const CHAINS = EVM_NETWORKS.map((network) => ({
  id: network.id,
  name: network.displayName,
  symbol: network.nativeTokenSymbol,
  explorer: network.explorerUrl
}));

export interface AttestationOptions {
  /**
   * Explicit enclave PCR0 allowlist (each 48 bytes / 96 hex chars). Replaces the SDK's
   * stage-pinned measurements; empty or malformed lists fail closed.
   */
  readonly trustedPcr0s?: readonly string[];
  /**
   * Explicit opt-in required to accept an all-zero debug enclave measurement on `local` or `dev`
   * routes. Always rejected on `stg` and `production` routes (including production sandbox).
   */
  readonly allowDebugEnclave?: boolean;
}

export interface ResolvedEnvironment {
  readonly projectId: string;
  readonly origin: string;
  readonly indexerUrl: string;
  readonly solanaIndexerUrl: string;
  readonly tronIndexerUrl: string;
  readonly stage: WaasStage;
  readonly mode: WaasMode;
  readonly trustedPcr0s: readonly string[];
}

export function requireChain(id: number) {
  const chain = CHAINS.find((entry) => entry.id === id);
  if (!chain)
    throw new WalletError('UNSUPPORTED_CHAIN', 'Select one of the configured EVM networks.');
  return chain;
}

export function environmentFromKey(key: string): ResolvedEnvironment {
  const route = routePublishableKey(key);
  if (!route) throw new WalletError('CONFIGURATION', 'Configure a valid OMS publishable key.', 503);
  return {
    projectId: route.projectId,
    origin: route.apiUrl,
    indexerUrl: `${route.apiUrl}/v1/IndexerGateway/GetTokenBalancesDetails`,
    solanaIndexerUrl: `${route.apiUrl}/v1/SolanaIndexerGateway/GetTokenBalancesDetails`,
    tronIndexerUrl: `${route.apiUrl}/v1/TronIndexerGateway/GetTokenBalancesDetails`,
    stage: route.stage,
    mode: route.mode,
    trustedPcr0s: route.trustedPcr0s
  };
}

/**
 * Resolve the enclave PCR0 trust set for a routed key.
 * - Managed non-debug routes (`production`, `stg`): default to SDK stage-pinned PCR0s; explicit
 *   `trustedPcr0s` replaces defaults; debug all-zero PCR0 is unconditionally rejected.
 * - Nonproduction debug routes (`local`, `dev`): any all-zero debug PCR0 (whether default or
 *   explicitly supplied) requires `allowDebugEnclave: true`.
 */
export function resolveAttestationPolicy(
  environment: ResolvedEnvironment,
  options: AttestationOptions = {}
): ReadonlySet<string> {
  const explicit = options.trustedPcr0s;
  const allowDebug = options.allowDebugEnclave === true;
  const isDebugEligibleStage = environment.stage === 'local' || environment.stage === 'dev';

  if (explicit === undefined) {
    const defaults = normalizeTrustedPcr0s(environment.trustedPcr0s);
    if (trustsDebugEnclave(defaults)) {
      if (!isDebugEligibleStage || !allowDebug)
        throw new WalletError(
          'CONFIGURATION',
          'Debug enclaves require an explicit allowDebugEnclave: true opt-in on local/dev routes, or explicit non-debug trustedPcr0s.',
          503
        );
    }
    return defaults;
  }

  let pcrs: ReadonlySet<string>;
  try {
    pcrs = normalizeTrustedPcr0s(explicit);
  } catch {
    throw new WalletError('CONFIGURATION', 'Configure approved enclave PCR0 measurements.', 503);
  }

  if (trustsDebugEnclave(pcrs)) {
    if (!isDebugEligibleStage)
      throw new WalletError(
        'CONFIGURATION',
        'Debug enclaves are not permitted on staging or production routes.',
        503
      );
    if (!allowDebug)
      throw new WalletError(
        'CONFIGURATION',
        'An all-zero debug PCR0 requires explicit allowDebugEnclave: true on local/dev routes.',
        503
      );
  }
  return pcrs;
}
