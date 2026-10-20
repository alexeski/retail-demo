import express, { type Request, type Response } from 'express'
import { readSession, type Session } from './session.ts'
import { ClusterIdleError, sessionUserRecord, ThoughtSpotError, tsRest } from './thoughtspot.ts'

/**
 * The dashboard builder's API, mounted at /api/dashboards. Everything is scoped
 * to Liveboards the signed-in user created and still owns: the list only shows
 * those, and every change checks ownership here first.
 *
 * - GET    /                     the user's dashboards, most recently changed first;
 * - GET    /:id                  one dashboard's header (404 unless the user owns it);
 * - PATCH  /:id                  renames it (and sets its description);
 * - DELETE /:id                  deletes it;
 * - POST   /:id/tiles/:vizId     replaces a tile's answer in place (the builder's live
 *                                link), keeping its position, size and title;
 * - DELETE /:id/tiles/:vizId     removes a tile.
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
  owner?: string
  created?: number
  modified?: number
}

type SearchHit = {
  metadata_id: string
  metadata_name: string
  metadata_header?: Header
  visualization_headers?: { id: string; name?: string }[]
}

export type Dashboard = {
  id: string
  name: string
  description: string
  created: number | null
  modified: number | null
  tiles: number
  /** Its charts and tables, in the Liveboard's order. */
  charts: { id: string; name: string }[]
}

const toDashboard = (hit: SearchHit): Dashboard => ({
  id: hit.metadata_id,
  name: hit.metadata_name,
  description: hit.metadata_header?.description ?? '',
  created: hit.metadata_header?.created ?? null,
  modified: hit.metadata_header?.modified ?? null,
  tiles: hit.visualization_headers?.length ?? 0,
  charts: (hit.visualization_headers ?? []).map((v) => ({ id: v.id, name: v.name ?? 'Untitled chart' })),
})

/**
 * Whether `userId` owns the Liveboard. That's its `author`, which a transfer of
 * ownership also changes; a header's `owner` is the object's own GUID.
 */
const ownedBy = (hit: SearchHit, userId: string) => hit.metadata_header?.author === userId

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class NotOwnedError extends Error {}

/** The Liveboard if the session's user owns it; NotOwnedError otherwise (also for unknown IDs). */
async function ownedDashboard(session: Session, id: string): Promise<SearchHit> {
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
  if (!hit || !ownedBy(hit, me.id)) throw new NotOwnedError()
  return hit
}

/** Sends the right status for a failed call, logged with `what` for the server output. */
function fail(res: Response, what: string, err: unknown) {
  if (err instanceof NotOwnedError) return res.status(404).json({ error: 'not-found' })
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
    visualizations?: { id: string; viz_guid?: string; answer: { name?: string } & Record<string, unknown> }[]
    layout?: { tiles?: TileRef[]; tabs?: { tiles?: TileRef[] }[] } & Record<string, unknown>
  } & Record<string, unknown>
}

type ImportResult = { response?: { status?: { status_code?: string; error_message?: string } } }[]

/** Exports dashboard `id` as TML, lets `edit` change it, and imports the result over the original. */
async function editTml(session: Session, id: string, edit: (tml: LiveboardTml) => void) {
  const exported = await tsRest<{ edoc: string }[]>(session.token, 'POST', '/metadata/tml/export', {
    metadata: [{ identifier: id, type: 'LIVEBOARD' }],
    export_fqn: true,
    edoc_format: 'JSON',
  })
  const tml = JSON.parse(exported[0]?.edoc ?? '{}') as LiveboardTml
  if (!tml.liveboard) throw new ThoughtSpotError(502, `No TML came back for dashboard ${id}`)
  edit(tml)
  const result = await tsRest<ImportResult>(session.token, 'POST', '/metadata/tml/import', {
    metadata_tmls: [JSON.stringify(tml)],
    import_policy: 'ALL_OR_NONE',
  })
  const status = result[0]?.response?.status
  if (status?.status_code === 'ERROR') throw new ThoughtSpotError(400, status.error_message ?? 'TML import rejected')
}

/** The tile with GUID `vizId`, or by title on releases whose export leaves `viz_guid` out. */
function findTile(tml: LiveboardTml, vizId: string, title?: string) {
  const vizs = tml.liveboard.visualizations ?? []
  const tile = vizs.find((v) => v.viz_guid === vizId) ?? (title ? vizs.findLast((v) => v.answer?.name === title) : undefined)
  if (!tile) throw new ThoughtSpotError(404, `Tile ${vizId} is not on the dashboard`)
  return tile
}

/**
 * Re-points tile `vizId` at `answer` (the TML of the Search being edited).
 * Position, size and the tile's identity stay, so the dashboard reads as the
 * same tile, updated.
 */
const replaceTile = (session: Session, id: string, vizId: string, answer: Record<string, unknown>, title: string) =>
  editTml(session, id, (tml) => {
    const tile = findTile(tml, vizId, title)
    // The answer TML from Search names its own GUID; on a Liveboard it has none.
    const { guid: _guid, id: _id, ...rest } = answer
    tile.answer = { ...rest, name: title }
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
      res.json({ dashboards: hits.filter((h) => ownedBy(h, me.id)).map(toDashboard) })
    } catch (err) {
      fail(res, 'Listing dashboards', err)
    }
  })

  api.get('/:id', async (req: Request, res: Response) => {
    const session = res.locals.session as Session
    try {
      res.json({ dashboard: toDashboard(await ownedDashboard(session, String(req.params.id))) })
    } catch (err) {
      fail(res, 'Reading a dashboard', err)
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
      res.json({ dashboard: toDashboard(await ownedDashboard(session, id)) })
    } catch (err) {
      fail(res, `Renaming dashboard ${id}`, err)
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
