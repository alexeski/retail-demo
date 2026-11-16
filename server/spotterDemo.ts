import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { config } from './config.ts'
import type { Session } from './session.ts'
import { mintToken, type MintedToken } from './thoughtspot.ts'

// The Spotter usage limits demo runs as a throwaway ThoughtSpot user per signed-in
// person, so two people demoing at once never share a pool (the cluster's limit
// belongs to a user). Nothing here needs a database or a scheduler outside this
// process: the cluster is the state.
//
// - Name:  spotter_monetization_TSE_tmp_<owner>_<random>, where <owner> is a short
//   HMAC of the signed-in user's name (no email in the name, same person = same prefix).
// - Reuse: coming back within the TTL finds the same user, so its pool is as it was.
// - Sweep: users idle for the TTL are deleted (pool first), at server start and hourly.
//   "Idle" is the later of creation and last use (a use touches the user).

const PREFIX = 'spotter_monetization_TSE_tmp_'
/** The whole name must match this, so no real user or the permanent test user can be picked up. */
const NAME = /^spotter_monetization_TSE_tmp_([0-9a-f]{8})_[0-9a-f]{6}$/

const ttlMs = () => config().spotterDemoTtlHours * 60 * 60 * 1000
const TOUCH_EVERY_MS = 30 * 60 * 1000
const SWEEP_EVERY_MS = 60 * 60 * 1000
const MAX_DELETIONS_PER_SWEEP = 25

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-By': 'ThoughtSpot' }

type Demo = { username: string; token: string; expiresAt: number; touchedAt: number }

const cache = new Map<string, Demo>()
const pending = new Map<string, Promise<Demo>>()

let adminCache: { token: string; expiresAt: number } | undefined

/** Token for the administrator (THOUGHTSPOT_ADMIN_USERNAME), cached until close to expiry. */
export async function adminToken(): Promise<string | undefined> {
  const username = config().adminUsername
  if (!username) return undefined
  if (!adminCache || adminCache.expiresAt - Date.now() < 60_000) adminCache = await mintToken(username)
  return adminCache.token
}

