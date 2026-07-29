import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vitest runs Node-based tests through Vite's SSR pipeline, which routes
  // resolution through `ssr.resolve.conditions` (top-level `resolve.conditions`
  // only applies to the client environment). The '@polygonlabs/source'
  // condition makes `@polygonlabs/oms-wallet` resolve to its TypeScript source
  // so these tests run without first building the SDK's `dist/`.
  ssr: {
    resolve: {
      conditions: ['@polygonlabs/source']
    }
  },
  test: {
    include: ['tests/**/*.ts']
  }
});
