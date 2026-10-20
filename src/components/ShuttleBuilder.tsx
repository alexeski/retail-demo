import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Action, ContextType, HostEvent } from '@thoughtspot/visual-embed-sdk'
import { LiveboardEmbed, SearchEmbed, useEmbedRef } from '@thoughtspot/visual-embed-sdk/react'
import type { SpotterVizConfig } from '@thoughtspot/visual-embed-sdk'
import { HIDDEN_BRANDED_ACTIONS, RETAIL_MODEL_ID, RETAIL_MODEL_NAME, WITH_LIVEBOARD_HEADER } from '../thoughtspot'
import { useFillHeight } from '../useFillHeight'

// Studio's Shuttle mode: SpotterViz, ThoughtSpot's AI dashboard agent, branded as
// Shuttle, in the dashboard's edit mode. Its own toolbar carries Save and
// Cancel, and its panel the chat.
//
// The SDK has no setting for SpotterViz's data source: it works from the data
// sources of the charts already on the dashboard. So Studio makes sure there is
// always one on the Retail Sales model: a new (or empty) dashboard first gets a
// "Sales · last 12 months" tile, pinned from a hidden Search on that model. Every
// prompt Studio sends also names the model.

/** Appended to every prompt Studio sends, so Shuttle never reaches for another model. */
const MODEL_INSTRUCTION = `Use only the "${RETAIL_MODEL_NAME}" model.`
const withModel = (prompt: string) => `${prompt.trim()} ${MODEL_INSTRUCTION}`

/**
 * Ready-made briefs: one click fills the brief; they're also the panel's starter
 * prompts, where `summary` is the text on the button: what the dashboard will hold,
 * in about 75 characters (the panel cuts suggestions off at two lines).
 */
const SHUTTLE_BRIEFS = [
  {
    id: 'exec',
    label: 'Exec overview',
    summary: 'Executive overview: sales, profit & margin KPIs, monthly trend, regions',
    prompt:
      'Build an executive overview for the last 12 months: total sales, gross profit and gross margin as KPIs, the monthly sales trend, and sales by store region.',
  },
  {
    id: 'stores',
    label: 'Store operations',
    summary: 'Store operations: foot traffic, transactions, sales per sq ft, bottom 10',
    prompt:
      'Build a store operations dashboard for last month: foot traffic and number of transactions by store, sales per square foot, and the 10 lowest-selling stores.',
  },
  {
    id: 'category',
    label: 'Category & brand',
    summary: 'Category & brand: sales by department, top 10 brands and their margins',
    prompt:
      'Build a category and brand dashboard: monthly sales by department, the top 10 brands by sales with their gross margin, and average ticket size by department.',
  },
  {
    id: 'customers',
    label: 'Customers',
    summary: 'Customers: spend by age group and income, new customers by month',
    prompt: 'Build a customer dashboard: sales and average ticket size by age group, sales by income band, and new customers by month.',
  },
]

const SPOTTER_VIZ: SpotterVizConfig = {
  brandName: 'Shuttle',
  // This cluster's welcome screen shows the headline but not brandName after it
  // (brandName still labels the toolbar button), so the name goes in the headline.
  brandHeadline: 'Hi! I’m Shuttle',
  description: 'Tell me what this dashboard should show. I’ll build the charts from your Retail Sales data, and refine them as we go.',
  inputChatPlaceholder: 'Describe a chart, or a change to one…',
  loaderHeadline: 'Weaving your dashboard…',
  loaderTips: [
    { label: 'Tip', text: 'Name the measure and the breakdown, e.g. “sales by store region”.' },
    { label: 'Tip', text: 'Ask for a change to any tile: “make the trend weekly”.' },
    { label: 'Tip', text: 'Save when you like the result: changes stay a draft until then.' },
  ],
  liveboardBrandName: 'dashboard',
  spotterBrandName: 'Shuttle',
  insightTileBrandName: 'Shuttle insight',
  insightTileViewPlanLabel: 'How Shuttle built this',
  insightTileLoaderText: 'Shuttle is working…',
  customStarterPrompts: SHUTTLE_BRIEFS.map((b) => ({ id: b.id, displayText: b.summary, fullPrompt: withModel(b.prompt) })),
}

