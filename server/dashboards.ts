import express, { type Request, type Response } from 'express'
import { readSession, type Session } from './session.ts'
import { ClusterIdleError, sessionUserRecord, ThoughtSpotError, tsRest } from './thoughtspot.ts'

/**
 * The dashboard builder's API, mounted at /api/dashboards. Changes are scoped to
 * Liveboards the signed-in user created and still owns: every write checks
 * ownership here first. Others' dashboards on the Retail Sales model can be
 * viewed and cloned.
 *
 * - GET    /                     the user's dashboards, most recently changed first;
 * - GET    /shared               others' dashboards on the Retail Sales model that the
 *                                user can open;
 * - GET    /:id                  one dashboard the user can open, mine or not;
 * - POST   /:id/clone            copies a dashboard the user can open into a new one of theirs;
 * - PATCH  /:id                  renames it (and sets its description);
 * - DELETE /:id                  deletes it;
 * - POST   /:id/tiles/:vizId     replaces a tile's answer in place (the builder's live
 *                                link), keeping its position, size and title;
 * - DELETE /:id/tiles/:vizId     removes a tile;
 * - POST   /:id/tiles/:vizId/draft  copies a tile into a draft Answer, so Search can
 *                                open it with its chart settings for editing;
 * - DELETE /drafts/:answerId     deletes a draft once editing ends.
 *
 * Changes to a dashboard round-trip its TML (export, edit, import), which needs
 * the "Can download data" and "Can manage data" privileges. Without them these
 * routes answer 403 and the builder falls back to the embed's own actions.
 */

type Header = {
  id: string
  name: string
  description?: string
  author?: string
  authorDisplayName?: string
  owner?: string
  created?: number
  modified?: number
}

type SearchHit = {
  metadata_id: string
  metadata_name: string
  metadata_header?: Header
  visualization_headers?: { id: string; name?: string; created?: number }[]
}

export type Dashboard = {
  id: string
  name: string
  description: string
  created: number | null
  modified: number | null
  tiles: number
  /** Its charts and tables, in the Liveboard's order. */
  charts: { id: string; name: string; created: number | null }[]
  /** Who made it, and whether that's the signed-in user (only then can Studio edit it). */
  author: string
  owned: boolean
}

/** "Industry Demo - Retail Sales", as RETAIL_MODEL_ID in src/thoughtspot.ts. */
const RETAIL_MODEL_ID = '11e40743-9285-42bd-856d-3f81a755c4f6'

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

/**
 * Whether `userId` owns the Liveboard. That's its `author`, which a transfer of
 * ownership also changes; a header's `owner` is the object's own GUID.
 */
const ownedBy = (hit: SearchHit, userId: string) => hit.metadata_header?.author === userId

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class NotOwnedError extends Error {}

/** A tile that isn't a Search chart (a Shuttle insight, a note): Search can't open it. */
class NotAChartError extends Error {}

/** The Liveboard if the session's user owns it; NotOwnedError otherwise (also for unknown IDs). */
async function ownedDashboard(session: Session, id: string): Promise<SearchHit> {
  const { hit, me } = await readableDashboard(session, id)
  if (!ownedBy(hit, me.id)) throw new NotOwnedError()
  return hit
}

/** The Liveboard if the session's user can open it; NotOwnedError (a 404) otherwise. */
async function readableDashboard(session: Session, id: string) {
  if (!GUID.test(id)) throw new NotOwnedError()
  const [me, hits] = await Promise.all([
    sessionUserRecord(session.token),
    tsRest<SearchHit[]>(session.token, 'POST', '/metadata/search', {
      metadata: [{ identifier: id, type: 'LIVEBOARD' }],
      include_visualization_headers: true,
      record_size: 1,
    }).catch((err) => {
      // An ID the user can't see answers 400 / 403 / 404 depending on the release.
      if (err instanceof ThoughtSpotError && err.status < 500 && err.status !== 401) return []
      throw err
    }),
  ])
  const hit = hits[0]
  if (!hit) throw new NotOwnedError()
  return { hit, me }
}

/**
 * Liveboards built on the Retail Sales model, from the model's dependents. Not
 * every one is necessarily open to this user: callers look them up again.
 */
