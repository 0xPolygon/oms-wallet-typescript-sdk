import { OMSWallet } from '@polygonlabs/oms-wallet';
import { PUBLISHABLE_KEY } from './config';

export const omsWallet = new OMSWallet({
  publishableKey: PUBLISHABLE_KEY
});
