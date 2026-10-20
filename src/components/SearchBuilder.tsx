import { useCallback, useEffect, useRef, useState } from 'react'
import { Action, ContextType, HostEvent } from '@thoughtspot/visual-embed-sdk'
import { LiveboardEmbed, SearchEmbed, useEmbedRef } from '@thoughtspot/visual-embed-sdk/react'
import { DashboardError, replaceTile, titleFromQuery } from '../dashboards'
import { HIDDEN_BRANDED_ACTIONS, RETAIL_MODEL_ID } from '../thoughtspot'
import { DashboardMosaic } from './DashboardMosaic'

// Studio's Search mode: build one chart at a time in an embedded Search (locked
// to the Retail Sales model), pin it, and keep it linked. While linked, each
// change to the search is written to the pinned tile, and the dashboard preview
// beside it reloads.
//
// ThoughtSpot always pins a *copy*, so the link is Storeloom's: the server swaps
// the tile's answer for the search's current TML, in place (server/dashboards.ts).
// Accounts that can't import TML fall back to pinning a fresh copy and removing
// the previous one from the dashboard.

/** Search's own Pin is replaced by the pin panel; the data source can't change. */
const SEARCH_HIDDEN_ACTIONS = [...HIDDEN_BRANDED_ACTIONS, Action.Pin]
const SEARCH_FRAME = { height: '100%', width: '100%' }
const PREVIEW_HIDDEN_ACTIONS = HIDDEN_BRANDED_ACTIONS
/** Quiet time after the last edit before the linked tile is updated. */
const SYNC_DELAY_MS = 1800

type SearchRef = NonNullable<ReturnType<typeof useEmbedRef<typeof SearchEmbed>>['current']>
type PreviewRef = NonNullable<ReturnType<typeof useEmbedRef<typeof LiveboardEmbed>>['current']>

type AnswerTml = { search_query?: string; name?: string } & Record<string, unknown>
type Linked = { dashboardId: string; vizId: string; title: string }
type SyncState = { kind: 'idle' } | { kind: 'pending' } | { kind: 'syncing' } | { kind: 'synced'; at: Date; how: 'in-place' | 'repinned' } | { kind: 'error'; message: string }

const time = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

async function currentAnswer(search: SearchRef): Promise<AnswerTml | null> {
  const tml = (await search.trigger(HostEvent.GetTML, undefined, ContextType.Search).catch(() => null)) as { answer?: AnswerTml } | null
  return tml?.answer ?? null
}

/** HostEvent.Pin answers `{ liveboardId, vizId, tabId }`; some releases nest it under `data`. */
function pinned(res: unknown): { liveboardId: string; vizId: string } | null {
  const r = (res as { data?: unknown })?.data ?? res
  const { liveboardId, vizId } = (r ?? {}) as { liveboardId?: string; vizId?: string }
  return liveboardId && vizId ? { liveboardId, vizId } : null
}

type Props = {
  /** The dashboard being built, or null for a new one (created on the first pin). */
  dashboardId: string | null
  /** Name for the new dashboard, from the Studio bar. */
  newName: string
  /** The first pin created the dashboard. */
  onCreated: (id: string) => void
  /** A tile was added or changed (refreshes the dashboard list's counts). */
  onChanged: () => void
}

