import type { HiddenParams } from './support.js';

export interface PublicApi {
  run(params: HiddenParams): void;
}
