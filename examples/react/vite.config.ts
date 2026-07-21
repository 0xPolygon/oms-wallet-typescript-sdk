import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { reactAliasesForExample } from '../shared/vite-react-aliases'

export default defineConfig({
  base: process.env.GITHUB_PAGES === 'true' ? '/oms-wallet-typescript-sdk/react-example/' : '/',
  plugins: [react()],
  resolve: {
    alias: reactAliasesForExample(import.meta.url),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
