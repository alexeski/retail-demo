import { config } from './config.ts'

/** Token lifetime: one working day, like the HR demo. */
export const TOKEN_TTL_SECONDS = 24 * 60 * 60

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-By': 'ThoughtSpot' }

export class ThoughtSpotError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export class NotConfiguredError extends Error {}

/**
 * The cluster is idle (auto-paused after inactivity): every call returns its
 * "Idle Screen" HTML page, with a 200, while it resumes. Takes a few minutes.
 */
export class ClusterIdleError extends Error {}

/** JSON body of a ThoughtSpot API response, or ClusterIdleError if the cluster served its idle page. */
async function json<T>(res: Response): Promise<T> {
  if (!res.headers.get('content-type')?.includes('json')) {
    const text = await res.text()
    if (/idle screen|back up momentarily/i.test(text)) throw new ClusterIdleError('ThoughtSpot cluster is idle and resuming')
    throw new ThoughtSpotError(502, `Unexpected ${res.headers.get('content-type') ?? 'response'}: ${text.slice(0, 120)}`)
  }
  return (await res.json()) as T
}

export type MintedToken = { token: string; username: string; expiresAt: number }

/**
 * Trusted authentication: a full-access token for an existing ThoughtSpot user,
 * minted with the instance's secret key. Users are never auto-created.
 */
export async function mintToken(username: string): Promise<MintedToken> {
  const { host, secretKey, orgId } = config()
  if (!secretKey) throw new NotConfiguredError('THOUGHTSPOT_SECRET_KEY is not set')
  const res = await fetch(`${host}/api/rest/2.0/auth/token/full`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      username,
      secret_key: secretKey,
      validity_time_in_sec: TOKEN_TTL_SECONDS,
      auto_create: false,
      ...(orgId !== undefined && Number.isFinite(orgId) ? { org_id: orgId } : {}),
    }),
  })
  if (!res.ok) throw new ThoughtSpotError(res.status, (await res.text()).slice(0, 300))
  const body = await json<{ token: string; expiration_time_in_millis: number; valid_for_username?: string }>(res)
  return {
    token: body.token,
    username: body.valid_for_username ?? username,
    expiresAt: body.expiration_time_in_millis || Date.now() + TOKEN_TTL_SECONDS * 1000,
  }
}

export type SessionUser = { name: string; displayName: string; email?: string }

/** The user a token belongs to; throws ThoughtSpotError(401) once it is no longer valid. */
export async function sessionUser(token: string): Promise<SessionUser> {
  const res = await fetch(`${config().host}/api/rest/2.0/auth/session/user`, {
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new ThoughtSpotError(res.status, (await res.text()).slice(0, 300))
  const u = await json<{ name: string; display_name?: string; email?: string | null }>(res)
  return { name: u.name, displayName: u.display_name || u.name, email: u.email ?? undefined }
}

/** Best effort: ends the token's validity on sign-out. */
export async function revokeToken(token: string) {
  await fetch(`${config().host}/api/rest/2.0/auth/token/revoke`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ token }),
  }).catch(() => {})
}
