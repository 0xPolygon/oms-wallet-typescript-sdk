import { defineConfig } from 'eslint/config';

import { recommended, typescript } from '@polygonlabs/apps-team-lint';

// Source-first adoption: ESLint lints the two published packages' `src` (which
// target the browser + node — hence browser globals). Tests, examples, config
// files, generated code, and helper scripts are excluded for now; bringing them
// into the lint surface is a tracked follow-up (they also need tsconfig-project
// coverage and, for the vitest tests, a type-cleanup pass). Prettier still
// formats the whole repo.
export default defineConfig([
  ...recommended({ globals: 'browser' }),
  ...typescript(),
  {
    ignores: [
      '.claude/**',
      '**/dist/**',
      '**/out-tsc/**',
      'examples/**',
      '**/tests/**',
      '**/type-tests/**',
      '**/*.config.{ts,js,cjs,mjs}',
      'scripts/**',
      'packages/oms-wallet/scripts/**',
      'packages/oms-wallet/src/generated/**'
    ]
  }
]);
