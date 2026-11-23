import { describe, expect, it } from 'vitest';

import { DEBUG_PCR0, routePublishableKey } from '../src/publishableKey.js';

describe('publishable keys', () => {
  it.each([
    ['pk_local_sdbx_p1_s1', 'https://sandbox-api.local.polygon-dev.technology', 'local', 'sdbx'],
    ['pk_local_live_p1_s1', 'https://api.local.polygon-dev.technology', 'local', 'live'],
    ['pk_dev_sdbx_p1_s1', 'https://sandbox-api.dev.polygon-dev.technology', 'dev', 'sdbx'],
    ['pk_dev_live_p1_s1', 'https://api.dev.polygon-dev.technology', 'dev', 'live'],
    ['pk_stg_sdbx_p1_s1', 'https://sandbox-api.stg.polygon-dev.technology', 'stg', 'sdbx'],
    ['pk_stg_live_p1_s1', 'https://api.stg.polygon-dev.technology', 'stg', 'live'],
    ['pk_sdbx_p1_s1', 'https://sandbox-api.polygon.technology', 'production', 'sdbx'],
    ['pk_live_p1_s1', 'https://api.polygon.technology', 'production', 'live']
  ])('routes %s', (key, apiUrl, stage, mode) => {
    expect(routePublishableKey(key)).toMatchObject({ projectId: 'prj_p1', apiUrl, stage, mode });
  });

  it('accepts a secret with hyphens', () => {
    expect(routePublishableKey('pk_live_p1_a-b')?.projectId).toBe('prj_p1');
  });

  it('trusts debug enclaves only on local and dev', () => {
    for (const key of ['pk_local_sdbx_p_s', 'pk_dev_live_p_s']) {
      expect(routePublishableKey(key)?.trustedPcr0s).toEqual([DEBUG_PCR0]);
    }
    for (const key of ['pk_stg_sdbx_p_s', 'pk_sdbx_p_s', 'pk_live_p_s']) {
      expect(routePublishableKey(key)?.trustedPcr0s).not.toContain(DEBUG_PCR0);
    }
  });

  it.each([
    '',
    'pk_live_',
    'pk_live_p',
    'pk_live_p_',
    'pk_live__s',
    'pk_live_p_s_x',
    'pk_test_p_s',
    'sk_live_p_s',
    'pk_dev_live_x"\n_key',
    'pk_live_p.q_s',
    'pk_live_p_s/t'
  ])('rejects %j', (key) => {
    expect(routePublishableKey(key)).toBeUndefined();
  });
});
