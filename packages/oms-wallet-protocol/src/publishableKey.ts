export type WaasStage = 'local' | 'dev' | 'stg' | 'production';
export type WaasMode = 'sdbx' | 'live';

export interface PublishableKeyRoute {
  projectId: string;
  /** WaaS API origin, for example `https://api.polygon.technology`. */
  apiUrl: string;
  stage: WaasStage;
  mode: WaasMode;
  /** PCR0 measurements of the enclave builds deployed for this stage, as lowercase hex. */
  trustedPcr0s: ReadonlyArray<string>;
}

// All-zero PCR0 = a debug enclave, which proves nothing about the code it runs.
export const DEBUG_PCR0 = '0'.repeat(96);

// Measurements are pinned to the deployed WaaS builds. Production measurements are published in
// WaaS GitHub releases; Staging can advance between releases. During rotation, publish an SDK that
// trusts both measurements before deploying the replacement, then remove the retired measurement.
const debugPcr0s: ReadonlyArray<string> = [DEBUG_PCR0];
const stagingPcr0s: ReadonlyArray<string> = [
  '3d21c70519a0ea3d5e6af43c5323234d90755d1ca08431064bd9687ddde4a4788a0a4736701513eee6008f1ec17e0d23',
  '67fe2a7e9254ad246dc504510279b7bfdc15b1e20ad0fc2ae0634059e60cf03db6d09415fb40a6cab5404ddecdf1b521'
];
const productionPcr0s: ReadonlyArray<string> = [
  '66d0d20073ec8549b6eb1cd3cd53311495225ec79d68f168ab734b24a69a8ed0f890f85ff31d5f0a79486a4e3a303b3c',
  '3b5bd9130a7f27fa7ad17aecfe9d622cfc4e853c2488adaabb6ee9f31bcab218d25337d7d269b00967465bd5cae97f9e'
];

const routes: ReadonlyArray<{
  prefix: string;
  apiUrl: string;
  stage: WaasStage;
  mode: WaasMode;
  trustedPcr0s: ReadonlyArray<string>;
}> = [
  {
    prefix: 'pk_local_sdbx_',
    apiUrl: 'https://sandbox-api.local.polygon-dev.technology',
    stage: 'local',
    mode: 'sdbx',
    trustedPcr0s: debugPcr0s
  },
  {
    prefix: 'pk_local_live_',
    apiUrl: 'https://api.local.polygon-dev.technology',
    stage: 'local',
    mode: 'live',
    trustedPcr0s: debugPcr0s
  },
  {
    prefix: 'pk_dev_sdbx_',
    apiUrl: 'https://sandbox-api.dev.polygon-dev.technology',
    stage: 'dev',
    mode: 'sdbx',
    trustedPcr0s: debugPcr0s
  },
  {
    prefix: 'pk_dev_live_',
    apiUrl: 'https://api.dev.polygon-dev.technology',
    stage: 'dev',
    mode: 'live',
    trustedPcr0s: debugPcr0s
  },
  {
    prefix: 'pk_stg_sdbx_',
    apiUrl: 'https://sandbox-api.stg.polygon-dev.technology',
    stage: 'stg',
    mode: 'sdbx',
    trustedPcr0s: stagingPcr0s
  },
  {
    prefix: 'pk_stg_live_',
    apiUrl: 'https://api.stg.polygon-dev.technology',
    stage: 'stg',
    mode: 'live',
    trustedPcr0s: stagingPcr0s
  },
  {
    prefix: 'pk_sdbx_',
    apiUrl: 'https://sandbox-api.polygon.technology',
    stage: 'production',
    mode: 'sdbx',
    trustedPcr0s: productionPcr0s
  },
  {
    prefix: 'pk_live_',
    apiUrl: 'https://api.polygon.technology',
    stage: 'production',
    mode: 'live',
    trustedPcr0s: productionPcr0s
  }
];

/**
 * Reads the environment a publishable key belongs to, or `undefined` for a malformed key. A key is
 * `pk_[<stage>_]<mode>_<project>_<secret>`: the project is letters and digits, the secret letters,
 * digits and `-`. The project ID goes into the signature header, so nothing else may reach it.
 */
export function routePublishableKey(publishableKey: string): PublishableKeyRoute | undefined {
  const route = routes.find(({ prefix }) => publishableKey.startsWith(prefix));
  if (!route) return undefined;
  const parts = /^([A-Za-z0-9]+)_([A-Za-z0-9-]+)$/.exec(publishableKey.slice(route.prefix.length));
  if (!parts) return undefined;
  return {
    projectId: `prj_${parts[1]}`,
    apiUrl: route.apiUrl,
    stage: route.stage,
    mode: route.mode,
    trustedPcr0s: route.trustedPcr0s
  };
}
