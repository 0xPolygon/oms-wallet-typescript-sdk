import { fileURLToPath, URL } from 'node:url';

export function reactAliasesForExample(importMetaUrl: string) {
  return [
    {
      find: /^react$/,
      replacement: fileURLToPath(new URL('./node_modules/react/index.js', importMetaUrl))
    },
    {
      find: /^react\/jsx-runtime$/,
      replacement: fileURLToPath(new URL('./node_modules/react/jsx-runtime.js', importMetaUrl))
    },
    {
      find: /^react\/jsx-dev-runtime$/,
      replacement: fileURLToPath(new URL('./node_modules/react/jsx-dev-runtime.js', importMetaUrl))
    }
  ];
}
