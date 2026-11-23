import { defineConfig } from 'eslint/config';

import { recommended, typescript } from '@polygonlabs/apps-team-lint';

// The SDK runs on Node and Workers, both of which provide the Web platform globals it uses.
export default defineConfig([
  ...recommended({ globals: 'node' }),
  ...typescript(),
  {
    ignores: [
      'dist/**',
      'coverage/**',
      '.data/**',
      'tests/**',
      'scripts/**',
      '*.config.{ts,js,mjs}'
    ]
  }
]);
