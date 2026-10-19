import { useCallback, useRef, useState } from 'react'
import { HostEvent } from '@thoughtspot/visual-embed-sdk'
import { LiveboardEmbed, useEmbedRef } from '@thoughtspot/visual-embed-sdk/react'
import { AskShuttleBar } from '../components/AskShuttleBar'
import { FilterBar, type LiveboardFilter } from '../components/FilterBar'
import { useShuttle } from '../components/Shuttle'
import { StoreActionPanel } from '../components/StoreActionPanel'
import { StorePerformance } from '../components/StorePerformance'
import {
  activeFilters,
  changedFilters,
  describeFilter,
  filtersMatch,
  mergeRegionSelection,
  REGION_COLUMN,
  resetUpdates,
  snapshotFilters,
  toFilterBarItems,
  withoutRegion,
  type FilterBaseline,
  type FilterUpdate,
  type GetFiltersResult,
} from '../liveboardFilters'
import { shortStoreName, type StoreSelection } from '../storeActions'
import { ALL_REGIONS, type Region } from '../storePerformance'
import { HIDDEN_BRANDED_ACTIONS, INSIGHTS_LIVEBOARD_ID, INSIGHTS_TABS } from '../thoughtspot'
import './Insights.css'

const embeddedTabIds = INSIGHTS_TABS.flatMap((t) => (t.tabId ? [t.tabId] : []))

