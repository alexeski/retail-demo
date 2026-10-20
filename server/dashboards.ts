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
 * - DELETE /:id                  deletes a dashboard;
 * - POST   /:id/tiles/:vizId     replaces a tile's answer in place (the builder's live
 *                                link), keeping its position, size and title.
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
  /** Tile titles, in the Liveboard's order. */
  tileNames: string[]
}

const toDashboard = (hit: SearchHit): Dashboard => ({
  id: hit.metadata_id,
  name: hit.metadata_name,
  description: hit.metadata_header?.description ?? '',
  created: hit.metadata_header?.created ?? null,
  modified: hit.metadata_header?.modified ?? null,
  tiles: hit.visualization_headers?.length ?? 0,
  tileNames: (hit.visualization_headers ?? []).flatMap((v) => (v.name ? [v.name] : [])),
})

/** Whether `userId` owns the Liveboard; ThoughtSpot omits `owner` on some releases, so fall back to the author. */
const ownedBy = (hit: SearchHit, userId: string) => (hit.metadata_header?.owner ?? hit.metadata_header?.author) === userId

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
// Live tiles: swap a pinned tile's answer for the one being edited in Search
// ---------------------------------------------------------------------------

type LiveboardTml = {
  guid?: string
  liveboard: {
    name: string
    visualizations?: { id: string; viz_guid?: string; answer: { name?: string } & Record<string, unknown> }[]
  } & Record<string, unknown>
}

type ImportResult = { response?: { status?: { status_code?: string; error_message?: string } } }[]

/**
 * Re-points tile `vizId` at `answer` (the TML of the Search being edited) by
 * round-tripping the Liveboard's TML. Position, size and the tile's identity stay,
 * so the dashboard reads as the same tile, updated. The tile is matched by GUID,
 * or by its title on releases whose export leaves `viz_guid` out.
 */
async function replaceTile(session: Session, id: string, vizId: string, answer: Record<string, unknown>, title: string) {
  const exported = await tsRest<{ edoc: string }[]>(session.token, 'POST', '/metadata/tml/export', {
    metadata: [{ identifier: id, type: 'LIVEBOARD' }],
    export_fqn: true,
    edoc_format: 'JSON',
  })
  const tml = JSON.parse(exported[0]?.edoc ?? '{}') as LiveboardTml
  const vizs = tml.liveboard?.visualizations ?? []
  const tile = vizs.find((v) => v.viz_guid === vizId) ?? vizs.findLast((v) => v.answer?.name === title)
  if (!tile) throw new ThoughtSpotError(404, `Tile ${vizId} is not on dashboard ${id}`)

  // The answer TML from Search names its own GUID; on a Liveboard it has none.
  const { guid: _guid, id: _id, ...rest } = answer
  tile.answer = { ...rest, name: title }

  const result = await tsRest<ImportResult>(session.token, 'POST', '/metadata/tml/import', {
    metadata_tmls: [JSON.stringify(tml)],
    import_policy: 'ALL_OR_NONE',
  })
  const status = result[0]?.response?.status
  if (status?.status_code === 'ERROR') throw new ThoughtSpotError(400, status.error_message ?? 'TML import rejected')
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

  return api
}
