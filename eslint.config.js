import { defineConfig } from 'eslint/config';

import { recommended, typescript } from '@polygonlabs/apps-team-lint';

// Source-first adoption: ESLint lints the packages' `src` (which
// target the browser + node — hence browser globals). Tests, examples, config
// files, generated code, and helper scripts are excluded for now; bringing them
// into the lint surface is a tracked follow-up (they also need tsconfig-project
// coverage and, for the vitest tests, a type-cleanup pass). Prettier still
// formats the whole repo.
export default defineConfig([
  ...recommended({ globals: 'browser' }),
  ...typescript(),
  {
    // The privacy provider stays behind `PrivacyBackend`: only its adapter may import it.
    files: ['packages/oms-wallet-privacy/src/**/*.ts'],
    ignores: ['packages/oms-wallet-privacy/src/internal/hinkal/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@hinkal/*',
                'ethers',
                'ethers/*',
                '**/internal/hinkal/*',
                '!**/internal/hinkal/backend.js'
              ],
              message: 'Only src/internal/hinkal may use the privacy provider or ethers.'
            }
          ]
        }
      ],
      // `no-restricted-imports` sees only static imports; this covers `import()` and `require()`.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportExpression[source.value=/^(@hinkal\\/|ethers(\\/|$))|internal\\/hinkal\\/(?!backend\\.js$)/]',
          message: 'Only src/internal/hinkal may use the privacy provider or ethers.'
        },
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.value=/^(@hinkal\\/|ethers(\\/|$))|internal\\/hinkal\\/(?!backend\\.js$)/]",
          message: 'Only src/internal/hinkal may use the privacy provider or ethers.'
        }
      ]
    }
  },
  {
    ignores: [
      '.claude/**',
      '**/dist/**',
      '**/coverage/**',
      '**/out-tsc/**',
      'examples/**',
      '**/tests/**',
      '**/type-tests/**',
      '**/*.config.{ts,js,cjs,mjs}',
      'scripts/**',
      'packages/oms-wallet/scripts/**',
      'packages/oms-server-wallet/scripts/**',
      'packages/oms-wallet-protocol/scripts/**',
      'packages/oms-wallet/src/generated/**'
    ]
  }
]);