const formatUpdated = (d: Date) =>
  `Updated ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))])

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Schedule and Share in the page header: hidden for now, kept for later. */
const SHOW_SCHEDULE_AND_SHARE = false

type Embed = NonNullable<ReturnType<typeof useEmbedRef<typeof LiveboardEmbed>>['current']>

const readFilters = (embed: Embed) => withTimeout(embed.trigger(HostEvent.GetFilters), 3000) as Promise<GetFiltersResult>

/**
 * Sends UpdateFilters until the Liveboard reflects every update. UpdateFilters is
 * dropped if it arrives before the Liveboard's data has loaded (and this cluster
 * rejects its promise either way), so check with GetFilters and retry until it sticks.
 */
async function applyFilters(embed: Embed, updates: FilterUpdate[], stillCurrent: () => boolean) {
  for (let attempt = 0; attempt < 10 && stillCurrent(); attempt++) {
    embed
      .trigger(HostEvent.UpdateFilters, { filters: updates as unknown as { column: string; oper: string; values: string[] }[] })
      .catch(() => {})
    await sleep(2000)
    if (!stillCurrent()) return
    const res = await readFilters(embed).catch(() => null)
    if (res && filtersMatch(res, updates)) return
  }
  if (stillCurrent()) console.error('Could not apply Liveboard filters', updates)
}

const regionView = (region: Region) => `region:${region}`

/** Clears the Store Region filter (the region view sets the region at runtime instead). */
const CLEAR_REGION: FilterUpdate = { column: REGION_COLUMN, oper: 'IN', values: [] }

export function Insights() {
  const [tabIndex, setTabIndex] = useState(0)
  const activeTab = INSIGHTS_TABS[tabIndex]
  const [openRegion, setOpenRegion] = useState<Region | null>(null)
  // Store picked on the Store Performance scatter chart, and its action panel.
  const [pickedStore, setPickedStore] = useState<StoreSelection | null>(null)
  /** The action panel: open on a store, or on its store picker (store: null). */
  const [actionPanel, setActionPanel] = useState<{ store: StoreSelection | null } | null>(null)
  const onStorePicked = useCallback((store: StoreSelection, act: boolean) => {
    setPickedStore(store)
    if (act) setActionPanel({ store })
  }, [])
  const onPickRequested = useCallback(() => setActionPanel({ store: null }), [])
  const [loadedAt] = useState(() => new Date())

  // At most one Liveboard is on the page: a main-Liveboard tab, or the Region
  // Performance Liveboard under an open region row. `view` names it.
  const view = activeTab.tabId ?? (activeTab.regions && openRegion ? regionView(openRegion) : undefined)
  const isRegionView = !activeTab.tabId && !!view

  const embedRef = useEmbedRef<typeof LiveboardEmbed>()
  const [renderedView, setRenderedView] = useState<string>()
  const rendered = !!view && renderedView === view
  const [filters, setFilters] = useState<LiveboardFilter[]>([])
  /** How many filters differ from the Liveboard's saved defaults. */
  const [changedCount, setChangedCount] = useState(0)
  const [resetting, setResetting] = useState(false)

  // Each view is a separate embed, so filter selections are carried across by
  // hand: diff against the Liveboard's saved filters on the way out, re-apply the
  // difference once the next view has rendered. Each Liveboard keeps its own
  // baseline, since their saved defaults can differ.
  const baselines = useRef(new Map<string, FilterBaseline>())
  const baselineKey = isRegionView ? 'region' : 'main'
  const carriedFilters = useRef<FilterUpdate[]>([])
  const [globalFilters, setGlobalFilters] = useState<FilterUpdate[]>([])
  const setCarried = (updates: FilterUpdate[]) => {
    carriedFilters.current = updates
    setGlobalFilters(withoutRegion(updates))
  }
  const applying = useRef(false)
  const viewGeneration = useRef(0)

  /** The selection to carry, read from the current view (null until its baseline is known). */
  const selectionFrom = useCallback(
    (res: GetFiltersResult) => {
      const saved = baselines.current.get(baselineKey)
      if (!saved) return null
      const changed = changedFilters(res, saved)
      // Store Region is set per row on the region view, so keep the one from elsewhere.
      return isRegionView ? mergeRegionSelection(changed, carriedFilters.current) : changed
    },
    [isRegionView, baselineKey],
  )

  const refreshChangedCount = useCallback(() => {
    const embed = embedRef.current
    if (!embed || applying.current) return
    readFilters(embed)
      .then((r) => {
        const selection = selectionFrom(r)
        if (!selection) return
        setChangedCount(selection.length)
        // Keep the Store Performance KPI summary in step with the open region's filters.
        if (isRegionView) setGlobalFilters(withoutRegion(selection))
      })
      .catch(() => {})
  }, [embedRef, selectionFrom, isRegionView])

  // The SDK's React wrapper re-creates the embed whenever a prop or listener
  // changes identity, so handlers passed to it must be stable per view.
  const onLiveboardRendered = useCallback(() => {
    setRenderedView(view)
    const embed = embedRef.current
    if (!embed) return
    readFilters(embed)
      .then((r) => {
        setFilters(toFilterBarItems(r))
        // A Liveboard's first render shows its saved state, before anything is carried over.
        if (!baselines.current.has(baselineKey)) baselines.current.set(baselineKey, snapshotFilters(r))
      })
      .catch((err) => console.error('Could not read Liveboard filters', err))

    // On the region view the row sets the region (runtime filter), so also clear any
    // Store Region the Liveboard itself was saved with, which would otherwise intersect.
    const updates = isRegionView ? [...withoutRegion(carriedFilters.current), CLEAR_REGION] : carriedFilters.current
    if (updates.length) {
      const generation = viewGeneration.current
      applying.current = true
      applyFilters(embed, updates, () => viewGeneration.current === generation).finally(() => {
        if (viewGeneration.current !== generation) return
        applying.current = false
        refreshChangedCount()
      })
    }
  }, [view, isRegionView, baselineKey, embedRef, refreshChangedCount])

  /** Captures the current view's selection, then switches to another view. */
  const leaveView = async (switchTo: () => void) => {
    const embed = embedRef.current
    // Mid-apply, the view only shows part of the selection; keep the pending one.
    if (rendered && embed && !applying.current) {
      try {
        const selection = selectionFrom(await readFilters(embed))
        if (selection) setCarried(selection)
      } catch (err) {
        console.error('Could not read Liveboard filters; keeping the previous selection', err)
      }
    }
    viewGeneration.current++
    applying.current = false
    setResetting(false)
    setPickedStore(null)
    setChangedCount(carriedFilters.current.length)
    switchTo()
  }

  const selectTab = (i: number) => {
    if (i !== tabIndex) leaveView(() => setTabIndex(i))
  }

  const toggleRegion = (region: Region) => leaveView(() => setOpenRegion((r) => (r === region ? null : region)))

  const resetFilters = async () => {
    setCarried([])
    const embed = embedRef.current
    const saved = baselines.current.get(baselineKey)
    if (!rendered || !embed || !saved) {
      setChangedCount(0)
      return
    }
    setResetting(true)
    const generation = viewGeneration.current
    try {
      const reset = resetUpdates(await readFilters(embed), saved)
      // Never restore a saved Store Region on the region view: the row decides it.
      const updates = isRegionView ? withoutRegion(reset) : reset
      if (updates.length) {
        applying.current = true
        await applyFilters(embed, updates, () => viewGeneration.current === generation)
      }
    } catch (err) {
      console.error('Could not reset Liveboard filters', err)
    } finally {
      if (viewGeneration.current === generation) {
        applying.current = false
        setResetting(false)
        refreshChangedCount()
      }
    }
  }

  const openFilter = async (f: LiveboardFilter) => {
    // ThoughtSpot sizes the filter modal to the part of the (full-height) iframe in
    // view when it opens, so first bring the iframe's top just under the sticky
    // filter bar. Jump rather than smooth-scroll: a scroll still in progress gets
    // measured and leaves the modal's value list collapsed on laptop-height screens.
    const iframe = document.querySelector('.insights-embed iframe')
    const bar = document.querySelector('.filterbar')
    if (iframe && bar) {
      const top = iframe.getBoundingClientRect().top + window.scrollY - bar.getBoundingClientRect().height
      window.scrollTo({ top, behavior: 'instant' })
      await sleep(150)
    }
    embedRef.current?.trigger(HostEvent.OpenFilter, { column: { columnId: f.columnId } })
  }

  // Ask Shuttle about this tab, with the dashboard's live filters as context.
  const { ask, streaming } = useShuttle()
  const scope =
    isRegionView && openRegion ? `${activeTab.label} · ${openRegion === ALL_REGIONS ? 'all regions' : openRegion}` : activeTab.label
  const askShuttle = async (question: string) => {
    let filters: FilterUpdate[] = carriedFilters.current
    const embed = embedRef.current
    if (embed && rendered) {
      filters = await readFilters(embed)
        .then(activeFilters)
        .catch(() => carriedFilters.current)
    }
    // The open region is a runtime filter, which GetFilters doesn't report.
    if (isRegionView) {
      filters = withoutRegion(filters)
      if (openRegion && openRegion !== ALL_REGIONS) filters.push({ column: REGION_COLUMN, oper: 'IN', values: [openRegion] })
    }
    const phrases = filters.map(describeFilter)
    ask(question, {
      scope,
      tag: [scope, ...phrases].join(' · '),
      preamble:
        `I'm looking at the ${scope} view of the Retail Sales dashboard` +
        (phrases.length
          ? `, filtered to: ${phrases.join('; ')}. Apply exactly these filters when answering.`
          : ', with no filters applied.'),
    })
  }

  const trigger = (event: HostEvent.AIHighlights | HostEvent.Schedule | HostEvent.Share | HostEvent.DownloadAsPdf) =>
    embedRef.current?.trigger(event)

  return (
    <div className="insights">
      <section className="insights-head">
        <div className="insights-title">
          <div className="eyebrow">
            <span className="tag">Insights</span>
            <span>{formatUpdated(loadedAt)}</span>
          </div>
          <h1 className="display insights-h1">Retail sales</h1>
        </div>
        <div className="insights-actions">
          {!activeTab.regions && (
            <button
              type="button"
              className="btn-outline btn-ai"
              onClick={() => trigger(HostEvent.AIHighlights)}
              disabled={!rendered}
              title="AI highlights for the dashboard on screen"
            >
              <span aria-hidden>✦</span> Shuttle Highlights
            </button>
          )}
          {activeTab.regions && pickedStore && (
            <button
              type="button"
              className="btn-act"
              onClick={() => setActionPanel({ store: pickedStore })}
              title="Build an action plan for the store selected on the chart"
            >
              <span aria-hidden>⚡</span> Act on {shortStoreName(pickedStore.name)}
            </button>
          )}
          {SHOW_SCHEDULE_AND_SHARE && (
            <>
              <button type="button" className="btn-outline" onClick={() => trigger(HostEvent.Schedule)} disabled={!rendered}>
                Schedule
              </button>
              <button type="button" className="btn-outline" onClick={() => trigger(HostEvent.Share)} disabled={!rendered}>
                Share
              </button>
            </>
          )}
          <button type="button" className="btn-primary" onClick={() => trigger(HostEvent.DownloadAsPdf)} disabled={!rendered}>
            Download PDF
          </button>
        </div>
      </section>

      <FilterBar
        filters={filters}
        enabled={rendered}
        onOpen={openFilter}
        changedCount={changedCount}
        resetting={resetting}
        onReset={resetFilters}
        locked={isRegionView ? { column: REGION_COLUMN, reason: 'Set by the region row you expand below' } : undefined}
      />

      <AskShuttleBar scope={scope} questions={activeTab.questions} onAsk={askShuttle} busy={streaming} />

      <nav className="insights-tabs" role="tablist">
        {INSIGHTS_TABS.map((t, i) => (
          <button
            key={t.label}
            type="button"
            role="tab"
            aria-selected={i === tabIndex}
            className={i === tabIndex ? 'insights-tab is-active' : 'insights-tab'}
            onClick={() => selectTab(i)}
          >
            <span className="insights-tab-n">{String(i + 1).padStart(2, '0')}</span>
            {t.label}
          </button>
        ))}
      </nav>

      <section className="insights-body">
        <div className="insights-frame">
          {/* This cluster ignores in-place tab switches (SetActiveTab / SetVisibleTabs),
              so each tab gets its own embed instance opened on that tab. */}
          {activeTab.tabId && (
            <div className="insights-embed">
              <LiveboardEmbed
                key={activeTab.tabId}
                ref={embedRef}
                liveboardId={INSIGHTS_LIVEBOARD_ID}
                activeTabId={activeTab.tabId}
                visibleTabs={embeddedTabIds}
                hiddenActions={HIDDEN_BRANDED_ACTIONS}
                // The current Spotter chat UI for the charts' Shuttle (AskAi) button.
                updatedSpotterChatPrompt
                hideTabPanel
                // Kept on (and hidden with CSS, see thoughtspot.ts) so OpenFilter works.
                hideLiveboardHeader={false}
                fullHeight
                minimumHeight={640}
                onLiveboardRendered={onLiveboardRendered}
                onFilterChanged={refreshChangedCount}
              />
            </div>
          )}

          {activeTab.regions && (
            <StorePerformance
              openRegion={openRegion}
              onToggle={toggleRegion}
              globalFilters={globalFilters}
              embedRef={embedRef}
              onLiveboardRendered={onLiveboardRendered}
              onFilterChanged={refreshChangedCount}
              onStorePicked={onStorePicked}
              onPickRequested={onPickRequested}
            />
          )}

          {activeTab.placeholder && (
            <div className="placeholder-grid">
              {activeTab.placeholder.map((v) => (
                <div key={v.title} className="placeholder-tile" style={{ gridColumn: `span ${v.span}` }}>
                  <div className="placeholder-tile-head">
                    <span>{v.title}</span>
                    <span className="placeholder-tile-sub">{v.sub}</span>
                  </div>
                  <div className="placeholder-tile-body" style={{ height: v.h }}>
                    <span>{v.kind}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {actionPanel && (
        <StoreActionPanel
          store={actionPanel.store}
          region={openRegion && openRegion !== ALL_REGIONS ? openRegion : undefined}
          onClose={() => setActionPanel(null)}
          onPick={(store) => {
            setPickedStore(store)
            setActionPanel({ store })
          }}
          // Plan launched: the store's ⚡ button has done its job.
          onLaunched={() => setPickedStore(null)}
        />
      )}
    </div>
  )
}
