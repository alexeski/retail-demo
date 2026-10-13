// Server configuration, read from the environment on each use so the dev server
// (which loads .env.local) and Coolify's runtime variables both apply.
// THOUGHTSPOT_SECRET_KEY is a secret: runtime only, never a build arg.

const DEFAULT_HOST = 'https://thoughtspotpmm.thoughtspot.cloud'

export const SERVER_ENV_KEYS = [
  'THOUGHTSPOT_HOST',
  'VITE_TS_HOST',
  'THOUGHTSPOT_SECRET_KEY',
  'THOUGHTSPOT_ORG_ID',
  'THOUGHTSPOT_REGISTER_USERNAME',
] as const

/** A variable's value; blank (or a stray "undefined" string) counts as unset. */
function read(name: (typeof SERVER_ENV_KEYS)[number]): string | undefined {
  const v = process.env[name]?.trim()
  return v && v !== 'undefined' ? v : undefined
}

export function config() {
  const orgId = read('THOUGHTSPOT_ORG_ID')
  return {
    /** Server-side host; falls back to the client build's VITE_TS_HOST so both point at one cluster. */
    host: (read('THOUGHTSPOT_HOST') ?? read('VITE_TS_HOST') ?? DEFAULT_HOST).replace(/\/+$/, ''),
    /** Trusted authentication secret key (Develop > Customizations > Security Settings). */
    secretKey: read('THOUGHTSPOT_SECRET_KEY'),
    /** Org to sign in to (0 is the Primary org). Unset: the secret key's org. */
    orgId: orgId !== undefined ? Number(orgId) : undefined,
    /** The user the "Register" (store code + PIN) sign-in signs in as, if any. */
    registerUsername: read('THOUGHTSPOT_REGISTER_USERNAME'),
  }
}