async function admin<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const token = await adminToken()
  if (!token) throw new Error('THOUGHTSPOT_ADMIN_USERNAME is not set')
  const res = await fetch(`${config().host}/api/rest/2.0${path}`, {
    method,
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as T
  return { status: res.status, body: data }
}

type TsUser = {
  id: string
  name: string
  account_type?: string
  super_user?: boolean
  creation_time_in_millis?: number
  modification_time_in_millis?: number
  user_groups?: { id: string }[]
}

const lastActive = (u: TsUser) => Math.max(u.creation_time_in_millis ?? 0, u.modification_time_in_millis ?? 0)

/** A short, stable id for a person: an HMAC, so their name or email never appears in a username. */
function ownerOf(session: Session): string {
  return createHmac('sha256', config().secretKey ?? 'storeloom').update(session.username.toLowerCase()).digest('hex').slice(0, 8)
}

async function searchUsers(pattern: string): Promise<TsUser[]> {
  const r = await admin<TsUser[]>('POST', '/users/search', { name_pattern: pattern, record_size: 500 })
  return r.status === 200 && Array.isArray(r.body) ? r.body : []
}

/** Marks the user as in use, so the sweep leaves it alone (an update moves its modification time). */
async function touch(username: string, id: string) {
  await admin('POST', `/users/${id}/update`, { display_name: `Spotter monetization demo (TSE - temp, last used ${new Date().toISOString()})` })
  const d = cache.get(username)
  if (d) d.touchedAt = Date.now()
}

/** Creates the person's user, in the same groups as the permanent test user (that is what lets it use the retail model). */
async function create(owner: string): Promise<TsUser> {
  const template = (await searchUsers(config().spotterDemoUsername)).find((u) => u.name === config().spotterDemoUsername)
  const groups = template?.user_groups?.map((g) => g.id) ?? []
  if (!groups.length) throw new Error(`Template user ${config().spotterDemoUsername} not found or has no groups`)
  const name = `${PREFIX}${owner}_${randomBytes(3).toString('hex')}`
  const r = await admin<TsUser & { error?: unknown }>('POST', '/users/create', {
    name,
    display_name: 'Spotter monetization demo (TSE - temp)',
    account_type: 'LOCAL_USER',
    account_status: 'ACTIVE',
    password: `${randomUUID()}aA1!`,
    email: `${name}@thoughtspot.com`,
    visibility: 'SHARABLE',
    group_identifiers: groups,
  })
  if (r.status !== 200 || !r.body?.id) throw new Error(`Could not create ${name} (${r.status})`)
  console.log(`Spotter demo: created ${name}`)
  return r.body
}

async function resolve(owner: string, session: Session): Promise<Demo> {
  void session
  try {
    const now = Date.now()
    const mine = (await searchUsers(`${PREFIX}${owner}_%`))
      .filter((u) => NAME.exec(u.name)?.[1] === owner && now - lastActive(u) < ttlMs())
      .sort((a, b) => lastActive(b) - lastActive(a))
    const user = mine[0] ?? (await create(owner))
    void touch(user.name, user.id).catch(() => undefined)
    const t: MintedToken = await mintToken(user.name)
    return { username: user.name, token: t.token, expiresAt: t.expiresAt, touchedAt: now }
  } catch (err) {
    // No admin, no template, cluster hiccup: the permanent test user still works for a single demo.
    console.error('Spotter demo: per-person user unavailable, using the shared test user.', err instanceof Error ? err.message : err)
    const t = await mintToken(config().spotterDemoUsername)
    // Short-lived in the cache, so the next visit tries the per-person user again.
    return { username: t.username, token: t.token, expiresAt: Math.min(t.expiresAt, Date.now() + 2 * 60_000 + 60_000), touchedAt: Date.now() }
  }
}

/** The token for the signed-in person's demo user, created on first use. */
export async function demoTokenFor(session: Session): Promise<{ token: string; expiresAt: number }> {
  const owner = ownerOf(session)
  const hit = cache.get(owner)
  if (hit && hit.expiresAt - Date.now() > 60_000) {
    if (Date.now() - hit.touchedAt > TOUCH_EVERY_MS && NAME.test(hit.username)) {
      hit.touchedAt = Date.now()
      void searchUsers(hit.username).then((us) => us[0] && touch(hit.username, us[0].id)).catch(() => undefined)
    }
    return hit
  }
  let p = pending.get(owner)
  if (!p) {
    p = resolve(owner, session)
      .then((d) => (cache.set(owner, d), d))
      .finally(() => pending.delete(owner))
    pending.set(owner, p)
  }
  return p
}

/** Deletes demo users idle for the TTL: their pool first, then the user. Returns the names removed. */
export async function sweepSpotterDemoUsers(): Promise<string[]> {
  if (!config().adminUsername) return []
  const removed: string[] = []
  const now = Date.now()
  for (const u of await searchUsers(`${PREFIX}%`)) {
    if (removed.length >= MAX_DELETIONS_PER_SWEEP) break
    // Every guard must pass: the exact name, not a super user, and idle past the TTL.
    if (!NAME.test(u.name) || u.super_user || now - lastActive(u) < ttlMs()) continue
    await admin('POST', '/ai/usage-data/delete', { keys: [{ entity_type: 'USER', entity_identifier: u.id }] }).catch(() => undefined)
    const r = await admin('POST', `/users/${u.id}/delete`)
    if (r.status === 204 || r.status === 200) {
      removed.push(u.name)
      for (const [k, d] of cache) if (d.username === u.name) cache.delete(k)
    } else {
      console.error(`Spotter demo: could not delete ${u.name} (${r.status})`)
    }
  }
  if (removed.length) console.log(`Spotter demo: swept ${removed.length} idle user(s): ${removed.join(', ')}`)
  return removed
}

let sweeping = false

/** Sweep shortly after the server starts, then every hour. Runs in this process: nothing else to install. */
export function startSpotterDemoSweep() {
  if (sweeping) return
  sweeping = true
  const run = () => void sweepSpotterDemoUsers().catch((err) => console.error('Spotter demo sweep failed', err instanceof Error ? err.message : err))
  setTimeout(run, 15_000).unref()
  setInterval(run, SWEEP_EVERY_MS).unref()
}
