export const PUBLISHABLE_KEY = requiredEnv(
  'VITE_OMS_PUBLISHABLE_KEY',
  import.meta.env.VITE_OMS_PUBLISHABLE_KEY,
)

function requiredEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing ${name}. Copy examples/react/.env.example to examples/react/.env.local and set it.`)
  }
  return value
}