/** SpotterViz is the point of this view: everything else stays as on Insights. */
const STUDIO_HIDDEN_ACTIONS = HIDDEN_BRANDED_ACTIONS.filter((a) => a !== Action.SpotterViz)
/** The starter tile's search: one measure on the Retail Sales model. */
const SEED_SEARCH = { searchTokenString: "[Sales] [Transaction Date].'last 12 months'", executeSearch: true }
const SEED_TITLE = 'Sales · last 12 months'
const SEED_FRAME = { height: '600px', width: '900px' }
const CANVAS_FRAME = { height: '100%', width: '100%' }

type Props = {
  dashboardId: string | null
  /** Charts on it, once known: an empty dashboard gets the starter tile first. */
  tiles: number | null
  /** A change reloads the dashboard (after a rename made outside the embed). */
  reloadKey: number
  newName: string
  onCreated: (id: string) => void
  onChanged: () => void
  /** Unsaved SpotterViz work, so Studio can warn before leaving. */
  onDirtyChange: (dirty: boolean) => void
}

export function ShuttleBuilder({ dashboardId, tiles, reloadKey, newName, onCreated, onChanged, onDirtyChange }: Props) {
  /** Dashboards that got their starter tile in this visit (the list may lag behind). */
  const [seeded, setSeeded] = useState<string[]>([])
  if (!dashboardId) return <ShuttleBrief newName={newName} onCreated={onCreated} />
  if (tiles === 0 && !seeded.includes(dashboardId)) {
    return (
      <StarterTile
        target={{ liveboardId: dashboardId }}
        onPinned={() => {
          setSeeded((s) => [...s, dashboardId])
          onChanged()
        }}
        onFailed={() => setSeeded((s) => [...s, dashboardId])}
      >
        <div className="studio-blocked mono-label">Setting this dashboard up on the Retail Sales model…</div>
      </StarterTile>
    )
  }
  return <ShuttleCanvas key={`${dashboardId}:${reloadKey}`} dashboardId={dashboardId} onChanged={onChanged} onDirtyChange={onDirtyChange} />
}

/**
 * Pins the starter tile from a Search that runs off screen (it has to render for
 * the pin to work): into a new dashboard (`newLiveboardName`) or an existing one.
 */
function StarterTile({
  target,
  onPinned,
  onFailed,
  children,
}: {
  target: { liveboardId: string } | { newLiveboardName: string }
  onPinned: (liveboardId: string) => void
  onFailed: (err: unknown) => void
  children?: ReactNode
}) {
  const seedRef = useEmbedRef<typeof SearchEmbed>()
  const pinnedOnce = useRef(false)
  // Read at pin time; the handler itself must stay stable for the SDK's wrapper.
  const latest = useRef({ target, onPinned, onFailed })
  latest.current = { target, onPinned, onFailed }

  const onSeedData = useCallback(async () => {
    const seed = seedRef.current
    if (!seed || pinnedOnce.current) return
    pinnedOnce.current = true
    const { target, onPinned, onFailed } = latest.current
    try {
      const res = (await seed.trigger(HostEvent.Pin, { newVizName: SEED_TITLE, ...target } as never, ContextType.Search)) as unknown
      const r = ((res as { data?: unknown })?.data ?? res) as { liveboardId?: string }
      if (!r?.liveboardId) throw new Error('No dashboard ID came back.')
      onPinned(r.liveboardId)
    } catch (err) {
      console.error('Pinning the starter tile failed', err)
      onFailed(err)
    }
  }, [seedRef])

  return (
    <>
      {children}
      <div className="seed-search" aria-hidden>
        <SearchEmbed
          ref={seedRef}
          frameParams={SEED_FRAME}
          dataSource={RETAIL_MODEL_ID}
          hideDataSources
          useLastSelectedSources={false}
          searchOptions={SEED_SEARCH}
          onData={onSeedData}
        />
      </div>
    </>
  )
}

/** Briefs waiting for the new dashboard's SpotterViz panel, by dashboard ID. */
const pendingBriefs = new Map<string, string>()

