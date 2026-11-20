import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@polygonlabs/oms-server-wallet-sdk/trails': new URL('./src/trails/index.ts', import.meta.url)
        .pathname,
      '@polygonlabs/oms-server-wallet-sdk': new URL('./src/index.ts', import.meta.url).pathname
    }
  },
  test: {
    include: ['tests/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: { statements: 80, branches: 70, functions: 80, lines: 80 }
    }
  }
});
