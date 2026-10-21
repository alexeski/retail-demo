import { RETAIL_MODEL_ID, THOUGHTSPOT_HOST } from './thoughtspot'

// The user's dashboards (Liveboards) and the ones shared with them, through the
// ThoughtSpot REST API v2, called from the browser with the viewer's ThoughtSpot
// session cookie (like the embeds, Search Data and Spotter). The cluster's CORS
// allowlist must include this app's origin.
//
// Changes are scoped to dashboards the user created (their `author`; a header's
// `owner` is the object's own GUID). ThoughtSpot enforces its own permissions on
// every call as well. Edits round-trip a dashboard's TML (export, edit, import),
// which needs the "Can download data" and "Can manage data" privileges; without
// them these calls fail with a 403 and the builder falls back to the embed's
// own Pin and Remove.

export type Dashboard = {
  id: string
  name: string
  description: string
  created: number | null
  modified: number | null
  /** Number of charts and tables on it. */
  tiles: number
  /** Its charts and tables, in the dashboard's order. */
  charts: { id: string; name: string; created: number | null }[]
  /** Who made it, and whether that's the signed-in user (only then can Studio edit it). */
  author: string
  owned: boolean
}

export class DashboardError extends Error {
  status: number
  code: string

  constructor(status: number, code: string) {
    super(
      code === 'other-model'
        ? 'That dashboard isn’t built on Retail Sales, so Studio can’t edit a copy of it.'
        : code === 'not-a-chart'
          ? 'That tile is a ShuttleViz insight, not a Search chart: edit it with ShuttleViz instead.'
          : status === 401
            ? 'Your analytics session has ended. Sign in again, then retry.'
            : status === 404
              ? 'That dashboard doesn’t exist, or it isn’t yours.'
              : status === 403
                ? 'Your account isn’t allowed to do that.'
                : code === 'cluster-idle'
                  ? 'Analytics is waking up. Try again in a minute.'
                  : 'Analytics didn’t answer. Try again.',
    )
    this.status = status
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// REST v2 with the session cookie
// ---------------------------------------------------------------------------

const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-By': 'ThoughtSpot' }

async function rest<T>(method: 'GET' | 'POST', path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${THOUGHTSPOT_HOST}/api/rest/2.0${path}`, {
      ...init,
      method,
      credentials: 'include',
      headers: HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    // A network error, or an idle cluster's page, which has no CORS headers.
    throw new DashboardError(502, 'unavailable')
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403) console.warn(`ThoughtSpot ${path} (${res.status}): ${detail}`)
    throw new DashboardError(res.status, res.status === 400 ? 'rejected' : 'unavailable')
  }
  if (res.status === 204) return undefined as T
  if (!res.headers.get('content-type')?.includes('json')) {
    const text = await res.text()
    throw new DashboardError(503, /idle screen|back up momentarily/i.test(text) ? 'cluster-idle' : 'unavailable')
  }
  return (await res.json()) as T
}

type Me = { id: string; name: string }
let me: Promise<Me> | null = null

/** The signed-in ThoughtSpot user, asked once per page (again after a failure). */
function currentUser(): Promise<Me> {
  me ??= rest<Me>('GET', '/auth/session/user').catch((err) => {
    me = null
    throw err
  })
  return me
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

type SearchHit = {
  metadata_id: string
  metadata_name: string
  metadata_header?: {
    description?: string
    author?: string
    authorDisplayName?: string
    created?: number
    modified?: number
  }
  visualization_headers?: { id: string; name?: string; created?: number }[]
}

const ownedBy = (hit: SearchHit, userId: string) => hit.metadata_header?.author === userId

const toDashboard = (hit: SearchHit, userId: string): Dashboard => ({
  id: hit.metadata_id,
  name: hit.metadata_name,
  description: hit.metadata_header?.description ?? '',
  created: hit.metadata_header?.created ?? null,
  modified: hit.metadata_header?.modified ?? null,
  tiles: hit.visualization_headers?.length ?? 0,
  charts: (hit.visualization_headers ?? []).map((v) => ({ id: v.id, name: v.name ?? 'Untitled chart', created: v.created ?? null })),
  author: hit.metadata_header?.authorDisplayName ?? '',
  owned: ownedBy(hit, userId),
})

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A dashboard the user can open, mine or not; a 404 DashboardError otherwise. */
async function readable(id: string) {
  if (!GUID.test(id)) throw new DashboardError(404, 'not-found')
  const [user, hits] = await Promise.all([
    currentUser(),
    rest<SearchHit[]>('POST', '/metadata/search', {
      metadata: [{ identifier: id, type: 'LIVEBOARD' }],
      include_visualization_headers: true,
      record_size: 1,
    }).catch((err) => {
      // An ID the user can't see answers 400 / 403 / 404 depending on the release.
      if (err instanceof DashboardError && err.status < 500 && err.status !== 401) return []
      throw err
    }),
  ])
  const hit = hits[0]
  if (!hit) throw new DashboardError(404, 'not-found')
  return { hit, user }
}

/** A dashboard the user created; a 404 DashboardError for anyone else's. */
async function owned(id: string) {
  const { hit, user } = await readable(id)
  if (!ownedBy(hit, user.id)) throw new DashboardError(404, 'not-found')
  return hit
}

/** The user's dashboards, most recently changed first. */
export async function listDashboards(): Promise<Dashboard[]> {
  const user = await currentUser()
  const hits = await rest<SearchHit[]>('POST', '/metadata/search', {
    metadata: [{ type: 'LIVEBOARD' }],
    created_by_user_identifiers: [user.name],
    include_visualization_headers: true,
    sort_options: { field_name: 'MODIFIED', order: 'DESC' },
    record_size: 200,
  })
  return hits.filter((h) => ownedBy(h, user.id)).map((h) => toDashboard(h, user.id))
}

/**
 * Liveboards built on the Retail Sales model, from the model's dependents. Not
 * every one is necessarily open to this user: callers look them up again.
 */
async function retailDashboards() {
  const res = await rest<{ dependent_objects?: Record<string, Record<string, { id: string; author?: string }[]>> }[]>(
    'POST',
    '/metadata/search',
    { metadata: [{ identifier: RETAIL_MODEL_ID }], include_dependent_objects: true, dependent_objects_record_size: 500, record_size: 1 },
  )
  return res[0]?.dependent_objects?.[RETAIL_MODEL_ID]?.PINBOARD_ANSWER_BOOK ?? []
}

/**
 * Headers (with tiles) for `ids`, leaving out any the user can't open. One call
 * when it can; if ThoughtSpot refuses the batch over one inaccessible ID, one by one.
 */
async function lookUp(ids: string[]): Promise<SearchHit[]> {
  if (!ids.length) return []
  const search = (batch: string[]) =>
    rest<SearchHit[]>('POST', '/metadata/search', {
      metadata: batch.map((identifier) => ({ identifier, type: 'LIVEBOARD' })),
      include_visualization_headers: true,
      record_size: batch.length,
    })
  try {
    return await search(ids)
  } catch (err) {
    if (!(err instanceof DashboardError) || err.status >= 500 || err.status === 401) throw err
    return (await Promise.all(ids.map((id) => search([id]).catch(() => [] as SearchHit[])))).flat()
  }
}

/**
 * Others' dashboards on the Retail Sales model that the user can open: those
 * shared with them (or every one, for an administrator), newest first.
 */
export async function listShared(): Promise<Dashboard[]> {
  const [user, retail] = await Promise.all([currentUser(), retailDashboards()])
  const ids = [...new Set(retail.filter((d) => d.author !== user.id).map((d) => d.id))]
  const hits = (await lookUp(ids)).filter((h) => !ownedBy(h, user.id))
  hits.sort((a, b) => (b.metadata_header?.modified ?? 0) - (a.metadata_header?.modified ?? 0))
  return hits.map((h) => toDashboard(h, user.id))
}

/** One dashboard the user can open, mine or shared. */
export async function getDashboard(id: string): Promise<Dashboard> {
  const { hit, user } = await readable(id)
  return toDashboard(hit, user.id)
}

export async function deleteDashboard(id: string) {
  await owned(id)
  await rest('POST', '/metadata/delete', { metadata: [{ identifier: id, type: 'LIVEBOARD' }] })
}

// ---------------------------------------------------------------------------
// Edits through TML: live tiles, removing a tile, renaming, cloning
// ---------------------------------------------------------------------------

type TileRef = { visualization_id: string } & Record<string, unknown>
type LiveboardTml = {
  guid?: string
  liveboard: {
    name: string
    description?: string
    /** Search charts carry an `answer`; SpotterViz insight tiles (`ai_tile`) and notes don't. */
    visualizations?: { id: string; viz_guid?: string; answer?: { name?: string; description?: string } & Record<string, unknown> }[]
    layout?: { tiles?: TileRef[]; tabs?: { tiles?: TileRef[] }[] } & Record<string, unknown>
  } & Record<string, unknown>
}

type ImportResponse = { status?: { status_code?: string; error_message?: string }; header?: { id_guid?: string } }

async function exportTml(id: string) {
  const exported = await rest<{ edoc: string }[]>('POST', '/metadata/tml/export', {
    metadata: [{ identifier: id, type: 'LIVEBOARD' }],
    export_fqn: true,
    edoc_format: 'JSON',
  })
  const tml = JSON.parse(exported[0]?.edoc ?? '{}') as LiveboardTml
  if (!tml.liveboard) throw new DashboardError(502, 'unavailable')
  return tml
}

/** Imports one TML object; ThoughtSpot reports a rejected import with a 200 and an ERROR status. */
async function importTml(tml: unknown, createNew = false): Promise<ImportResponse> {
  const result = await rest<{ response?: ImportResponse }[]>('POST', '/metadata/tml/import', {
    metadata_tmls: [JSON.stringify(tml)],
    import_policy: 'ALL_OR_NONE',
    ...(createNew ? { create_new: true } : {}),
  })
  const response = result[0]?.response ?? {}
  if (response.status?.status_code === 'ERROR') {
    console.warn('TML import rejected:', response.status.error_message)
    throw new DashboardError(400, 'rejected')
  }
  return response
}

/** Clears a draft's marker description an earlier build could leave on a tile. */
function clearDraftMarkers(tml: LiveboardTml) {
  for (const v of tml.liveboard.visualizations ?? []) {
    if (v.answer && isDraft(v.answer.description)) v.answer.description = ''
  }
}

/** Exports dashboard `id` as TML, lets `edit` change it, and imports the result over the original. */
async function editTml(id: string, edit: (tml: LiveboardTml) => void) {
  await owned(id)
  const tml = await exportTml(id)
  edit(tml)
  clearDraftMarkers(tml)
  await importTml(tml)
}

/** The tile with GUID `vizId`, or by title on releases whose export leaves `viz_guid` out. */
function findTile(tml: LiveboardTml, vizId: string, title?: string) {
  const vizs = tml.liveboard.visualizations ?? []
  const tile = vizs.find((v) => v.viz_guid === vizId) ?? (title ? vizs.findLast((v) => v.answer?.name === title) : undefined)
  if (!tile) throw new DashboardError(400, 'rejected')
  return tile
}

/** Like findTile, for a Search chart only (not a ShuttleViz insight or a note). */
function findChart(tml: LiveboardTml, vizId: string, title?: string) {
  const tile = findTile(tml, vizId, title)
  if (!tile.answer) throw new DashboardError(422, 'not-a-chart')
  return tile as typeof tile & { answer: NonNullable<typeof tile.answer> }
}

/**
 * Re-points a pinned tile at `answer` (Search's current TML), in place: position,
 * size and the tile's identity stay, so the dashboard reads as the same tile, updated.
 */
export const replaceTile = (id: string, vizId: string, answer: unknown, title: string) =>
  editTml(id, (tml) => {
    const tile = findChart(tml, vizId, title)
    // The answer TML from Search names its own GUID; on a Liveboard it has none.
    // A tile opened for editing comes back with its draft's description, which is
    // Studio's marker, not the tile's: keep the tile's own instead. Always written
    // out: a description missing from the TML leaves the old one in place.
    const { guid: _guid, id: _id, description, ...rest } = answer as Record<string, unknown> & { description?: string }
    const kept = (isDraft(description) ? tile.answer.description : description) ?? ''
    tile.answer = { ...rest, name: title.trim().slice(0, 200), description: isDraft(kept) ? '' : kept }
  })

/** Takes a chart off the dashboard, with its place in the layout (and in any tab's). */
export const removeTile = (id: string, vizId: string) =>
  editTml(id, (tml) => {
    const tile = findTile(tml, vizId)
    const lb = tml.liveboard
    lb.visualizations = lb.visualizations?.filter((v) => v !== tile)
    const keep = (tiles?: TileRef[]) => tiles?.filter((t) => t.visualization_id !== tile.id)
    if (lb.layout) {
      lb.layout.tiles = keep(lb.layout.tiles)
      lb.layout.tabs?.forEach((tab) => (tab.tiles = keep(tab.tiles)))
    }
  })

export async function renameDashboard(id: string, name: string): Promise<Dashboard> {
  const trimmed = name.trim().slice(0, 100)
  if (!trimmed) throw new DashboardError(400, 'rejected')
  await editTml(id, (tml) => {
    tml.liveboard.name = trimmed
  })
  return getDashboard(id)
}

/**
 * A copy of a dashboard the user can open, as a new one of theirs (named
 * "Copy of …" unless `name`). Only Retail Sales dashboards: Studio couldn't edit
 * a copy of anything else.
 */
export async function cloneDashboard(id: string, name?: string): Promise<Dashboard> {
  const { hit } = await readable(id)
  if (!(await retailDashboards()).some((d) => d.id === id)) throw new DashboardError(422, 'other-model')
  const tml = await exportTml(id)
  // A copy needs GUIDs of its own: the dashboard's and its tiles' (ThoughtSpot
  // would replace taken ones anyway, with a warning).
  delete tml.guid
  tml.liveboard.name = (name?.trim() || `Copy of ${hit.metadata_name}`).slice(0, 100)
  for (const v of tml.liveboard.visualizations ?? []) delete v.viz_guid
  clearDraftMarkers(tml)
  const newId = (await importTml(tml, true)).header?.id_guid
  if (!newId) throw new DashboardError(502, 'unavailable')
  return getDashboard(newId)
}

// ---------------------------------------------------------------------------
// Drafts: editing a tile that's already on a dashboard
// ---------------------------------------------------------------------------

// Search can only open a *saved* Answer with its chart settings, and a tile on a
// Liveboard isn't one. So editing a tile copies it into a private draft Answer,
// which Search opens; the live link then writes edits back to the tile. Drafts
// are deleted when editing ends, and any left behind (a closed tab) are swept
// the next time the user opens a tile.
//
// A draft keeps the tile's title, since Search shows it. Its description, also
// shown, marks it as a draft: only Answers the user wrote with exactly this
// description are ever swept.

const DRAFT_DESCRIPTION = 'Editing in Studio · changes go straight to the dashboard'
/** Drafts made before the description above (named "Studio draft · <title>"). */
const LEGACY_DRAFT_DESCRIPTION = 'Storeloom Studio: a working copy of a dashboard tile. Deleted when editing ends.'
const isDraft = (description?: string) => description === DRAFT_DESCRIPTION || description === LEGACY_DRAFT_DESCRIPTION
const DRAFT_MAX_AGE_MS = 2 * 60 * 60 * 1000

/** Copies a tile into a draft Answer that Search can open for editing. */
export async function openDraft(id: string, vizId: string): Promise<{ answerId: string; title: string }> {
  await owned(id)
  const tile = findChart(await exportTml(id), vizId)
  const title = tile.answer.name || 'Untitled chart'
  const answerId = (await importTml({ answer: { ...tile.answer, name: title, description: DRAFT_DESCRIPTION } }, true)).header?.id_guid
  if (!answerId) throw new DashboardError(502, 'unavailable')
  void sweepDrafts()
  return { answerId, title }
}

/** Deletes a draft once editing ends; `keepalive` lets it finish as the page unloads. */
export const deleteDraft = (answerId: string, keepalive = false) =>
  rest('POST', '/metadata/delete', { metadata: [{ identifier: answerId, type: 'ANSWER' }] }, { keepalive }).catch(() => {})

/** Best effort: drafts older than DRAFT_MAX_AGE_MS that a closed tab left behind. */
async function sweepDrafts() {
  try {
    const user = await currentUser()
    const hits = await rest<SearchHit[]>('POST', '/metadata/search', {
      metadata: [{ type: 'ANSWER' }],
      created_by_user_identifiers: [user.name],
      sort_options: { field_name: 'MODIFIED', order: 'DESC' },
      record_size: 200,
    })
    const stale = hits.filter(
      (h) => ownedBy(h, user.id) && isDraft(h.metadata_header?.description) && (h.metadata_header?.modified ?? 0) < Date.now() - DRAFT_MAX_AGE_MS,
    )
    if (stale.length) await rest('POST', '/metadata/delete', { metadata: stale.map((h) => ({ identifier: h.metadata_id, type: 'ANSWER' })) })
  } catch (err) {
    console.warn('Sweeping Studio drafts failed', err)
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000

/** "Edited 3 min ago", "Edited yesterday", "Edited 12 Oct 2026". */
export function formatEdited(ms: number | null, now = Date.now()) {
  if (!ms) return 'Never edited'
  const diff = now - ms
  if (diff < 60_000) return 'Edited just now'
  if (diff < 60 * 60_000) return `Edited ${Math.round(diff / 60_000)} min ago`
  if (diff < DAY && new Date(ms).getDate() === new Date(now).getDate()) return `Edited ${Math.round(diff / (60 * 60_000))} h ago`
  if (diff < 2 * DAY) return 'Edited yesterday'
  return `Edited ${new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
}

export const tileCount = (n: number) => (n === 1 ? '1 chart' : `${n} charts`)

/**
 * A chart title from Search's query: "[Sales] [Store Region] [Date].monthly" →
 * "Sales by Store Region, Date". Only a starting point; the user can retitle it.
 */
export function titleFromQuery(query: string) {
  const tokens = [...query.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!.trim()).filter(Boolean)
  const unique = [...new Set(tokens)].map((t) => t.replace(/\b\w/g, (c) => c.toUpperCase()))
  if (!unique.length) return ''
  const [first, ...rest] = unique
  return rest.length ? `${first} by ${rest.join(', ')}` : first!
}
