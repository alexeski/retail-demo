import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { CustomActionsPosition, CustomActionTarget, RuntimeFilterOp } from '@thoughtspot/visual-embed-sdk'
import { LiveboardEmbed } from '@thoughtspot/visual-embed-sdk/react'
import { REGION_COLUMN, type FilterUpdate } from '../liveboardFilters'
import { STORE_ACTION_ID, STORE_PICK_ACTION_ID, STORE_SCATTER_VIZ_ID, storeFromPoint, type StoreSelection } from '../storeActions'
import { CountUp } from './CountUp'
import { Sparkline } from './Sparkline'
import { ALL_REGIONS, getRegionKpis, KPI_COLUMNS, REGIONS, type Region, type RegionKpis, type StoreKpis } from '../storePerformance'
import { HIDDEN_BRANDED_ACTIONS, REGION_LIVEBOARD_ID } from '../thoughtspot'
import './StorePerformance.css'

/**
 * Custom actions on the "Sales per Store Sq Ft vs Store Space" chart only:
 * - a header button to pick a store and act on it (works on any chart type,
 *   including the Muze custom chart, which doesn't forward point clicks);
 * - a context-menu action on a clicked store (for charts that support it).
 */
const STORE_CUSTOM_ACTIONS = [
  {
    id: STORE_PICK_ACTION_ID,
    name: '⚡ Act on a store',
    position: CustomActionsPosition.PRIMARY,
    target: CustomActionTarget.VIZ,
    metadataIds: { vizIds: [STORE_SCATTER_VIZ_ID] },
  },
  {
    id: STORE_ACTION_ID,
    name: 'Build store action plan',
    position: CustomActionsPosition.CONTEXTMENU,
    target: CustomActionTarget.VIZ,
    metadataIds: { vizIds: [STORE_SCATTER_VIZ_ID] },
  },
]

const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')

type EventPayload = { data?: Record<string, unknown> } & Record<string, unknown>
const dataOf = (p: unknown) => ((p as EventPayload)?.data ?? p) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

type Props = {
  openRegion: Region | null
  onToggle: (region: Region) => void
  /** Global filters (minus Store Region) the KPI summary should respect. */
  globalFilters: FilterUpdate[]
  embedRef: RefObject<InstanceType<typeof import('@thoughtspot/visual-embed-sdk').LiveboardEmbed> | null>
  /** Must be stable per region: the SDK re-creates the embed when listeners change. */
  onLiveboardRendered: () => void
  onFilterChanged: () => void
  /** A store was picked on the scatter chart; `act` when it came from the custom action. */
  onStorePicked: (store: StoreSelection, act: boolean) => void
  /** The chart-header action: choose a store to act on. */
  onPickRequested: () => void
}

/**
 * Store Performance tab: one row per region with a KPI summary (rendered here,
 * from the ThoughtSpot Search Data API via getRegionKpis), expanding into the
 * Region Performance Liveboard filtered to that region.
 */
