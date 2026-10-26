import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Action, ContextType, HostEvent } from '@thoughtspot/visual-embed-sdk'
import { LiveboardEmbed, SearchEmbed, useEmbedRef } from '@thoughtspot/visual-embed-sdk/react'
import { chartMenu, EDIT_CHART, PINNED_CHART_HIDDEN_ACTIONS, pickedChartAction, REMOVE_CHART } from '../chartActions'
import { DashboardError, deleteDraft, getDashboard, openDraft, removeTile, replaceTile, titleFromQuery, type Dashboard } from '../dashboards'
import { HIDDEN_BRANDED_ACTIONS, RETAIL_MODEL_ID, WITH_LIVEBOARD_HEADER } from '../thoughtspot'
import { useFillHeight } from '../useFillHeight'
import { DashboardMosaic } from './DashboardMosaic'

// Studio's Search mode. The dashboard fills the workspace; Search and the pin
// panel live in a drawer on its left, which collapses to a rail.
//
// A chart is built in Search (locked to the Retail Sales model), pinned, and
// stays linked: each later change to the search is written to that tile. A chart
// already on the dashboard opens the same way ("Edit in Search" in its menu, or
// ✎ in the drawer's list): the server copies it into a draft Answer that Search
// opens with its chart settings, and the link writes edits back to the tile.
//
// ThoughtSpot always pins a *copy*, so the link is Storeloom's: the server swaps
// the tile's answer for the search's current TML, in place (server/dashboards.ts).
// Accounts that can't import TML fall back to pinning a fresh copy and removing
// the previous one from the dashboard.

/**
 * Search's own Pin is replaced by the pin panel. The data panel stays, so users
 * can pick columns instead of typing, but without its "Choose sources" button:
 * the model is fixed.
 */
const SEARCH_HIDDEN_ACTIONS = [...HIDDEN_BRANDED_ACTIONS, Action.Pin, Action.ChooseDataSources]
const SEARCH_DISABLED_ACTIONS = [Action.ChooseDataSources]
const FILL_FRAME = { height: '100%', width: '100%' }
/** Quiet time after the last edit before the linked tile is updated. */
const SYNC_DELAY_MS = 1800

type SearchRef = NonNullable<ReturnType<typeof useEmbedRef<typeof SearchEmbed>>['current']>
type CanvasRef = NonNullable<ReturnType<typeof useEmbedRef<typeof LiveboardEmbed>>['current']>

type AnswerTml = { search_query?: string; name?: string } & Record<string, unknown>
type Linked = { dashboardId: string; vizId: string; title: string }
type SyncState = { kind: 'idle' } | { kind: 'pending' } | { kind: 'syncing' } | { kind: 'synced'; at: Date; how: 'in-place' | 'repinned' } | { kind: 'error'; message: string }
/** What Search has open: a blank search (`n` bumps to clear it), or a tile's draft Answer. */
type SearchSource = { kind: 'new'; n: number } | { kind: 'draft'; answerId: string }

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

/** What a linked tile's search is compared by, to skip no-op updates. The draft's own name doesn't count. */
const answerKey = (answer: AnswerTml, title: string) => JSON.stringify({ ...answer, name: title })

type Props = {
  /** The dashboard being built, or null for a new one (created on the first pin). */
  dashboardId: string | null
  /** Name for the new dashboard, from the Studio bar. */
  newName: string
  /** A chart to open for editing on arrival (`?edit=<vizId>`). */
  editVizId: string | null
  /** The first pin created the dashboard. */
  onCreated: (id: string) => void
  /** A tile was added or changed (refreshes the dashboard list's counts). */
  onChanged: () => void
  /** `editVizId` has been opened (Studio drops it from the URL). */
  onEditOpened: () => void
  /** The dashboard is open in ThoughtSpot's editor (Studio guards leaving the page). */
  handEditing: boolean
  /** The editor embed, so Studio can save it on the way out. */
  editorRef: ReturnType<typeof useEmbedRef<typeof LiveboardEmbed>>
  /** Search is writing to the dashboard (pinning, syncing, removing): editing by hand waits. */
  onBusyChange: (busy: boolean) => void
  /** The editor closed: saved, or cancelled. */
  onHandEditEnd: (saved: boolean) => void
}

