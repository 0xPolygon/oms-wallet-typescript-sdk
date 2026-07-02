import { OMSClient } from '@0xsequence/typescript-sdk'
import { PUBLISHABLE_KEY } from './config'

export const oms = new OMSClient({
  publishableKey: PUBLISHABLE_KEY,
})
