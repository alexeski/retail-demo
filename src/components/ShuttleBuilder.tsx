import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Action, ContextType, HostEvent } from '@thoughtspot/visual-embed-sdk'
import { LiveboardEmbed, SearchEmbed, useEmbedRef } from '@thoughtspot/visual-embed-sdk/react'
import type { SpotterVizConfig } from '@thoughtspot/visual-embed-sdk'
import { HIDDEN_BRANDED_ACTIONS, RETAIL_MODEL_ID, WITH_LIVEBOARD_HEADER } from '../thoughtspot'
import { useFillHeight } from '../useFillHeight'

// Studio's Shuttle mode: SpotterViz, ThoughtSpot's AI dashboard agent, branded as
// Shuttle. SpotterViz lives in a Liveboard's edit mode, so the dashboard has to
// exist first. A new one starts from a "Sales · last 12 months" tile pinned from
// a hidden Search on the Retail Sales model: that creates the dashboard with no
// extra privileges, and ties it to the same model SpotterViz then builds on.

/** Ready-made briefs: one click fills the brief, or sends it to Shuttle. */
const SHUTTLE_BRIEFS = [
  {
    id: 'exec',
    label: 'Exec overview',
    prompt:
      'Build an executive overview for the last 12 months: total sales, gross profit and gross margin as KPIs, the monthly sales trend, and sales by store region.',
  },
  {
    id: 'stores',
    label: 'Store operations',
    prompt:
      'Build a store operations dashboard for last month: foot traffic and number of transactions by store, sales per square foot, and the 10 lowest-selling stores.',
  },
  {
    id: 'category',
    label: 'Category & brand',
    prompt:
      'Build a category and brand dashboard: monthly sales by department, the top 10 brands by sales with their gross margin, and average ticket size by department.',
  },
  {
    id: 'customers',
    label: 'Customers',
    prompt: 'Build a customer dashboard: sales and average ticket size by age group, sales by income band, and new customers by month.',
  },
]

const SPOTTER_VIZ: SpotterVizConfig = {
  brandName: 'Shuttle',
  brandHeadline: 'Hi! I’m',
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
  customStarterPrompts: SHUTTLE_BRIEFS.map((b) => ({ id: b.id, displayText: b.label, fullPrompt: b.prompt })),
}

/** SpotterViz is the point of this view: everything else stays as on Insights. */
const STUDIO_HIDDEN_ACTIONS = HIDDEN_BRANDED_ACTIONS.filter((a) => a !== Action.SpotterViz)
/** The starter tile's search: one measure on the Retail Sales model. */
const SEED_SEARCH = { searchTokenString: "[Sales] [Transaction Date].'last 12 months'", executeSearch: true }
const SEED_TITLE = 'Sales · last 12 months'
const SEED_FRAME = { height: '600px', width: '900px' }
const CANVAS_FRAME = { height: '100%', width: '100%' }

type Phase = 'opening' | 'editing' | 'thinking' | 'draft' | 'saving' | 'saved' | 'error'

type Props = {
  dashboardId: string | null
  /** A change reloads the dashboard (after a rename made outside the embed). */
  reloadKey: number
  newName: string
  onCreated: (id: string) => void
  onChanged: () => void
  /** Unsaved SpotterViz work, so Studio can warn before leaving. */
  onDirtyChange: (dirty: boolean) => void
  onDone: (id: string) => void
}

export function ShuttleBuilder({ dashboardId, reloadKey, newName, onCreated, onChanged, onDirtyChange, onDone }: Props) {
  return dashboardId ? (
    <ShuttleCanvas key={`${dashboardId}:${reloadKey}`} dashboardId={dashboardId} onChanged={onChanged} onDirtyChange={onDirtyChange} onDone={onDone} />
  ) : (
    <ShuttleBrief newName={newName} onCreated={onCreated} />
  )
}

/** Briefs waiting for the new dashboard's SpotterViz panel, by dashboard ID. */
const pendingBriefs = new Map<string, string>()

/** A new dashboard: the brief, then the starter tile that creates it. */
function ShuttleBrief({ newName, onCreated }: { newName: string; onCreated: (id: string) => void }) {
  const [brief, setBrief] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seedRef = useEmbedRef<typeof SearchEmbed>()
  const pinnedOnce = useRef(false)
  const nameRef = useRef(newName)
  nameRef.current = newName
  const briefRef = useRef(brief)
  briefRef.current = brief

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!brief.trim() || creating) return
    pinnedOnce.current = false
    setError(null)
    setCreating(true)
  }

  // The hidden Search has run the starter query: pin it into a new dashboard.
  const onSeedData = useCallback(async () => {
    const seed = seedRef.current
    if (!seed || pinnedOnce.current) return
    pinnedOnce.current = true
    try {
      const name = nameRef.current.trim() || 'Untitled dashboard'
      const res = (await seed.trigger(HostEvent.Pin, { newVizName: SEED_TITLE, newLiveboardName: name } as never, ContextType.Search)) as unknown
      const r = ((res as { data?: unknown })?.data ?? res) as { liveboardId?: string }
      if (!r?.liveboardId) throw new Error('No dashboard ID came back.')
      pendingBriefs.set(r.liveboardId, briefRef.current.trim())
      onCreated(r.liveboardId)
    } catch (err) {
      console.error('Creating the dashboard failed', err)
      setError('Storeloom couldn’t create the dashboard. Try again, or start it with Search.')
      setCreating(false)
    }
  }, [seedRef, onCreated])

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
        // Off-screen, but rendered: the Search has to run for the pin to work.
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
      )}
    </div>
  )
}