type EditorRef = Props['editorRef']

export function SearchBuilder({
  dashboardId,
  newName,
  editVizId,
  onCreated,
  onChanged,
  onEditOpened,
  handEditing,
  editorRef,
  onBusyChange,
  onHandEditEnd,
}: Props) {
  const searchRef = useEmbedRef<typeof SearchEmbed>()
  const canvasRef = useEmbedRef<typeof LiveboardEmbed>()
  const [workspaceRef, workspaceHeight] = useFillHeight<HTMLDivElement>(560, 16)
  const [drawerOpen, setDrawerOpen] = useState(true)
  const [source, setSource] = useState<SearchSource>({ kind: 'new', n: 0 })
  const [opening, setOpening] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [hasQuery, setHasQuery] = useState(false)
  const [title, setTitle] = useState('')
  const [suggested, setSuggested] = useState('')
  const [linked, setLinked] = useState<Linked | null>(null)
  const [liveSync, setLiveSync] = useState(true)
  const [sync, setSync] = useState<SyncState>({ kind: 'idle' })
  const [pinning, setPinning] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)
  const [canvasKey, setCanvasKey] = useState(0)
  /** The dashboard's charts, re-read after each change. */
  const [charts, setCharts] = useState<Dashboard['charts'] | null>(null)
  /** Tiles pinned in this visit, to mark them in the list. */
  const [pinnedHere, setPinnedHere] = useState<string[]>([])
  /** The chart whose removal waits for confirmation, and the one being removed. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)

  // Refs mirror state for the SDK's event handlers, which must stay stable.
  const linkedRef = useRef(linked)
  linkedRef.current = linked
  const liveSyncRef = useRef(liveSync)
  liveSyncRef.current = liveSync
  /** The answer last written to the linked tile, to skip no-op updates. */
  const syncedAnswer = useRef<string | null>(null)
  /** A tile's draft just opened: its first answer is the baseline, not an edit. */
  const baselinePending = useRef(false)
  /** The status to fall back to when a pending change turns out to be no change. */
  const settled = useRef<SyncState>({ kind: 'idle' })
  /** The draft Answer Search has open, deleted when editing ends. */
  const draftId = useRef<string | null>(null)
  /** Once TML import is refused, go straight to re-pinning. */
  const repinOnly = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const syncing = useRef(false)
  const again = useRef(false)
  /** Bumped per chart opened: a draft for an earlier request is deleted as it arrives. */
  const openSeq = useRef(0)
  /** False once Studio has closed (StrictMode's trial unmount sets it back to true). */
  const mounted = useRef(true)

  const dropDraft = useCallback((keepalive = false) => {
    if (draftId.current) void deleteDraft(draftId.current, keepalive)
    draftId.current = null
  }, [])

  // Leaving Studio (or the tab) ends editing: delete the draft.
  useEffect(() => {
    mounted.current = true
    const onHide = () => dropDraft(true)
    window.addEventListener('pagehide', onHide)
    return () => {
      mounted.current = false
      window.removeEventListener('pagehide', onHide)
      clearTimeout(timer.current)
      dropDraft()
    }
  }, [dropDraft])

  // A different dashboard ends the link: the tile belongs to the old one.
  useEffect(() => {
    if (linkedRef.current && linkedRef.current.dashboardId !== dashboardId) {
      setLinked(null)
      setSync({ kind: 'idle' })
      setTitle('')
      if (draftId.current) {
        dropDraft()
        setSource((s) => ({ kind: 'new', n: s.kind === 'new' ? s.n + 1 : 0 }))
      }
    }
  }, [dashboardId, dropDraft])

  useEffect(() => {
    if (!dashboardId) {
      setCharts(null)
      return
    }
    let cancelled = false
    getDashboard(dashboardId)
      .then((d) => !cancelled && setCharts(d.charts))
      .catch(() => !cancelled && setCharts(null))
    return () => {
      cancelled = true
    }
  }, [dashboardId, canvasKey])

  // ---- Editing by hand: ThoughtSpot's own edit mode (resize, move, notes, tabs…) ----
  // The editor saves the dashboard as it loaded it, so Search and the editor take
  // turns: the drawer closes while editing, and editing waits for pins and syncs.
  // The SDK re-creates an embed when a listener changes identity: these stay stable.
  const handEditingRef = useRef(handEditing)
  handEditingRef.current = handEditing
  const handEditEnd = useRef(onHandEditEnd)
  handEditEnd.current = onHandEditEnd
  const onEditorRendered = useCallback(() => {
    ;(editorRef as EditorRef).current?.trigger(HostEvent.Edit, {} as never, ContextType.Liveboard).catch(() => {})
  }, [editorRef])
  const endHandEdit = useCallback((saved: boolean) => {
    // ThoughtSpot can report one save more than once: only the first ends the edit.
    if (!handEditingRef.current) return
    handEditingRef.current = false
    setCanvasKey((k) => k + 1)
    handEditEnd.current(saved)
  }, [])
  // The drawer closes while editing by hand.
  useEffect(() => {
    if (handEditing) setDrawerOpen(false)
  }, [handEditing])
  const onEditorSave = useCallback(() => endHandEdit(true), [endHandEdit])
  const onEditorCancel = useCallback(() => endHandEdit(false), [endHandEdit])

  const effectiveTitle = (title.trim() || suggested || 'Untitled chart').slice(0, 120)
  const chartName = (vizId: string) => charts?.find((c) => c.id === vizId)?.name ?? 'this chart'

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
        const key = answerKey(answer, tileTitle)
        if (!opts.force && key === syncedAnswer.current) {
          setSync((s) => (s.kind === 'pending' ? settled.current : s))
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
          await (canvasRef.current as CanvasRef | null)
            ?.trigger(HostEvent.Remove, { vizId: link.vizId } as never, ContextType.Liveboard)
            .catch(() => console.warn('Could not remove the previous version of the tile', link.vizId))
          const next = { ...link, vizId: res.vizId, title: tileTitle }
          linkedRef.current = next
          setLinked(next)
          setPinnedHere((p) => [...p.filter((v) => v !== link.vizId), res.vizId])
        }
        syncedAnswer.current = key
        if (tileTitle !== link.title && how === 'in-place') {
          const next = { ...link, title: tileTitle }
          linkedRef.current = next
          setLinked(next)
        }
        settled.current = { kind: 'synced', at: new Date(), how }
        setSync(settled.current)
        setCanvasKey((k) => k + 1)
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
    [searchRef, canvasRef, onChanged],
  )

  /** Something in the search changed: suggest a title, and update the linked tile once edits settle. */
  const onSearchChanged = useCallback(() => {
    const search = searchRef.current
    // A tile's draft is still loading: nothing the user did.
    if (!search || baselinePending.current) return
    currentAnswer(search).then((a) => {
      const q = a?.search_query ?? ''
      setHasQuery(!!q.trim())
      setSuggested(titleFromQuery(q))
    })
    if (!linkedRef.current || !liveSyncRef.current) return
    setSync({ kind: 'pending' })
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void syncNow(), SYNC_DELAY_MS)
  }, [searchRef, syncNow])

  // A blank search is ready once it loads; a tile's draft once its chart has data.
  const onLoad = useCallback(() => {
    if (!baselinePending.current) setReady(true)
  }, [])

  // A tile's draft has its data: what Search shows now is what the tile shows,
  // so it's the baseline later edits are compared with, not an edit itself.
  const onData = useCallback(() => {
    const search = searchRef.current
    if (!search || !baselinePending.current) return onSearchChanged()
    baselinePending.current = false
    currentAnswer(search).then((a) => {
      setReady(true)
      setHasQuery(!!a?.search_query?.trim())
      const link = linkedRef.current
      if (a && link) syncedAnswer.current = answerKey(a, link.title)
    })
  }, [searchRef, onSearchChanged])

  const unlink = () => {
    clearTimeout(timer.current)
    setLinked(null)
    linkedRef.current = null
    settled.current = { kind: 'idle' }
    setSync({ kind: 'idle' })
    setTitle('')
  }

  /** A blank search for the next chart; ends editing a tile's draft. */
  const startOver = () => {
    unlink()
    setHasQuery(false)
    setSuggested('')
    setOpenError(null)
    if (draftId.current) {
      dropDraft()
      setReady(false)
      setSource((s) => ({ kind: 'new', n: s.kind === 'new' ? s.n + 1 : 0 }))
    } else {
      searchRef.current?.trigger(HostEvent.ResetSearch)
    }
  }

  /** Opens a chart that's already on the dashboard in Search, linked to it. */
  const editChart = async (vizId: string) => {
    if (!dashboardId || opening) return
    if (linkedRef.current?.vizId === vizId) {
      setDrawerOpen(true)
      return
    }
    // Finish the current chart first, so its last edits land.
    if (linkedRef.current && sync.kind === 'pending') await syncNow()
    const seq = ++openSeq.current
    setOpening(vizId)
    setOpenError(null)
    setDrawerOpen(true)
    try {
      const draft = await openDraft(dashboardId, vizId)
      // Another chart was opened meanwhile, or Studio closed: this draft isn't needed.
      if (seq !== openSeq.current || !mounted.current) {
        void deleteDraft(draft.answerId)
        return
      }
      dropDraft()
      draftId.current = draft.answerId
      const link = { dashboardId, vizId, title: draft.title }
      clearTimeout(timer.current)
      linkedRef.current = link
      setLinked(link)
      setTitle(draft.title)
      setSuggested('')
      syncedAnswer.current = null
      baselinePending.current = true
      settled.current = { kind: 'idle' }
      setSync({ kind: 'idle' })
      setReady(false)
      setSource({ kind: 'draft', answerId: draft.answerId })
    } catch (err) {
      console.error('Opening the chart failed', err)
      setOpenError(
        err instanceof DashboardError && err.status === 403
          ? 'Your account can’t open dashboard charts for editing (it needs TML access).'
          : (err as Error).message || 'The chart couldn’t be opened.',
      )
    } finally {
      if (seq === openSeq.current) setOpening(null)
    }
  }

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
      syncedAnswer.current = answer ? answerKey(answer, tileTitle) : null
      const link = { dashboardId: res.liveboardId, vizId: res.vizId, title: tileTitle }
      clearTimeout(timer.current)
      linkedRef.current = link
      setLinked(link)
      setTitle(tileTitle)
      setPinnedHere((p) => [...p, res.vizId])
      settled.current = { kind: 'synced', at: new Date(), how: 'in-place' }
      setSync(settled.current)
      if (!dashboardId) onCreated(res.liveboardId)
      else setCanvasKey((k) => k + 1)
      onChanged()
    } catch (err) {
      console.error('Pin failed', err)
      setPinError((err as Error).message || 'Pinning didn’t work. Try again.')
    } finally {
      setPinning(false)
    }
  }

  /** Takes a chart off the dashboard; through TML, or the dashboard's own Remove without the privilege. */
  const remove = async (vizId: string) => {
    if (!dashboardId) return
    setRemoving(vizId)
    setRemoveError(null)
    try {
      try {
        await removeTile(dashboardId, vizId)
      } catch (err) {
        if (!(err instanceof DashboardError) || (err.status !== 403 && err.status !== 400)) throw err
        const canvas = canvasRef.current as CanvasRef | null
        if (!canvas) throw err
        await canvas.trigger(HostEvent.Remove, { vizId } as never, ContextType.Liveboard)
      }
      if (linkedRef.current?.vizId === vizId) startOver()
      setPinnedHere((p) => p.filter((v) => v !== vizId))
      setCharts((c) => c?.filter((x) => x.id !== vizId) ?? null)
      setCanvasKey((k) => k + 1)
      onChanged()
    } catch (err) {
      console.error('Removing the chart failed', err)
      setRemoveError((err as Error).message || 'The chart couldn’t be removed.')
    } finally {
      setRemoving(null)
      setConfirmRemove(null)
    }
  }

  const renameLinked = () => {
    if (linked && title.trim() && title.trim() !== linked.title) void syncNow({ force: true, title: title.trim().slice(0, 120) })
  }

  // The charts' ⋯ menu: Edit in Search and Remove, in place of ThoughtSpot's own.
  const menu = useMemo(() => (dashboardId ? chartMenu(dashboardId, { edit: 'Edit in Search', remove: 'Remove from dashboard' }) : []), [dashboardId])
  const chartAction = useRef<(payload: unknown) => void>(() => {})
  chartAction.current = (payload) => {
    const picked = pickedChartAction(payload, charts ?? [])
    if (!picked) return console.warn('Unrecognised chart action', payload)
    if (picked.action === EDIT_CHART) void editChart(picked.vizId)
    if (picked.action === REMOVE_CHART) setConfirmRemove(picked.vizId)
  }
  const onChartAction = useCallback((payload: unknown) => chartAction.current(payload), [])

  // ?edit=<vizId>: open that chart once the dashboard is known.
  const openedFromUrl = useRef<string | null>(null)
  useEffect(() => {
    if (!editVizId || !dashboardId || openedFromUrl.current === editVizId) return
    openedFromUrl.current = editVizId
    void editChart(editVizId)
    onEditOpened()
    // editChart reads current state; this runs once per requested chart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editVizId, dashboardId])

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
        return liveSync ? 'Live: edits update the chart' : 'Paused: sync by hand'
    }
  })()

  /** Search is writing to the dashboard: editing by hand waits, or the editor would overwrite it. */
  const handBusy = pinning || !!opening || !!removing || sync.kind === 'pending' || sync.kind === 'syncing'
  useEffect(() => onBusyChange(handBusy), [handBusy, onBusyChange])

  const editingExisting = source.kind === 'draft' && !!linked
  const drawerTitle = opening ? 'Opening the chart…' : editingExisting ? 'Editing a chart' : linked ? 'Linked chart' : 'New chart'

  return (
    <div className="workspace" ref={workspaceRef} style={{ height: workspaceHeight }}>
      <section className={drawerOpen ? 'canvas is-drawer-open' : 'canvas'} aria-label="Dashboard">
        {dashboardId && handEditing ? (
          // The editor: ThoughtSpot's edit toolbar (Save, Cancel, add, resize).
          <LiveboardEmbed
            key={`${dashboardId}:${canvasKey}:edit`}
            ref={editorRef}
            liveboardId={dashboardId}
            frameParams={FILL_FRAME}
            hiddenActions={HIDDEN_BRANDED_ACTIONS}
            customizations={WITH_LIVEBOARD_HEADER}
            showLiveboardTitle={false}
            onLiveboardRendered={onEditorRendered}
            onSave={onEditorSave}
            onCancel={onEditorCancel}
          />
        ) : dashboardId ? (
          <LiveboardEmbed
            key={`${dashboardId}:${canvasKey}`}
            ref={canvasRef}
            liveboardId={dashboardId}
            frameParams={FILL_FRAME}
            hiddenActions={PINNED_CHART_HIDDEN_ACTIONS}
            customActions={menu}
            onCustomAction={onChartAction}
          />
        ) : (
          <div className="canvas-empty">
            <DashboardMosaic seed={newName || 'new'} tiles={0} />
            <strong>Your dashboard appears here</strong>
            <span className="mono-label">Build a chart in Search, then pin it</span>
          </div>
        )}
      </section>

      <aside className={drawerOpen ? 'editor is-open' : 'editor'} aria-label="Search and pin" aria-hidden={!drawerOpen} inert={!drawerOpen}>
        <header className="editor-head">
          <span className={linked ? 'builder-step is-live' : 'builder-step'} aria-hidden>
            ⌕
          </span>
          <div className="editor-head-text">
            <strong>{drawerTitle}</strong>
            <span className="mono-label">{editingExisting ? linked!.title : 'Pick columns or type · Retail Sales'}</span>
          </div>
          {(linked || source.kind === 'draft') && (
            <button type="button" className="btn-outline editor-new" onClick={startOver} title="Unlink and start a blank search">
              + New chart
            </button>
          )}
          <button type="button" className="editor-collapse" onClick={() => setDrawerOpen(false)} title="Hide Search to see the whole dashboard" aria-label="Hide Search">
            «
          </button>
        </header>

        <div className="editor-body">
          <section className="editor-search">
            {(!ready || opening) && <div className="builder-loading mono-label">{opening ? `Opening “${chartName(opening)}”…` : 'Opening Search…'}</div>}
            <SearchEmbed
              key={source.kind === 'draft' ? source.answerId : `new-${source.n}`}
              ref={searchRef}
              frameParams={FILL_FRAME}
              dataSource={RETAIL_MODEL_ID}
              answerId={source.kind === 'draft' ? source.answerId : undefined}
              useLastSelectedSources={false}
              collapseDataPanel={false}
              hiddenActions={SEARCH_HIDDEN_ACTIONS}
              disabledActions={SEARCH_DISABLED_ACTIONS}
              disabledActionReason="Studio always uses the Retail Sales model"
              onLoad={onLoad}
              onQueryChanged={onSearchChanged}
              onData={onData}
              onAnswerChartSwitcher={onSearchChanged}
            />
          </section>

          <section className={linked ? 'editor-pin pin-card is-linked' : 'editor-pin pin-card'} aria-label="Pin to dashboard">
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

            {openError && (
              <p className="pin-error" role="alert">
                {openError}
              </p>
            )}

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
                  <button type="button" className="btn-outline" onClick={() => void pin()} disabled={pinning || !hasQuery} title="Keep the linked chart as it is and pin this search as another one">
                    {pinning ? 'Pinning…' : '+ Pin as another chart'}
                  </button>
                  <button type="button" className="btn-outline" onClick={() => setDrawerOpen(false)} title="Hide Search to see the dashboard">
                    See dashboard
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
                    ? 'Once pinned, the chart stays linked: keep editing the search and the dashboard follows.'
                    : 'Pick columns on the left, or type a question. Columns come from the Retail Sales model only.'}
                </p>
              </>
            )}
            {pinError && (
              <p className="pin-error" role="alert">
                {pinError}
              </p>
            )}

            {!!charts?.length && (
              <div className="pin-session">
                <span className="mono-label">On this dashboard · {charts.length}</span>
                <ul>
                  {charts.map((c) => {
                    const isLinked = c.id === linked?.vizId
                    const isNew = !isLinked && pinnedHere.includes(c.id)
                    return (
                      <li key={c.id} className={isLinked ? 'is-linked' : undefined}>
                        <span className="pin-chart-name" title={c.name}>
                          {c.name}
                        </span>
                        {isLinked && <span className="pin-chart-tag">{editingExisting ? 'Editing' : 'Live'}</span>}
                        {isNew && <span className="pin-chart-tag is-new">New</span>}
                        {!isLinked && (
                          <button
                            type="button"
                            className="pin-chart-btn"
                            onClick={() => void editChart(c.id)}
                            disabled={!!opening || !!removing}
                            aria-label={`Edit ${c.name} in Search`}
                            title="Edit in Search"
                          >
                            ✎
                          </button>
                        )}
                        <button
                          type="button"
                          className="pin-chart-btn is-remove"
                          onClick={() => setConfirmRemove(c.id)}
                          disabled={!!removing}
                          aria-label={`Remove ${c.name} from the dashboard`}
                          title="Remove from the dashboard"
                        >
                          ×
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </section>
        </div>
      </aside>

      {!drawerOpen && (
        <button
          type="button"
          className="editor-rail"
          onClick={() => setDrawerOpen(true)}
          disabled={handEditing}
          title={handEditing ? 'Save or cancel your edits by hand first' : 'Show Search'}
        >
          <span className="editor-rail-icon" aria-hidden>
            »
          </span>
          <span className="editor-rail-label">
            {handEditing ? 'Search waits while you edit by hand' : linked ? `Editing · ${linked.title}` : 'Search & pin'}
          </span>
          {linked && <span className={`editor-rail-dot is-${sync.kind}`} aria-hidden />}
        </button>
      )}

      {confirmRemove && (
        <div className="canvas-confirm" role="alertdialog" aria-label="Remove chart">
          <span>
            Remove <strong>“{chartName(confirmRemove)}”</strong> from the dashboard?
          </span>
          {removeError && <span className="canvas-confirm-error">{removeError}</span>}
          <div>
            <button type="button" className="btn-outline" onClick={() => (setConfirmRemove(null), setRemoveError(null))} disabled={!!removing}>
              Keep it
            </button>
            <button type="button" className="btn-primary" onClick={() => void remove(confirmRemove)} disabled={!!removing} autoFocus>
              {removing ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