export function SearchBuilder({ dashboardId, newName, onCreated, onChanged }: Props) {
  const searchRef = useEmbedRef<typeof SearchEmbed>()
  const previewRef = useEmbedRef<typeof LiveboardEmbed>()
  const [ready, setReady] = useState(false)
  const [hasQuery, setHasQuery] = useState(false)
  const [title, setTitle] = useState('')
  const [suggested, setSuggested] = useState('')
  const [linked, setLinked] = useState<Linked | null>(null)
  const [liveSync, setLiveSync] = useState(true)
  const [sync, setSync] = useState<SyncState>({ kind: 'idle' })
  const [pinning, setPinning] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)
  /** Tiles pinned in this visit, newest first. */
  const [session, setSession] = useState<{ vizId: string; title: string }[]>([])
  const [previewKey, setPreviewKey] = useState(0)

  // Refs mirror state for the SDK's event handlers, which must stay stable.
  const linkedRef = useRef(linked)
  linkedRef.current = linked
  const liveSyncRef = useRef(liveSync)
  liveSyncRef.current = liveSync
  /** The answer TML last written to the linked tile, to skip no-op updates. */
  const syncedAnswer = useRef<string | null>(null)
  /** Once TML import is refused, go straight to re-pinning. */
  const repinOnly = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const syncing = useRef(false)
  const again = useRef(false)

  // A different dashboard ends the link: the tile belongs to the old one.
  useEffect(() => {
    if (linkedRef.current && linkedRef.current.dashboardId !== dashboardId) {
      setLinked(null)
      setSync({ kind: 'idle' })
    }
  }, [dashboardId])

  useEffect(() => () => clearTimeout(timer.current), [])

  const effectiveTitle = (title.trim() || suggested || 'Untitled chart').slice(0, 120)

  /** Writes the search's current state to the linked tile. */
  const syncNow = useCallback(
    async (opts: { force?: boolean; title?: string } = {}) => {
      const link = linkedRef.current
      const search = searchRef.current
      if (!link || !search) return
      if (syncing.current) {
        again.current = true
        return
      }
      syncing.current = true
      clearTimeout(timer.current)
      const tileTitle = opts.title ?? link.title
      try {
        const answer = await currentAnswer(search)
        if (!answer) throw new Error('Search has no chart to sync yet.')
        const key = JSON.stringify(answer) + tileTitle
        if (!opts.force && key === syncedAnswer.current) {
          setSync((s) => (s.kind === 'pending' ? { kind: 'synced', at: new Date(), how: 'in-place' } : s))
          return
        }
        setSync({ kind: 'syncing' })
        let how: 'in-place' | 'repinned' = 'in-place'
        try {
          if (repinOnly.current) throw new DashboardError(403, 'forbidden')
          await replaceTile(link.dashboardId, link.vizId, answer, tileTitle)
        } catch (err) {
          // 403: no TML import privilege; 400: the cluster rejected the swap. Either
          // way a fresh pin (and removing the previous one) keeps the dashboard right.
          if (!(err instanceof DashboardError) || (err.status !== 403 && err.status !== 400)) throw err
          repinOnly.current = true
          how = 'repinned'
          const res = pinned(await search.trigger(HostEvent.Pin, { newVizName: tileTitle, liveboardId: link.dashboardId } as never, ContextType.Search))
          if (!res) throw new Error('Search didn’t confirm the pin.')
          await (previewRef.current as PreviewRef | null)
            ?.trigger(HostEvent.Remove, { vizId: link.vizId } as never, ContextType.Liveboard)
            .catch(() => console.warn('Could not remove the previous version of the tile', link.vizId))
          const next = { ...link, vizId: res.vizId, title: tileTitle }
          linkedRef.current = next
          setLinked(next)
          setSession((s) => s.map((t) => (t.vizId === link.vizId ? { vizId: res.vizId, title: tileTitle } : t)))
        }
        syncedAnswer.current = key
        if (tileTitle !== link.title && how === 'in-place') {
          const next = { ...link, title: tileTitle }
          linkedRef.current = next
          setLinked(next)
          setSession((s) => s.map((t) => (t.vizId === link.vizId ? { ...t, title: tileTitle } : t)))
        }
        setSync({ kind: 'synced', at: new Date(), how })
        setPreviewKey((k) => k + 1)
        onChanged()
      } catch (err) {
        console.error('Live tile update failed', err)
        setSync({ kind: 'error', message: (err as Error).message || 'The dashboard didn’t update.' })
      } finally {
        syncing.current = false
        if (again.current) {
          again.current = false
          void syncNow()
        }
      }
    },
    [searchRef, previewRef, onChanged],
  )

  /** Something in the search changed: suggest a title, and update the linked tile once edits settle. */
  const onSearchChanged = useCallback(() => {
    const search = searchRef.current
    if (search) {
      currentAnswer(search).then((a) => {
        const q = a?.search_query ?? ''
        setHasQuery(!!q.trim())
        setSuggested(titleFromQuery(q))
      })
    }
    if (!linkedRef.current || !liveSyncRef.current) return
    setSync({ kind: 'pending' })
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void syncNow(), SYNC_DELAY_MS)
  }, [searchRef, syncNow])

  const onLoad = useCallback(() => setReady(true), [])

  const pin = async () => {
    const search = searchRef.current
    if (!search) return
    setPinning(true)
    setPinError(null)
    const tileTitle = effectiveTitle
    try {
      const target = dashboardId
        ? { newVizName: tileTitle, liveboardId: dashboardId }
        : { newVizName: tileTitle, newLiveboardName: newName.trim() || `Untitled dashboard · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` }
      const res = pinned(await search.trigger(HostEvent.Pin, target as never, ContextType.Search))
      if (!res) throw new Error('Search didn’t confirm the pin. Check the dashboard, then try again.')
      const answer = await currentAnswer(search)
      syncedAnswer.current = answer ? JSON.stringify(answer) + tileTitle : null
      const link = { dashboardId: res.liveboardId, vizId: res.vizId, title: tileTitle }
      linkedRef.current = link
      setLinked(link)
      setTitle(tileTitle)
      setSession((s) => [{ vizId: res.vizId, title: tileTitle }, ...s])
      setSync({ kind: 'synced', at: new Date(), how: 'in-place' })
      if (!dashboardId) onCreated(res.liveboardId)
      else setPreviewKey((k) => k + 1)
      onChanged()
    } catch (err) {
      console.error('Pin failed', err)
      setPinError((err as Error).message || 'Pinning didn’t work. Try again.')
    } finally {
      setPinning(false)
    }
  }

  const unlink = () => {
    clearTimeout(timer.current)
    setLinked(null)
    setSync({ kind: 'idle' })
    setTitle('')
  }

  const startOver = () => {
    unlink()
    searchRef.current?.trigger(HostEvent.ResetSearch)
    setHasQuery(false)
    setSuggested('')
  }

  const renameLinked = () => {
    if (linked && title.trim() && title.trim() !== linked.title) void syncNow({ force: true, title: title.trim().slice(0, 120) })
  }

  const statusLine = (() => {
    if (!linked) return null
    switch (sync.kind) {
      case 'pending':
        return 'Changes spotted · updating in a moment'
      case 'syncing':
        return 'Updating the dashboard…'
      case 'synced':
        return `Synced ${time(sync.at)}${sync.how === 'repinned' ? ' · re-pinned' : ''}`
      case 'error':
        return sync.message
      default:
        return liveSync ? 'Live: edits update the tile' : 'Paused: sync by hand'
    }
  })()

  return (
    <div className="builder is-search">
      <section className="builder-pane builder-search" aria-label="Search">
        <header className="builder-pane-head">
          <span className="builder-step">01</span>
          <div>
            <strong>Ask a question</strong>
            <span className="mono-label">Type or pick columns · Retail Sales</span>
          </div>
        </header>
        <div className="builder-search-frame">
          {!ready && <div className="builder-loading mono-label">Opening Search…</div>}
          <SearchEmbed
            ref={searchRef}
            frameParams={SEARCH_FRAME}
            dataSource={RETAIL_MODEL_ID}
            hideDataSources
            useLastSelectedSources={false}
            hiddenActions={SEARCH_HIDDEN_ACTIONS}
            onLoad={onLoad}
            onQueryChanged={onSearchChanged}
            onData={onSearchChanged}
            onAnswerChartSwitcher={onSearchChanged}
          />
        </div>
      </section>

      <aside className="builder-side">
        <section className={linked ? 'pin-card is-linked' : 'pin-card'} aria-label="Pin to dashboard">
          <header className="builder-pane-head">
            <span className="builder-step">02</span>
            <div>
              <strong>{linked ? 'Linked to the dashboard' : 'Pin it'}</strong>
              <span className="mono-label">{linked ? 'This search is the tile' : dashboardId ? 'Adds a tile to this dashboard' : 'Creates the dashboard'}</span>
            </div>
          </header>

          <label className="pin-field">
            <span className="mono-label">Chart title</span>
            <input
              value={title}
              placeholder={suggested || 'e.g. Sales by Store Region'}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={renameLinked}
              onKeyDown={(e) => e.key === 'Enter' && (linked ? renameLinked() : hasQuery && void pin())}
            />
          </label>

          {linked ? (
            <>
              <div className={`pin-status is-${sync.kind}`} aria-live="polite">
                <span className="pin-status-dot" aria-hidden />
                <span>{statusLine}</span>
              </div>
              <div className="pin-row">
                <label className="pin-toggle">
                  <input type="checkbox" checked={liveSync} onChange={(e) => setLiveSync(e.target.checked)} />
                  <span className="pin-toggle-track" aria-hidden />
                  <span>Live sync</span>
                </label>
                <button type="button" className="btn-outline" onClick={() => void syncNow({ force: true })} disabled={sync.kind === 'syncing'}>
                  Sync now
                </button>
              </div>
              <div className="pin-row">
                <button type="button" className="btn-outline" onClick={() => void pin()} disabled={pinning || !hasQuery} title="Keep the linked tile as it is and pin this search as another one">
                  {pinning ? 'Pinning…' : '+ Pin as another chart'}
                </button>
                <button type="button" className="btn-outline" onClick={startOver} title="Unlink and clear the search for the next chart">
                  New chart
                </button>
              </div>
            </>
          ) : (
            <>
              <button type="button" className="btn-primary pin-btn" onClick={() => void pin()} disabled={!ready || !hasQuery || pinning}>
                {pinning ? 'Pinning…' : dashboardId ? '⤓ Pin to dashboard' : '⤓ Pin & create dashboard'}
              </button>
              <p className="pin-hint">
                {hasQuery
                  ? 'Once pinned, the tile stays linked: keep editing the search and the dashboard follows.'
                  : 'Build a chart in Search first. Columns come from the Retail Sales model only.'}
              </p>
            </>
          )}
          {pinError && (
            <p className="pin-error" role="alert">
              {pinError}
            </p>
          )}
          {session.length > 1 && (
            <div className="pin-session">
              <span className="mono-label">Pinned this visit · {session.length}</span>
              <ul>
                {session.map((t) => (
                  <li key={t.vizId} className={t.vizId === linked?.vizId ? 'is-linked' : undefined}>
                    {t.title}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="builder-pane builder-preview" aria-label="Dashboard preview">
          <header className="builder-pane-head">
            <span className="builder-step">03</span>
            <div>
              <strong>Your dashboard</strong>
              <span className="mono-label">{dashboardId ? 'Live preview · reloads on each update' : 'Appears after the first pin'}</span>
            </div>
          </header>
          <div className="builder-preview-frame">
            {dashboardId ? (
              <LiveboardEmbed
                key={`${dashboardId}:${previewKey}`}
                ref={previewRef}
                liveboardId={dashboardId}
                hiddenActions={PREVIEW_HIDDEN_ACTIONS}
                fullHeight
                minimumHeight={420}
              />
            ) : (
              <div className="builder-preview-empty">
                <DashboardMosaic seed={newName || 'new'} tiles={0} />
                <span className="mono-label">Nothing pinned yet</span>
              </div>
            )}
          </div>
        </section>
      </aside>
    </div>
  )
}
