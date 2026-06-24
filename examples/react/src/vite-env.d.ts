/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OMS_PUBLISHABLE_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
