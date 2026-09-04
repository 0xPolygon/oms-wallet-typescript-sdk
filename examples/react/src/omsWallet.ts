import { OMSWallet } from '@polygonlabs/oms-wallet';
import { PUBLISHABLE_KEY, SELECTED_DEMO_ENVIRONMENT } from './config';

export const TEST_SESSION_LIFETIME_SECONDS = 604_800;

export const omsWallet = new OMSWallet({
  publishableKey: PUBLISHABLE_KEY,
  walletImport: SELECTED_DEMO_ENVIRONMENT.trustedWalletImportPcr0s
    ? { trustedPcr0s: SELECTED_DEMO_ENVIRONMENT.trustedWalletImportPcr0s }
    : undefined
});