/** An existing dashboard in edit mode, with the Shuttle (SpotterViz) panel open. */
function ShuttleCanvas({
  dashboardId,
  onChanged,
  onDirtyChange,
  onDone,
}: {
  dashboardId: string
  onChanged: () => void
  onDirtyChange: (dirty: boolean) => void
  onDone: (id: string) => void
}) {
  const embedRef = useEmbedRef<typeof LiveboardEmbed>()
  // Down to the bottom of the window, below the frame's border and padding.
  const [canvasRef, canvasHeight] = useFillHeight<HTMLDivElement>(560, 40)
  const [phase, setPhase] = useState<Phase>('opening')
  const [prompt, setPrompt] = useState('')
  const [turns, setTurns] = useState(0)
  const [panelOpen, setPanelOpen] = useState(false)
  const dirty = phase === 'draft' || phase === 'thinking'

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
    setPanelOpen(true)
    setPhase((p) => (p === 'opening' ? 'editing' : p))
    // A brief from the new-dashboard form goes in as the first message.
    const brief = pendingBriefs.get(dashboardId)
    if (brief) {
      pendingBriefs.delete(dashboardId)
      embedRef.current?.trigger(HostEvent.SpotterVizSendUserMessage, { query: brief } as never).catch(() => {})
    }
  }, [dashboardId, embedRef])

  const onQuery = useCallback(() => {
    setTurns((t) => t + 1)
    setPhase('thinking')
  }, [])
  const onResponse = useCallback(() => setPhase('draft'), [])
  const onVizError = useCallback(() => setPhase('error'), [])
  const onVizClosed = useCallback(() => setPanelOpen(false), [])
  const onSaved = useCallback(() => {
    setPhase('saved')
    onChanged()
  }, [onChanged])

  const send = (text: string) => {
    if (!text.trim()) return
    const embed = embedRef.current
    if (!panelOpen) embed?.trigger(HostEvent.OpenSpotterVizPanel).catch(() => {})
    embed?.trigger(HostEvent.SpotterVizSendUserMessage, { query: text.trim() } as never).catch(() => {})
    setPrompt('')
  }

  const save = async () => {
    setPhase('saving')
    try {
      await embedRef.current?.trigger(HostEvent.Save, {} as never, ContextType.Liveboard)
      onSaved()
    } catch (err) {
      console.error('Saving the dashboard failed', err)
      setPhase('error')
    }
  }

  const status: Record<Phase, string> = {
    opening: 'Opening the dashboard in edit mode…',
    editing: 'Shuttle is ready · ask for charts on the right',
    thinking: 'Shuttle is building…',
    draft: `Draft · ${turns} ${turns === 1 ? 'request' : 'requests'} · not saved yet`,
    saving: 'Saving…',
    saved: 'Saved',
    error: 'Something went wrong. Check the panel, then try again.',
  }

  return (
    <div className="builder is-shuttle">
      <section className="shuttle-bar" aria-label="Shuttle">
        <div className={`pin-status is-${phase}`} aria-live="polite">
          <span className="pin-status-dot" aria-hidden />
          <span>{status[phase]}</span>
        </div>
        <form
          className="shuttle-ask"
          onSubmit={(e) => {
            e.preventDefault()
            send(prompt)
          }}
        >
          <span className="shuttle-pill" aria-hidden />
          <input value={prompt} placeholder="Ask Shuttle for a chart or a change…" onChange={(e) => setPrompt(e.target.value)} disabled={phase === 'opening'} />
          <button type="submit" disabled={!prompt.trim() || phase === 'opening'} aria-label="Send to Shuttle">
            →
          </button>
        </form>
        <div className="shuttle-bar-actions">
          {!panelOpen && phase !== 'opening' && (
            <button type="button" className="btn-outline" onClick={() => embedRef.current?.trigger(HostEvent.OpenSpotterVizPanel).catch(() => {})}>
              ✦ Open Shuttle
            </button>
          )}
          <button type="button" className="btn-outline" onClick={() => void save()} disabled={phase === 'opening' || phase === 'saving' || phase === 'thinking'}>
            {phase === 'saving' ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              if (dirty && !window.confirm('Shuttle’s latest changes aren’t saved. Leave without saving?')) return
              onDone(dashboardId)
            }}
          >
            Done
          </button>
        </div>
      </section>
      <div className="shuttle-starters" aria-label="Quick requests">
        {SHUTTLE_BRIEFS.map((b) => (
          <button key={b.id} type="button" onClick={() => send(b.prompt)} disabled={phase === 'opening' || phase === 'thinking'} title={b.prompt}>
            ✦ {b.label}
          </button>
        ))}
      </div>

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
              onSpotterVizQueryTriggered={onQuery}
              onSpotterVizResponseComplete={onResponse}
              onSpotterVizError={onVizError}
              onSpotterVizClosed={onVizClosed}
              onSave={onSaved}
            />
          </div>
        </div>
      </section>
    </div>
  )
}
