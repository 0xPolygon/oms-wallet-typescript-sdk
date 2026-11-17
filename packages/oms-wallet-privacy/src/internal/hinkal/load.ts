// The only module that loads the privacy provider. Everything it exposes stays inside
// `src/internal/hinkal`; see `PrivacyBackend` for what the rest of the package may use.
import type * as ProviderModuleNs from '@hinkal/common/providers/prepareEthersHinkal';
import type * as Ethers from 'ethers';
import type * as NodeModule from 'node:module';

type ProviderModule = typeof ProviderModuleNs;

export interface LoadedProvider {
  readonly prepareFromSignature: ProviderModule['prepareEthersHinkalFromSignature'];
  /** The ethers instance the provider uses, so our signer is built on the same classes. */
  readonly ethers: typeof Ethers;
}

let loaded: Promise<LoadedProvider> | undefined;

/** Loads the provider once, on first use: it is large and most apps never need it. */
export function loadProvider(): Promise<LoadedProvider> {
  loaded ??= load().catch((error: unknown) => {
    loaded = undefined;
    throw error;
  });
  return loaded;
}

async function load(): Promise<LoadedProvider> {
  if (isNode()) {
    // The provider's ESM build does not load in Node (a CommonJS dependency's named exports), so
    // Node uses its CommonJS build, and ethers from the same build so both share one instance.
    // The specifier is not literal so browser bundlers leave `node:module` alone.
    const nodeModule = 'node:module';
    const { createRequire } = (await import(/* @vite-ignore */ nodeModule)) as typeof NodeModule;
    const require = createRequire(import.meta.url);
    const providerPath = require.resolve('@hinkal/common/providers/prepareEthersHinkal');
    const provider = require(providerPath) as ProviderModule;
    const ethers = createRequire(providerPath)('ethers') as typeof Ethers;
    return { prepareFromSignature: provider.prepareEthersHinkalFromSignature, ethers };
  }
  // Parts of the provider use Node's `Buffer` global, which browsers lack. Set it only if absent,
  // so apps need no polyfill of their own.
  const globals = globalThis as { Buffer?: unknown };
  if (globals.Buffer === undefined) globals.Buffer = (await import('buffer')).Buffer;
  const [provider, ethers] = await Promise.all([
    import('@hinkal/common/providers/prepareEthersHinkal'),
    import('ethers')
  ]);
  return { prepareFromSignature: provider.prepareEthersHinkalFromSignature, ethers };
}

function isNode(): boolean {
  return (
    typeof process !== 'undefined' &&
    typeof process.versions?.node === 'string' &&
    typeof (globalThis as { window?: unknown }).window === 'undefined'
  );
}
