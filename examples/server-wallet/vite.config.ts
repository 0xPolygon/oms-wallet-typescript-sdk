import { defineConfig, defaultClientConditions } from 'vite';
import react from '@vitejs/plugin-react';
import { reactAliasesForExample } from '../shared/vite-react-aliases';

// The browser app never imports the SDK: it only talks to server/main.ts, which mounts Vite.
export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ['@polygonlabs/source', ...defaultClientConditions],
    alias: reactAliasesForExample(import.meta.url)
  }
});
