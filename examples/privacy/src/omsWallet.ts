import { OMSWallet } from '@polygonlabs/oms-wallet';
import { privacy } from '@polygonlabs/oms-wallet-privacy';
import { PUBLISHABLE_KEY } from './config';

export const omsWallet = new OMSWallet({
  publishableKey: PUBLISHABLE_KEY
}).extend(privacy());
