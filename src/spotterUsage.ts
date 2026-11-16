import { tsFetch } from './tsApi'

// Spotter usage limits (ThoughtSpot Cloud 26.11.0.cl): a pool of questions per
// user, user group or org. These are the four REST v2 endpoints under
// /ai/usage-data/, called through Storeloom's server (/api/ts), which adds the
// token. The admin calls (search, update, delete) need cluster-level
// ADMINISTRATION: see THOUGHTSPOT_ADMIN_USERNAME in server/api.ts.

export type EntityType = 'USER' | 'USER_GROUP' | 'ORG'

export type PoolKey = { entity_type: EntityType; entity_identifier: string }

export type Pool = {
  key: PoolKey
  usage: number
  warning_limit?: number
  /** Absent: the pool is unlimited. */
  limit?: number
  updated_time_in_millis?: number
  updated_by?: unknown
}

export type UserUsage = {
  pools: Pool[]
  total_usage: number
  total_warning_limit?: number
  total_limit?: number
  /** Absent when the user has an unlimited pool. */
  total_remaining?: number
  is_at_warning: boolean
  is_at_limit: boolean
  has_unlimited_pool: boolean
}

export type PoolUpdate = { key: PoolKey; limit?: number; warning_limit?: number; usage?: number }

export type ApiCall = {
  id: number
  at: number
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  status: number
  ms: number
  response: unknown
}

// Every call is reported here, for the page's live API log.
let nextCall = 1
const listeners = new Set<(c: ApiCall) => void>()
export const onApiCall = (fn: (c: ApiCall) => void) => {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

export class UsageApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const explain = (status: number, data: unknown) => {
  if (status === 403) {
    return 'ThoughtSpot refused (403): the usage-data admin calls need cluster-level ADMINISTRATION. Set THOUGHTSPOT_ADMIN_USERNAME on the server, or sign in as a cluster administrator.'
  }
  const detail = (data as { error?: { message?: string } | string; message?: string } | null) ?? {}
  const msg = typeof detail.error === 'string' ? detail.error : (detail.error?.message ?? detail.message)
  if (status === 400) return `ThoughtSpot rejected the request (400)${msg ? `: ${msg}` : ''}. If pools already exist at another scope, delete them first: a cluster meters at one scope.`
  return msg ? `${msg} (${status})` : `Request failed (${status})`
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const started = performance.now()
  const res = await tsFetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
  const data: unknown = await res.json().catch(() => null)
  const entry: ApiCall = { id: nextCall++, at: Date.now(), method, path: `/api/rest/2.0${path}`, body, status: res.status, ms: Math.round(performance.now() - started), response: data }
  listeners.forEach((fn) => fn(entry))
  if (!res.ok) throw new UsageApiError(res.status, explain(res.status, data))
  return data as T
}

/** The signed-in user's GUID: the identifier of their USER pool. */
export async function currentUserId(): Promise<string> {
  const res = await tsFetch('/auth/session/user')
  const u = (await res.json().catch(() => null)) as { id?: string } | null
  if (!res.ok || !u?.id) throw new UsageApiError(res.status, 'Could not read the signed-in user.')
  return u.id
}

/** What this user can ask: the evaluated total across every pool that applies to them. */
export async function getUserUsage(): Promise<UserUsage> {
  return (await call<{ summary: UserUsage }>('GET', '/ai/usage-data/user')).summary
}

export async function searchPools(keys?: PoolKey[]): Promise<Pool[]> {
  return (await call<{ usage_data: Pool[] }>('POST', '/ai/usage-data/search', keys ? { keys } : {})).usage_data ?? []
}

/** Creates a missing pool; omitted fields keep their values. */
export async function updatePools(updates: PoolUpdate[]): Promise<Pool[]> {
  return (await call<{ usage_data: Pool[] }>('POST', '/ai/usage-data/update', { updates })).usage_data ?? []
}

export async function deletePools(keys: PoolKey[]): Promise<PoolKey[]> {
  return (await call<{ deleted_keys: PoolKey[] }>('POST', '/ai/usage-data/delete', { keys })).deleted_keys ?? []
}

/**
 * Gives the user exactly this allowance. `limit: null` makes the pool unlimited:
 * an update can't remove a limit, so the pool is deleted and recreated without one
 * (its usage starts again at 0, so `usage` is set after).
 */
export async function provisionUser(
  key: PoolKey,
  next: { limit: number | null; warning_limit?: number; usage?: number },
): Promise<Pool[]> {
  if (next.limit === null) {
    await deletePools([key])
    return updatePools([{ key, usage: next.usage ?? 0 }])
  }
  return updatePools([{ key, limit: next.limit, warning_limit: next.warning_limit, usage: next.usage }])
}
