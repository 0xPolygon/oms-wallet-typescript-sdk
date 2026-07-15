export const PUBLISHABLE_KEY = requiredEnv(
  'VITE_OMS_PUBLISHABLE_KEY',
  import.meta.env.VITE_OMS_PUBLISHABLE_KEY,
)

export const CUSTOM_GOOGLE_CLIENT_ID =
  '970987756660-0dh5gubqfiugm452raf7mm39qaq639hn.apps.googleusercontent.com'

export const CUSTOM_GOOGLE_ISSUER = 'https://accounts.google.com'

export const CUSTOM_GOOGLE_REDIRECT_URI = 'http://localhost:5173'

function requiredEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy examples/custom-google-redirect/.env.example to examples/custom-google-redirect/.env.local and set it.`,
    )
  }
  return value
}