async function retailDashboards(session: Session) {
  const res = await tsRest<{ dependent_objects?: Record<string, Record<string, { id: string; author?: string }[]>> }[]>(
    session.token,
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
async function lookUp(session: Session, ids: string[]): Promise<SearchHit[]> {
  if (!ids.length) return []
  const search = (batch: string[]) =>
    tsRest<SearchHit[]>(session.token, 'POST', '/metadata/search', {
      metadata: batch.map((identifier) => ({ identifier, type: 'LIVEBOARD' })),
      include_visualization_headers: true,
      record_size: batch.length,
    })
  try {
    return await search(ids)
  } catch (err) {
    if (!(err instanceof ThoughtSpotError) || err.status >= 500 || err.status === 401) throw err
    const one = await Promise.all(ids.map((id) => search([id]).catch(() => [] as SearchHit[])))
    return one.flat()
  }
}

/** A copy of dashboard `id` (one the user can open), as a new dashboard of theirs. */
async function cloneDashboard(session: Session, id: string, name: string) {
  const tml = await exportTml(session, id)
  // A copy needs GUIDs of its own: the dashboard's and its tiles' (ThoughtSpot
  // would replace taken ones anyway, with a warning).
  delete tml.guid
  tml.liveboard.name = name
  for (const v of tml.liveboard.visualizations ?? []) {
    delete v.viz_guid
    if (v.answer && isDraft(v.answer.description as string | undefined)) v.answer.description = ''
  }
  const response = await importTml(session, tml, true)
  const newId = response.header?.id_guid
  if (!newId) throw new ThoughtSpotError(502, 'The copy came back without an ID')
  return newId
}

/** Sends the right status for a failed call, logged with `what` for the server output. */
function fail(res: Response, what: string, err: unknown) {
  if (err instanceof NotOwnedError) return res.status(404).json({ error: 'not-found' })
  if (err instanceof NotAChartError) return res.status(422).json({ error: 'not-a-chart' })
  if (err instanceof ClusterIdleError) return res.status(503).json({ error: 'cluster-idle' })
  if (err instanceof ThoughtSpotError) {
    if (err.status === 401) return res.status(401).json({ error: 'signed-out' })
    if (err.status === 403) return res.status(403).json({ error: 'forbidden' })
    console.warn(`${what} failed (${err.status}): ${err.message}`)
    return res.status(err.status < 500 ? 400 : 502).json({ error: 'rejected', detail: err.message.slice(0, 200) })
  }
  console.error(`${what} failed`, err)
  res.status(502).json({ error: 'unavailable' })
}

// ---------------------------------------------------------------------------
// Edits through TML: live tiles, removing a tile, renaming
// ---------------------------------------------------------------------------

type TileRef = { visualization_id: string } & Record<string, unknown>
type LiveboardTml = {
  guid?: string
  liveboard: {
    name: string
    description?: string
    /** Search charts carry an `answer`; SpotterViz insight tiles (`ai_tile`) and notes don't. */
    visualizations?: { id: string; viz_guid?: string; answer?: { name?: string } & Record<string, unknown> }[]
    layout?: { tiles?: TileRef[]; tabs?: { tiles?: TileRef[] }[] } & Record<string, unknown>
  } & Record<string, unknown>
}

type ImportResult = { response?: unknown }[]

type ImportResponse = { status?: { status_code?: string; error_message?: string }; header?: { id_guid?: string } }

async function exportTml(session: Session, id: string) {
  const exported = await tsRest<{ edoc: string }[]>(session.token, 'POST', '/metadata/tml/export', {
    metadata: [{ identifier: id, type: 'LIVEBOARD' }],
    export_fqn: true,
    edoc_format: 'JSON',
  })
  const tml = JSON.parse(exported[0]?.edoc ?? '{}') as LiveboardTml
  if (!tml.liveboard) throw new ThoughtSpotError(502, `No TML came back for dashboard ${id}`)
  return tml
}

/** Imports one TML object; ThoughtSpot reports a rejected import with a 200 and an ERROR status. */
async function importTml(session: Session, tml: unknown, createNew = false): Promise<ImportResponse> {
  const result = await tsRest<ImportResult>(session.token, 'POST', '/metadata/tml/import', {
    metadata_tmls: [JSON.stringify(tml)],
    import_policy: 'ALL_OR_NONE',
    ...(createNew ? { create_new: true } : {}),
  })
  const response = (result[0]?.response ?? {}) as ImportResponse
  if (response.status?.status_code === 'ERROR') throw new ThoughtSpotError(400, response.status.error_message ?? 'TML import rejected')
  return response
}

/** Exports dashboard `id` as TML, lets `edit` change it, and imports the result over the original. */
async function editTml(session: Session, id: string, edit: (tml: LiveboardTml) => void) {
  const tml = await exportTml(session, id)
  edit(tml)
  // An earlier build could write a draft's marker description onto a tile;
  // any edit clears it. (Empty, not removed: a missing description changes nothing.)
  for (const v of tml.liveboard.visualizations ?? []) {
    if (v.answer && isDraft(v.answer.description as string | undefined)) v.answer.description = ''
  }
  await importTml(session, tml)
}

/** The tile with GUID `vizId`, or by title on releases whose export leaves `viz_guid` out. */
function findTile(tml: LiveboardTml, vizId: string, title?: string) {
  const vizs = tml.liveboard.visualizations ?? []
  const tile = vizs.find((v) => v.viz_guid === vizId) ?? (title ? vizs.findLast((v) => v.answer?.name === title) : undefined)
  if (!tile) throw new ThoughtSpotError(404, `Tile ${vizId} is not on the dashboard`)
  return tile
}

/** Like findTile, for a Search chart only. */
function findChart(tml: LiveboardTml, vizId: string, title?: string) {
  const tile = findTile(tml, vizId, title)
  if (!tile.answer) throw new NotAChartError()
  return tile as typeof tile & { answer: NonNullable<typeof tile.answer> }
}

/**
 * Re-points tile `vizId` at `answer` (the TML of the Search being edited).
 * Position, size and the tile's identity stay, so the dashboard reads as the
 * same tile, updated.
 */
const replaceTile = (session: Session, id: string, vizId: string, answer: Record<string, unknown>, title: string) =>
  editTml(session, id, (tml) => {
    const tile = findChart(tml, vizId, title)
    // The answer TML from Search names its own GUID; on a Liveboard it has none.
    // A tile opened for editing comes back with its draft's description, which
    // is Studio's marker, not the tile's: keep the tile's own instead. Always
    // written out: a description missing from the TML leaves the old one in place.
    const { guid: _guid, id: _id, description, ...rest } = answer as Record<string, unknown> & { description?: string }
    const own = tile.answer.description as string | undefined
    const kept = (isDraft(description) ? own : description) ?? ''
    tile.answer = { ...rest, name: title, description: isDraft(kept) ? '' : kept }
  })

/** Takes tile `vizId` off the dashboard, with its place in the layout (and in any tab's). */
const removeTile = (session: Session, id: string, vizId: string) =>
  editTml(session, id, (tml) => {
    const tile = findTile(tml, vizId)
    const lb = tml.liveboard
    lb.visualizations = lb.visualizations?.filter((v) => v !== tile)
    const keep = (tiles?: TileRef[]) => tiles?.filter((t) => t.visualization_id !== tile.id)
    if (lb.layout) {
      lb.layout.tiles = keep(lb.layout.tiles)
      lb.layout.tabs?.forEach((tab) => (tab.tiles = keep(tab.tiles)))
    }
  })

const renameDashboard = (session: Session, id: string, name: string, description?: string) =>
  editTml(session, id, (tml) => {
    tml.liveboard.name = name
    if (description !== undefined) {
      if (description) tml.liveboard.description = description
      else delete tml.liveboard.description
    }
  })

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
// description are ever deleted here.

const DRAFT_DESCRIPTION = 'Editing in Studio · changes go straight to the dashboard'
/** Drafts made before the description above (named "Studio draft · <title>"). */
const LEGACY_DRAFT_DESCRIPTION = 'Storeloom Studio: a working copy of a dashboard tile. Deleted when editing ends.'
const isDraft = (description?: string) => description === DRAFT_DESCRIPTION || description === LEGACY_DRAFT_DESCRIPTION
const DRAFT_MAX_AGE_MS = 2 * 60 * 60 * 1000

async function createDraft(session: Session, id: string, vizId: string) {
  const tml = await exportTml(session, id)
  const tile = findChart(tml, vizId)
  const title = tile.answer.name || 'Untitled chart'
  const response = await importTml(session, { answer: { ...tile.answer, name: title, description: DRAFT_DESCRIPTION } }, true)
  const answerId = response.header?.id_guid
  if (!answerId) throw new ThoughtSpotError(502, 'The draft Answer came back without an ID')
  return { answerId, title }
}

/** The user's drafts: Answers they wrote with the draft description (and only those). */
async function drafts(session: Session, userId: string, identifier?: string) {
  const hits = await tsRest<SearchHit[]>(session.token, 'POST', '/metadata/search', {
    metadata: [identifier ? { identifier, type: 'ANSWER' } : { type: 'ANSWER' }],
    ...(identifier ? {} : { created_by_user_identifiers: [session.username], sort_options: { field_name: 'MODIFIED', order: 'DESC' } }),
    record_size: identifier ? 1 : 200,
  }).catch(() => [] as SearchHit[])
  return hits.filter((h) => ownedBy(h, userId) && isDraft(h.metadata_header?.description))
}

const deleteAnswers = (session: Session, ids: string[]) =>
  ids.length ? tsRest(session.token, 'POST', '/metadata/delete', { metadata: ids.map((identifier) => ({ identifier, type: 'ANSWER' })) }) : Promise.resolve()

/** Best effort: drafts older than DRAFT_MAX_AGE_MS that a closed tab left behind. */
async function sweepDrafts(session: Session, userId: string) {
  const stale = (await drafts(session, userId)).filter((d) => (d.metadata_header?.modified ?? 0) < Date.now() - DRAFT_MAX_AGE_MS)
  await deleteAnswers(session, stale.map((d) => d.metadata_id)).catch((err) => console.warn('Sweeping Studio drafts failed', err))
}

export function dashboardsApi() {
  const api = express.Router()

  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store')
    const session = readSession(req)
    if (!session) return res.status(401).json({ error: 'signed-out' })
    res.locals.session = session
    next()
  })

  api.get('/', async (_req: Request, res: Response) => {
    const session = res.locals.session as Session
    try {
      const [me, hits] = await Promise.all([
        sessionUserRecord(session.token),
        tsRest<SearchHit[]>(session.token, 'POST', '/metadata/search', {
          metadata: [{ type: 'LIVEBOARD' }],
          created_by_user_identifiers: [session.username],
          include_visualization_headers: true,
          sort_options: { field_name: 'MODIFIED', order: 'DESC' },
          record_size: 200,
        }),
      ])
      res.json({ dashboards: hits.filter((h) => ownedBy(h, me.id)).map((h) => toDashboard(h, me.id)) })
    } catch (err) {
      fail(res, 'Listing dashboards', err)
    }
  })

  api.get('/shared', async (_req: Request, res: Response) => {
    const session = res.locals.session as Session
    try {
      const [me, retail] = await Promise.all([sessionUserRecord(session.token), retailDashboards(session)])
      const ids = [...new Set(retail.filter((d) => d.author !== me.id).map((d) => d.id))]
      const hits = (await lookUp(session, ids)).filter((h) => !ownedBy(h, me.id))
      hits.sort((a, b) => (b.metadata_header?.modified ?? 0) - (a.metadata_header?.modified ?? 0))
      res.json({ dashboards: hits.map((h) => toDashboard(h, me.id)) })
    } catch (err) {
      fail(res, 'Listing shared dashboards', err)
    }
  })

  api.get('/:id', async (req: Request, res: Response) => {
    const session = res.locals.session as Session
    try {
      const { hit, me } = await readableDashboard(session, String(req.params.id))
      res.json({ dashboard: toDashboard(hit, me.id) })
    } catch (err) {
      fail(res, 'Reading a dashboard', err)
    }
  })

  api.delete('/drafts/:answerId', async (req: Request, res: Response) => {
    const session = res.locals.session as Session
    const answerId = String(req.params.answerId)
    if (!GUID.test(answerId)) return res.status(404).json({ error: 'not-found' })
    try {
      const me = await sessionUserRecord(session.token)
      const [draft] = await drafts(session, me.id, answerId)
      if (!draft) return res.status(404).json({ error: 'not-found' })
      await deleteAnswers(session, [draft.metadata_id])
      res.status(204).end()
    } catch (err) {
      fail(res, `Deleting draft ${answerId}`, err)
    }
  })

  api.patch('/:id', async (req: Request, res: Response) => {
    const session = res.locals.session as Session
    const id = String(req.params.id)
    const { name, description } = (req.body ?? {}) as { name?: string; description?: string }
    const trimmed = name?.trim().slice(0, 100)
    if (!trimmed) return res.status(400).json({ error: 'name-required' })
    try {
      await ownedDashboard(session, id)
      await renameDashboard(session, id, trimmed, typeof description === 'string' ? description.trim().slice(0, 500) : undefined)
      const { hit, me } = await readableDashboard(session, id)
      res.json({ dashboard: toDashboard(hit, me.id) })
    } catch (err) {
      fail(res, `Renaming dashboard ${id}`, err)
    }
  })

  api.post('/:id/clone', async (req: Request, res: Response) => {
    const session = res.locals.session as Session
    const id = String(req.params.id)
    const { name } = (req.body ?? {}) as { name?: string }
    try {
      const { hit } = await readableDashboard(session, id)
      // Studio only builds on Retail Sales: a copy of anything else couldn't be edited there.
      if (!(await retailDashboards(session)).some((d) => d.id === id)) return res.status(422).json({ error: 'other-model' })
      const newId = await cloneDashboard(session, id, (name?.trim() || `Copy of ${hit.metadata_name}`).slice(0, 100))
      const copy = await readableDashboard(session, newId)
      res.status(201).json({ dashboard: toDashboard(copy.hit, copy.me.id) })
    } catch (err) {
      fail(res, `Cloning dashboard ${id}`, err)
    }
  })

  api.delete('/:id', async (req: Request, res: Response) => {
    const session = res.locals.session as Session
    const id = String(req.params.id)
    try {
      await ownedDashboard(session, id)
      await tsRest(session.token, 'POST', '/metadata/delete', { metadata: [{ identifier: id, type: 'LIVEBOARD' }] })
      res.status(204).end()
    } catch (err) {
      fail(res, `Deleting dashboard ${id}`, err)
    }
  })

  api.post('/:id/tiles/:vizId', async (req: Request, res: Response) => {
    const session = res.locals.session as Session
    const id = String(req.params.id)
    const vizId = String(req.params.vizId)
    const { answer, title } = (req.body ?? {}) as { answer?: Record<string, unknown>; title?: string }
    if (!answer || typeof answer !== 'object' || !title?.trim()) return res.status(400).json({ error: 'answer-and-title-required' })
    try {
      await ownedDashboard(session, id)
      await replaceTile(session, id, vizId, answer, title.trim().slice(0, 200))
      res.status(204).end()
    } catch (err) {
      fail(res, `Updating tile ${vizId} on ${id}`, err)
    }
  })

  api.post('/:id/tiles/:vizId/draft', async (req: Request, res: Response) => {
    const session = res.locals.session as Session
    const id = String(req.params.id)
    const vizId = String(req.params.vizId)
    try {
      await ownedDashboard(session, id)
      const draft = await createDraft(session, id, vizId)
      res.json(draft)
      void sessionUserRecord(session.token).then((me) => sweepDrafts(session, me.id)).catch(() => {})
    } catch (err) {
      fail(res, `Opening tile ${vizId} on ${id} for editing`, err)
    }
  })

  api.delete('/:id/tiles/:vizId', async (req: Request, res: Response) => {
    const session = res.locals.session as Session
    const id = String(req.params.id)
    const vizId = String(req.params.vizId)
    try {
      await ownedDashboard(session, id)
      await removeTile(session, id, vizId)
      res.status(204).end()
    } catch (err) {
      fail(res, `Removing tile ${vizId} from ${id}`, err)
    }
  })

  return api
}