/** A new dashboard: the brief, then the starter tile that creates it. */
function ShuttleBrief({ newName, onCreated }: { newName: string; onCreated: (id: string) => void }) {
  const [brief, setBrief] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!brief.trim() || creating) return
    setError(null)
    setCreating(true)
  }

  return (
    <div className="builder is-shuttle">
      <section className="brief" aria-label="Brief Shuttle">
        <header className="brief-head">
          <span className="shuttle-pill is-large" aria-hidden />
          <div>
            <h2 className="brief-h2">What should this dashboard show?</h2>
            <p>
              Write it the way you’d brief an analyst. Shuttle drafts the charts from the Retail Sales data, then you refine them by chatting, and save
              when it looks right.
            </p>
          </div>
        </header>
        <form className="brief-form" onSubmit={submit}>
          <textarea
            value={brief}
            rows={4}
            maxLength={1000}
            placeholder="e.g. A weekly view for regional managers: sales vs last year by region, the top and bottom stores, and foot traffic trends."
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e)
            }}
            disabled={creating}
          />
          <div className="brief-foot">
            <span className="mono-label">{creating ? 'Creating the dashboard…' : '⌘ + Enter to start'}</span>
            <button type="submit" className="btn-primary" disabled={!brief.trim() || creating}>
              {creating ? 'Starting Shuttle…' : '✦ Build it with Shuttle'}
            </button>
          </div>
        </form>
        {error && (
          <p className="pin-error" role="alert">
            {error}
          </p>
        )}
        <div className="brief-starters">
          <span className="mono-label">Or start from</span>
          <div className="brief-starter-list">
            {SHUTTLE_BRIEFS.map((b) => (
              <button key={b.id} type="button" className="brief-starter" onClick={() => setBrief(b.prompt)} disabled={creating}>
                <strong>{b.label}</strong>
                <span>{b.prompt}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {creating && (
        <StarterTile
          target={{ newLiveboardName: newName.trim() || 'Untitled dashboard' }}
          onPinned={(id) => {
            pendingBriefs.set(id, withModel(brief))
            onCreated(id)
          }}
          onFailed={() => {
            setError('Storeloom couldn’t create the dashboard. Try again, or start it with Search.')
            setCreating(false)
          }}
        />
      )}
    </div>
  )
}

/** An existing dashboard in edit mode, with the Shuttle (SpotterViz) panel open. */
function ShuttleCanvas({
  dashboardId,
  onChanged,
  onDirtyChange,
}: {
  dashboardId: string
  onChanged: () => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const embedRef = useEmbedRef<typeof LiveboardEmbed>()
  // Down to the bottom of the window, below the frame's border and padding.
  const [canvasRef, canvasHeight] = useFillHeight<HTMLDivElement>(560, 40)
  /** Shuttle has changed the dashboard since it was last saved. */
  const [dirty, setDirty] = useState(false)

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  // SpotterViz needs edit mode; open its panel once the dashboard has rendered.
  const onRendered = useCallback(() => {
    const embed = embedRef.current
    if (!embed) return
    embed.trigger(HostEvent.Edit, {} as never, ContextType.Liveboard).catch(() => {})
    setTimeout(() => embed.trigger(HostEvent.OpenSpotterVizPanel).catch(() => {}), 600)
  }, [embedRef])

  const onVizInit = useCallback(() => {
    // A brief from the new-dashboard form goes in as the first message.
    const brief = pendingBriefs.get(dashboardId)
    if (brief) {
      pendingBriefs.delete(dashboardId)
      embedRef.current?.trigger(HostEvent.SpotterVizSendUserMessage, { query: brief } as never).catch(() => {})
    }
  }, [dashboardId, embedRef])

  const onResponse = useCallback(() => setDirty(true), [])
  const onSaved = useCallback(() => {
    setDirty(false)
    onChanged()
  }, [onChanged])

  return (
    <div className="builder is-shuttle">
      <section className="dash-body is-flush">
        <div className="dash-frame">
          {/* A fixed, viewport-tall frame (not full height): the Shuttle panel lives
              inside it, and its chat box has to stay on screen. */}
          <div className="shuttle-canvas" ref={canvasRef} style={{ height: canvasHeight }}>
            <LiveboardEmbed
              ref={embedRef}
              liveboardId={dashboardId}
              hiddenActions={STUDIO_HIDDEN_ACTIONS}
              customizations={WITH_LIVEBOARD_HEADER}
              spotterViz={SPOTTER_VIZ}
              showLiveboardTitle={false}
              frameParams={CANVAS_FRAME}
              onLiveboardRendered={onRendered}
              onSpotterVizInit={onVizInit}
              onSpotterVizResponseComplete={onResponse}
              onSave={onSaved}
            />
          </div>
        </div>
      </section>
    </div>
  )
}