export function StorePerformance({
  openRegion,
  onToggle,
  globalFilters,
  embedRef,
  onLiveboardRendered,
  onFilterChanged,
  onStorePicked,
  onPickRequested,
}: Props) {
  // Stable handlers: the SDK re-creates the embed when a listener changes identity.
  const onVizPointClick = useCallback(
    (payload: unknown) => {
      const data = dataOf(payload)
      if (data?.vizId !== STORE_SCATTER_VIZ_ID) return
      const store = storeFromPoint(data.clickedPoint)
      if (store) onStorePicked(store, false)
    },
    [onStorePicked],
  )
  const onCustomAction = useCallback(
    (payload: unknown) => {
      const data = dataOf(payload)
      if (data?.id === STORE_PICK_ACTION_ID) return onPickRequested()
      if (data?.id !== STORE_ACTION_ID) return
      const store = storeFromPoint(data.contextMenuPoints?.clickedPoint)
      if (store) onStorePicked(store, true)
    },
    [onStorePicked, onPickRequested],
  )

  // A region dashboard is only as tall as its few charts, so a dialog opened in it
  // (the charts' Shuttle chat, filters) would be cut off with no way to scroll.
  // While one is open, make the dashboard tall enough and bring it into view.
  const [dialogOpen, setDialogOpen] = useState(false)
  const detailRef = useRef<HTMLDivElement>(null)
  const onDialogOpen = useCallback(() => setDialogOpen(true), [])
  const onDialogClose = useCallback(() => setDialogOpen(false), [])
  useEffect(() => setDialogOpen(false), [openRegion])

  /** Scrolls the open region's dashboard to just under the sticky filter bar. */
  const bringDetailIntoView = useCallback((behavior: ScrollBehavior) => {
    const detail = detailRef.current
    if (!detail) return
    const bar = document.querySelector('.filterbar')
    const top = detail.getBoundingClientRect().top + window.scrollY - (bar?.getBoundingClientRect().height ?? 0)
    window.scrollTo({ top, behavior })
  }, [])
  // Expanding a region shows its dashboard (and gives its dialogs a full screen).
  useEffect(() => {
    if (openRegion) bringDetailIntoView('smooth')
  }, [openRegion, bringDetailIntoView])
  // Jump, not smooth: ThoughtSpot measures the visible area as the dialog opens.
  // Once the dialog has settled (its input takes focus and scrolls the page),
  // show its bottom (the chat's question bar) with as much as fits above it.
  useEffect(() => {
    if (!dialogOpen) return
    bringDetailIntoView('instant')
    const t = setTimeout(() => {
      const frame = detailRef.current?.querySelector('iframe')
      if (!frame) return
      const bar = document.querySelector('.filterbar')?.getBoundingClientRect().height ?? 0
      const box = frame.getBoundingClientRect()
      const bottomAligned = box.bottom + window.scrollY - window.innerHeight
      const topUnderBar = box.top + window.scrollY - bar
      window.scrollTo({ top: Math.max(bottomAligned, topUnderBar), behavior: 'smooth' })
    }, 700)
    return () => clearTimeout(t)
  }, [dialogOpen, bringDetailIntoView])

  const [kpis, setKpis] = useState<StoreKpis | null>(null)
  const [status, setStatus] = useState<{ loading: boolean; error?: string; at?: Date }>({ loading: true })
  const [progress, setProgress] = useState({ done: 0, total: 4 })
  const [attempt, setAttempt] = useState(0)
  const filtersKey = JSON.stringify(globalFilters)

  useEffect(() => {
    let cancelled = false
    setStatus((s) => ({ ...s, loading: true, error: undefined }))
    getRegionKpis(JSON.parse(filtersKey), (done, total) => !cancelled && setProgress({ done, total }))
      .then((k) => {
        if (cancelled) return
        setKpis(k)
        setStatus({ loading: false, at: new Date() })
      })
      .catch((err) => {
        if (cancelled) return
        console.error('Could not load region KPIs', err)
        setStatus({ loading: false, error: 'Couldn’t load the latest figures.' })
      })
    return () => {
      cancelled = true
    }
  }, [filtersKey, attempt])

  const phase = status.error ? 'error' : status.loading ? 'loading' : 'ready'
  // While loading, never show an empty bar: start at a sliver and advance per query.
  const progressPct = phase === 'loading' ? Math.max(6, (progress.done / progress.total) * 100) : 100

  // Applied when the embed loads, so the region shows without an unfiltered flash.
  // The All regions row has none.
  const runtimeFilters = useMemo(
    () =>
      openRegion && openRegion !== ALL_REGIONS
        ? [{ columnName: REGION_COLUMN, operator: RuntimeFilterOp.EQ, values: [openRegion] }]
        : [],
    [openRegion],
  )
  // Highest and lowest region per ranked column; the All regions row is left out.
  const extremes = useMemo(() => {
    const out = new Map<string, { best: Region; worst: Region }>()
    if (!kpis) return out
    for (const c of KPI_COLUMNS) {
      if (!c.ranked) continue
      const sorted = [...kpis.regions].sort((a, b) => b[c.key] - a[c.key])
      const best = sorted[0]
      const worst = sorted[sorted.length - 1]
      // Ties at either end (or all equal): nothing stands out, so flag nothing.
      if (!best || c.format(best[c.key]) === c.format(worst[c.key])) continue
      if (c.format(sorted[1][c.key]) === c.format(best[c.key])) continue
      if (c.format(sorted[sorted.length - 2][c.key]) === c.format(worst[c.key])) continue
      out.set(c.key, { best: best.region, worst: worst.region })
    }
    return out
  }, [kpis])

  const rows: { region: Region; kpis?: RegionKpis }[] = [
    { region: ALL_REGIONS, kpis: kpis?.all },
    ...REGIONS.map((region) => ({ region, kpis: kpis?.regions.find((r) => r.region === region) })),
  ]

  return (
    <div className="regions">
      <div className="regions-bar">
        <span className="regions-title">Stores by region</span>
        <span className="regions-hint">Expand a region for its detailed view</span>
        <span className="regions-legend" aria-hidden>
          <span className="kpi-flag is-best">▲</span> Highest
          <span className="kpi-flag is-worst">▼</span> Lowest across regions
        </span>
        <span className={`regions-status is-${phase}`} aria-live="polite">
          {phase === 'loading' && (
            <>
              <span className="regions-spinner" aria-hidden />
              Syncing figures · {progress.done}/{progress.total}
            </>
          )}
          {phase === 'ready' && (
            <>
              <span className="regions-live-dot" aria-hidden />
              Live · updated {status.at?.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </>
          )}
          {phase === 'error' && (
            <>
              {status.error}
              <button type="button" onClick={() => setAttempt((a) => a + 1)}>
                Retry
              </button>
            </>
          )}
        </span>
      </div>

      <div className={`regions-progress is-${phase}`} aria-hidden>
        <span style={{ width: `${progressPct}%` }} />
      </div>

      <div className={['regions-table', status.loading && kpis && 'is-stale'].filter(Boolean).join(' ')} role="table" aria-busy={status.loading}>
        <div className="regions-head" role="row">
          <span role="columnheader">Region</span>
          <span role="columnheader">Sales · 30d</span>
          {KPI_COLUMNS.map((c) => (
            <span key={c.key} role="columnheader">
              {c.label}
            </span>
          ))}
          <span aria-hidden />
        </div>

        {rows.map(({ region, kpis: k }, i) => {
          const open = region === openRegion
          const classes = ['region', open && 'is-open', region === ALL_REGIONS && 'is-total', k && 'is-ready']
            .filter(Boolean)
            .join(' ')
          return (
            <div key={region} className={classes} role="rowgroup" style={{ '--i': i } as CSSProperties}>
              <button type="button" className="region-row" role="row" aria-expanded={open} onClick={() => onToggle(region)}>
                <span className="region-name">{region}</span>
                <span className="region-trend">
                  {kpis ? (
                    <Sparkline
                      values={kpis.trend.byRegion[region]}
                      days={kpis.trend.days}
                      format={money}
                      label={region}
                      delay={i * 70}
                    />
                  ) : (
                    <span className="kpi-skeleton is-wide" style={{ animationDelay: `${i * 80}ms` }} />
                  )}
                </span>
                {KPI_COLUMNS.map((c, j) => {
                  const ext = extremes.get(c.key)
                  const flag = ext?.best === region ? 'is-best' : ext?.worst === region ? 'is-worst' : ''
                  return k ? (
                    <CountUp
                      key={c.key}
                      className={flag ? `region-kpi ${flag}` : 'region-kpi'}
                      value={k[c.key]}
                      format={c.format}
                      delay={i * 70 + j * 25}
                    />
                  ) : (
                    <span key={c.key} className="region-kpi">
                      <span className="kpi-skeleton" style={{ animationDelay: `${(i + j) * 80}ms` }} />
                    </span>
                  )
                })}
                <span className="region-toggle" aria-hidden>
                  {open ? '−' : '+'}
                </span>
              </button>

              {open && (
                <div className="region-detail" ref={detailRef}>
                  <div className={dialogOpen ? 'insights-embed has-dialog' : 'insights-embed'}>
                    <LiveboardEmbed
                      key={region}
                      ref={embedRef}
                      liveboardId={REGION_LIVEBOARD_ID}
                      runtimeFilters={runtimeFilters}
                      hiddenActions={HIDDEN_BRANDED_ACTIONS}
                      // The current Spotter chat UI for the charts' Shuttle (AskAi) button.
                      updatedSpotterChatPrompt
                      customActions={STORE_CUSTOM_ACTIONS}
                      hideTabPanel
                      // Kept on (and hidden with CSS, see thoughtspot.ts) so OpenFilter works.
                      hideLiveboardHeader={false}
                      fullHeight
                      minimumHeight={480}
                      onLiveboardRendered={onLiveboardRendered}
                      onFilterChanged={onFilterChanged}
                      onVizPointClick={onVizPointClick}
                      onCustomAction={onCustomAction}
                      onDialogOpen={onDialogOpen}
                      onDialogClose={onDialogClose}
                    />
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
