import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { LiveboardEmbed } from '@thoughtspot/visual-embed-sdk/react'
import { rebrand } from '../brand'
import { PINNED_CHART_HIDDEN_ACTIONS } from '../chartActions'
import { DashboardMosaic } from '../components/DashboardMosaic'
import { Markdown } from '../components/SpotterTurn'
import { getDashboard } from '../dashboards'
import { RETAIL_MODEL_ID } from '../thoughtspot'
import {
  createAnalysisSession,
  createDashboard,
  dashboardData,
  dashboardIdOf,
  dashboardStatus,
  listTools,
  modifyDashboard,
  sendSessionMessage,
  sessionUpdates,
  type DesignResult,
  type VizData,
} from '../tsMcp'
import { useFillHeight } from '../useFillHeight'
import '../components/SpotterTurn.css'
import './Dashboards.css'
import './Studio.css'
import './Brief.css'

// Brief: a conversation with ShuttleViz (SpotterViz) over ThoughtSpot's Spotter
// MCP Server. The user briefs it, it answers with a plan, the user approves or
// changes it, it builds and styles the dashboard, and then the conversation
// keeps going to refine it. Three ways in: describe it, explore with Shuttle
// first and keep the charts worth keeping, or paste a dashboard from another tool.

type StartMode = 'describe' | 'explore' | 'rebuild'

const START_MODES: { mode: StartMode; icon: string; label: string; sub: string }[] = [
  { mode: 'describe', icon: '✦', label: 'Describe it', sub: 'One sentence is enough' },
  { mode: 'explore', icon: '⌕', label: 'Explore first', sub: 'Ask, then keep the best charts' },
  { mode: 'rebuild', icon: '⧉', label: 'Rebuild one', sub: 'From Tableau, Power BI, a slide…' },
]

const EXAMPLES: Record<StartMode, string[]> = {
  describe: [
    'A weekly trading review for store managers: sales, margin and basket size against last week',
    'Where are we losing margin? By category, brand and region',
    'An executive overview of the last 12 months with the top regions and stores',
  ],
  explore: [
    'How did sales trend over the last 12 months?',
    'Which regions grew fastest this quarter?',
    'Top 10 brands by gross margin',
  ],
  rebuild: [
    'Tableau workbook "Store Pulse": 4 KPI tiles (Sales, Gross Profit, Margin %, Transactions), a monthly sales line by region, a map of sales by state, and a table of the 20 lowest-margin stores. Filters: region, store type.',
  ],
}

const REFINEMENTS = [
  'Put the KPIs in one row at the top',
  'Add a short note under each chart explaining what it shows',
  'Group the store charts into their own tab',
  'Add a chart of sales by store type',
]

/** Sent with the first brief while "Storeloom style" is on: the designer takes brand colours as hex codes. */
const BRAND_STYLE =
  'Style it in the Storeloom brand: ink #17150F for text and outlines, paper #F4EFE4 and card #FFFDF8 backgrounds, accent #E5502A for the main series, periwinkle #B8C6FF and sand #EBE4D4 as secondary colours.'

type Answer = { id: string; title: string; url?: string; query?: string }

type Entry =
  | { id: string; kind: 'you'; text: string; note?: string }
  | { id: string; kind: 'plan'; message: string; choices: string[]; open: boolean }
  | { id: string; kind: 'work'; label: string; steps: string[]; startedAt: number; endedAt?: number; failed?: boolean }
  | { id: string; kind: 'done'; message: string; changed: boolean }
  | { id: string; kind: 'error'; message: string }
  | { id: string; kind: 'analysis'; steps: string[]; text: string; answers: Answer[]; done: boolean }

/** A designer task waiting for the user: its plan or question is open. */
type Task = { id: string; kind: 'create' | 'modify' }

type Saved = {
  entries: Entry[]
  dashboardId: string | null
  title: string
  task: Task | null
  /** A task still building when the page was left: polling resumes on return. */
  running: Task | null
  analysisId: string | null
  kept: string[]
}

const STORE_KEY = 'storeloom.brief'
const EMPTY: Saved = { entries: [], dashboardId: null, title: '', task: null, running: null, analysisId: null, kept: [] }

function load(): Saved {
  let saved: Saved
  try {
    const raw = sessionStorage.getItem(STORE_KEY)
    saved = raw ? { ...EMPTY, ...(JSON.parse(raw) as Saved) } : EMPTY
  } catch {
    return EMPTY
  }
  // Work that was under way when the page went away. With a running task, the
  // page resumes it under a new entry; without one (the first request, before
  // the designer gave it an ID) there's nothing to follow, so say so.
  const entries = saved.entries.map((e): Entry => {
    if (e.kind === 'work' && !e.endedAt)
      return { ...e, endedAt: Date.now(), failed: !saved.running, steps: saved.running ? e.steps : [...e.steps, 'Interrupted: the page was left before ShuttleViz replied.'] }
    if (e.kind === 'analysis' && !e.done) return { ...e, done: true }
    return e
  })
  return { ...saved, entries }
}

function save(s: Saved) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(s))
  } catch {
    // Private mode or full storage: the conversation just won't survive a reload.
  }
}

let seq = 0
const uid = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`

/** A dashboard name from the brief: its first clause, capitalised, at most ~60 characters. */
function titleFrom(text: string) {
  const first = text.trim().split(/[.:\n]/)[0]!.trim()
  const short = first.length > 60 ? `${first.slice(0, 57).replace(/\s+\S*$/, '')}…` : first
  return short ? short[0]!.toUpperCase() + short.slice(1) : 'Untitled dashboard'
}

function useElapsed(start: number, end?: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (end) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [end])
  const s = Math.max(0, Math.round(((end ?? now) - start) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

// ---------------------------------------------------------------------------
// Conversation entries
// ---------------------------------------------------------------------------

function WorkEntry({ entry }: { entry: Extract<Entry, { kind: 'work' }> }) {
  const elapsed = useElapsed(entry.startedAt, entry.endedAt)
  const running = !entry.endedAt
  return (
    <li className={running ? 'bf-entry bf-work is-running' : entry.failed ? 'bf-entry bf-work is-failed' : 'bf-entry bf-work'}>
      <div className="bf-work-head">
        <span className="bf-work-icon" aria-hidden>
          {running ? <span className="sp-shuttle" /> : entry.failed ? '!' : '✓'}
        </span>
        <strong>{entry.label}</strong>
        <span className="mono-label bf-work-time">{elapsed}</span>
      </div>
      {entry.steps.length > 0 && (
        <ol className="bf-steps">
          {entry.steps.map((s, i) => (
            <li key={i} className={running && i === entry.steps.length - 1 ? 'is-current' : undefined}>
              {rebrand(s)}
            </li>
          ))}
        </ol>
      )}
    </li>
  )
}

function AnswerTile({ answer, kept, onToggle }: { answer: Answer; kept: boolean; onToggle?: () => void }) {
  return (
    <figure className={kept ? 'bf-answer is-kept' : 'bf-answer'}>
      <figcaption>
        <span className="bf-answer-title">{rebrand(answer.title)}</span>
        {onToggle && (
          <label className="bf-keep">
            <input type="checkbox" checked={kept} onChange={onToggle} />
            <span>{kept ? 'Kept' : 'Keep'}</span>
          </label>
        )}
      </figcaption>
      {answer.query && <code className="sp-answer-query">{answer.query}</code>}
      {answer.url && (
        <div className="bf-answer-frame">
          <div className="sp-answer-clip">
            <iframe src={answer.url} title={answer.title} loading="lazy" />
          </div>
        </div>
      )}
    </figure>
  )
}

// ---------------------------------------------------------------------------
// The stage: the dashboard itself, or the loom while there's none yet
// ---------------------------------------------------------------------------

function Loom({ seed, weaving }: { seed: string; weaving: boolean }) {
  return (
    <div className={weaving ? 'bf-loom is-weaving' : 'bf-loom'}>
      <DashboardMosaic seed={seed || 'brief'} tiles={7} />
      <p className="bf-loom-note">
        {weaving ? (
          <>
            <span className="sp-shuttle" aria-hidden /> ShuttleViz is weaving your dashboard
          </>
        ) : (
          'Your dashboard takes shape here.'
        )}
      </p>
    </div>
  )
}

function Numbers({ dashboardId, version }: { dashboardId: string; version: number }) {
  const [data, setData] = useState<VizData[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    dashboardData(dashboardId)
      .then((d) => !cancelled && setData(d))
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [dashboardId, version])

  const csv = (v: VizData) =>
    [v.columns, ...v.data_rows].map((row) => row.map((c) => (c == null ? '' : /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',')).join('\n')

  if (error) return <div className="dash-notice is-error">{error}</div>
  if (!data) return <div className="bf-numbers-loading mono-label">Reading the saved charts…</div>
  return (
    <div className="bf-numbers">
      <p className="mono-label bf-numbers-note">The rows behind each chart, read live from the saved dashboard · up to 25 per chart</p>
      {data.map((v, i) => (
        <section key={v.viz_id ?? i} className="bf-table">
          <header>
            <strong>{rebrand(v.viz_name ?? `Chart ${i + 1}`)}</strong>
            <span className="mono-label">
              {v.data_rows.length}
              {v.total_row_count && v.total_row_count > v.data_rows.length ? ` of ${v.total_row_count.toLocaleString()}` : ''} rows
            </span>
            <button type="button" className="btn-outline" onClick={() => void navigator.clipboard?.writeText(csv(v))}>
              Copy CSV
            </button>
          </header>
          <div className="bf-table-scroll">
            <table>
              <thead>
                <tr>
                  {v.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {v.data_rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c} className={typeof cell === 'number' ? 'is-num' : undefined}>
                        {typeof cell === 'number' ? cell.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(cell ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function Brief() {
  const [params, setParams] = useSearchParams()
  const fromUrl = params.get('dashboard')
  const [state, setState] = useState<Saved>(() => {
    const saved = load()
    // Opened on a dashboard (from My dashboards): a fresh conversation about it.
    return fromUrl && fromUrl !== saved.dashboardId ? { ...EMPTY, dashboardId: fromUrl } : saved
  })
  const { entries, dashboardId, title, task, kept } = state
  const [mode, setMode] = useState<StartMode>('describe')
  const [draft, setDraft] = useState('')
  const [name, setName] = useState('')
  const [styled, setStyled] = useState(true)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'dashboard' | 'numbers'>('dashboard')
  /** Bumped when the designer changes the dashboard, so the embed reloads. */
  const [version, setVersion] = useState(0)
  const [canGetData, setCanGetData] = useState(false)
  const [stageRef, stageHeight] = useFillHeight<HTMLDivElement>(560, 24)
  const listRef = useRef<HTMLOListElement>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => save(state), [state])

  const update = useCallback((fn: (s: Saved) => Saved) => setState((s) => fn(s)), [])
  const push = useCallback((entry: Entry) => update((s) => ({ ...s, entries: [...s.entries, entry] })), [update])
  const patch = useCallback(
    (id: string, fn: (e: Entry) => Entry) => update((s) => ({ ...s, entries: s.entries.map((e) => (e.id === id ? fn(e) : e)) })),
    [update],
  )

  // get_data is offered only to users who can download data.
  useEffect(() => {
    listTools()
      .then((tools) => setCanGetData(tools.some((t) => t.name === 'get_data')))
      .catch(() => setCanGetData(false))
  }, [])

  // The dashboard's name, when the conversation starts on an existing one.
  useEffect(() => {
    if (!dashboardId || title) return
    getDashboard(dashboardId)
      .then((d) => update((s) => (s.dashboardId === d.id ? { ...s, title: d.name } : s)))
      .catch(() => undefined)
  }, [dashboardId, title, update])

  // Keep the newest entry in view.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [entries])

  /**
   * Follows one designer request to where it needs the user or ends: relays
   * progress while it's in_progress, opens the plan on needs_input, and shows
   * the dashboard on completed.
   */
  const drive = useCallback(
    async (first: () => Promise<DesignResult>, kind: Task['kind'], label: string) => {
      setBusy(true)
      const workId = uid()
      push({ id: workId, kind: 'work', label, steps: [], startedAt: Date.now() })
      const addStep = (msg?: string) =>
        msg && patch(workId, (e) => (e.kind === 'work' && e.steps[e.steps.length - 1] !== msg ? { ...e, steps: [...e.steps, msg] } : e))
      try {
        let r = await first()
        while (r.status === 'in_progress') {
          if (!r.task_id) throw new Error('ShuttleViz is working but didn’t say on what. Check My dashboards in a few minutes.')
          const running = { id: r.task_id, kind }
          update((s) => (s.running?.id === running.id ? s : { ...s, running }))
          addStep(r.message)
          r = await dashboardStatus(r.task_id)
        }
        patch(workId, (e) => (e.kind === 'work' ? { ...e, endedAt: Date.now(), failed: r.status === 'failed' } : e))
        if (r.status === 'needs_input') {
          push({ id: uid(), kind: 'plan', message: r.message ?? 'ShuttleViz has a question.', choices: r.choices ?? [], open: true })
          update((s) => ({ ...s, running: null, task: r.task_id ? { id: r.task_id, kind } : s.task }))
        } else if (r.status === 'completed') {
          const id = dashboardIdOf(r) ?? stateRef.current.dashboardId
          update((s) => ({ ...s, running: null, task: null, dashboardId: id ?? null }))
          push({ id: uid(), kind: 'done', message: r.message ?? 'Done.', changed: r.changes_applied !== false })
          setVersion((v) => v + 1)
          setView('dashboard')
        } else {
          update((s) => ({ ...s, running: null, task: null }))
          push({ id: uid(), kind: 'error', message: r.message ?? 'ShuttleViz couldn’t finish. Nothing was saved.' })
        }
      } catch (err) {
        patch(workId, (e) => (e.kind === 'work' ? { ...e, endedAt: Date.now(), failed: true } : e))
        update((s) => ({ ...s, running: null }))
        push({ id: uid(), kind: 'error', message: (err as Error).message })
      } finally {
        setBusy(false)
      }
    },
    [push, patch, update],
  )

  // Back on the page while a build was running: keep following it.
  const resumed = useRef(false)
  useEffect(() => {
    const running = stateRef.current.running
    if (resumed.current || !running) return
    resumed.current = true
    void drive(() => dashboardStatus(running.id), running.kind, 'Picking up where ShuttleViz left off')
  }, [drive])

  /** Closes the open plan: the user answered it. */
  const closePlans = () => update((s) => ({ ...s, entries: s.entries.map((e) => (e.kind === 'plan' && e.open ? { ...e, open: false } : e)) }))

  /** The user's reply to the designer's plan or question, sent to whichever tool started the task. */
  const reply = (text: string) => {
    if (!task || !text.trim()) return
    closePlans()
    push({ id: uid(), kind: 'you', text })
    // The task is known, so a reload from here on can pick it up again.
    update((s) => ({ ...s, task: null, running: task }))
    const instructions = text.trim()
    if (task.kind === 'create') void drive(() => createDashboard({ task_id: task.id, instructions }), 'create', 'Building your dashboard')
    else void drive(() => modifyDashboard({ dashboard_id: dashboardId!, task_id: task.id, instructions }), 'modify', 'Changing your dashboard')
  }

  const startDesign = (text: string) => {
    const brief = mode === 'rebuild' ? `Recreate this dashboard from another tool:\n\n${text}` : text
    const dashboardTitle = name.trim() || titleFrom(text)
    update((s) => ({ ...s, title: dashboardTitle }))
    push({ id: uid(), kind: 'you', text, note: [mode === 'rebuild' ? 'Rebuild' : null, styled ? 'Storeloom style' : null].filter(Boolean).join(' · ') || undefined })
    void drive(
      () =>
        createDashboard({
          title: dashboardTitle,
          instructions: styled ? `${brief}\n\n${BRAND_STYLE}` : brief,
          data_source_id: RETAIL_MODEL_ID,
        }),
      'create',
      'Planning with ShuttleViz',
    )
  }

  const refine = (text: string) => {
    if (!dashboardId) return
    push({ id: uid(), kind: 'you', text })
    void drive(() => modifyDashboard({ dashboard_id: dashboardId, instructions: text }), 'modify', 'Changing your dashboard')
  }

  /** One question to Shuttle (the analytics agent), polled until it's answered. */
  const ask = async (question: string) => {
    setBusy(true)
    push({ id: uid(), kind: 'you', text: question })
    const entryId = uid()
    push({ id: entryId, kind: 'analysis', steps: [], text: '', answers: [], done: false })
    try {
      let sessionId = stateRef.current.analysisId
      if (!sessionId) {
        sessionId = await createAnalysisSession(RETAIL_MODEL_ID)
        update((s) => ({ ...s, analysisId: sessionId }))
      }
      await sendSessionMessage(sessionId, question)
      for (;;) {
        const { session_updates: updates, is_done } = await sessionUpdates(sessionId)
        const answers: Answer[] = []
        for (const u of updates) {
          if (u.type === 'answer' && u.answer_id) answers.push({ id: u.answer_id, title: u.answer_title ?? 'Answer', url: u.iframe_url, query: u.answer_query })
        }
        patch(entryId, (e) => {
          if (e.kind !== 'analysis') return e
          let { text, steps } = e
          for (const u of updates) {
            if (u.type === 'step_notification' && u.text && steps[steps.length - 1] !== u.text) steps = [...steps, u.text]
            else if ((u.type === 'text' || u.type === 'text_chunk') && !u.is_thinking && u.text) text += u.text
          }
          return { ...e, text, steps, answers: [...e.answers, ...answers], done: is_done }
        })
        // New charts are kept by default; the user unticks the ones they don't want.
        if (answers.length) update((s) => ({ ...s, kept: [...s.kept, ...answers.map((a) => a.id)] }))
        if (is_done) break
        await new Promise((r) => setTimeout(r, 1200))
      }
    } catch (err) {
      patch(entryId, (e) => (e.kind === 'analysis' ? { ...e, done: true } : e))
      push({ id: uid(), kind: 'error', message: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const allAnswers = entries.flatMap((e) => (e.kind === 'analysis' ? e.answers : []))
  const keptAnswers = allAnswers.filter((a) => kept.includes(a.id))
  const toggleKeep = (id: string) => update((s) => ({ ...s, kept: s.kept.includes(id) ? s.kept.filter((k) => k !== id) : [...s.kept, id] }))

  const buildFromAnswers = () => {
    const dashboardTitle = name.trim() || 'Retail Sales findings'
    update((s) => ({ ...s, title: dashboardTitle }))
    push({ id: uid(), kind: 'you', text: `Make a dashboard from the ${keptAnswers.length} charts I kept.`, note: styled ? 'Storeloom style' : undefined })
    void drive(
      () =>
        createDashboard({
          title: dashboardTitle,
          answers: keptAnswers.map((a) => ({ answer_id: a.id, title: a.title })),
          instructions: styled ? BRAND_STYLE : undefined,
        }),
      'create',
      'Laying out your charts',
    )
  }

  const reset = () => {
    setState(EMPTY)
    setDraft('')
    setName('')
    setView('dashboard')
    if (fromUrl) setParams({}, { replace: true })
  }

  const phase: 'start' | 'explore' | 'reply' | 'refine' = task ? 'reply' : dashboardId ? 'refine' : mode === 'explore' ? 'explore' : 'start'

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    if (phase === 'reply') reply(text)
    else if (phase === 'refine') refine(text)
    else if (phase === 'explore') void ask(text)
    else startDesign(text)
  }

  const started = entries.length > 0
  const seed = (entries.find((e) => e.kind === 'you') as { text?: string } | undefined)?.text ?? ''
  const placeholder =
    phase === 'reply'
      ? 'Change something in the plan, or answer its question…'
      : phase === 'refine'
        ? 'What should change? “Make the KPIs bigger”, “Add a tab for regions”…'
        : phase === 'explore'
          ? 'Ask Shuttle a question about Retail Sales…'
          : mode === 'rebuild'
            ? 'Paste or describe the dashboard: its charts, KPIs, filters and layout…'
            : 'What do you need to see? “A weekly review of sales and margin by region”…'

  return (
    <div className="studio bf-page">
      <section className="studio-head">
        <div className="dash-title">
          <Link to="/dashboards" className="dash-back mono-label">
            ← My dashboards
          </Link>
          <div className="eyebrow">
            <span className="tag">Brief</span>
            <span className="studio-model" title="ShuttleViz and Shuttle read the Retail Sales model here.">
              <span aria-hidden>▣</span> Retail Sales model · fixed
            </span>
            <span className="bf-via" title="Every step runs on ThoughtSpot’s Spotter MCP Server: SpotterViz, Spotter and get_data">
              via ThoughtSpot MCP
            </span>
          </div>
          <h1 className="display studio-h1">{title || (dashboardId ? ' ' : 'Brief ShuttleViz')}</h1>
        </div>
        {started && (
          <button type="button" className="btn-outline" onClick={reset} disabled={busy}>
            ＋ New brief
          </button>
        )}
      </section>

      <div className="bf-workspace" ref={stageRef} style={{ height: stageHeight } as CSSProperties}>
        {/* ---- Conversation ---- */}
        <section className="bf-talk" aria-label="Conversation with ShuttleViz">
          {!started && !dashboardId && (
            <div className="bf-intro">
              <p className="bf-intro-lede">
                Tell ShuttleViz what you need. It comes back with a plan and the data it will use, builds only once you approve, and keeps refining the
                dashboard as you talk.
              </p>
              <div className="studio-modes bf-modes" role="tablist" aria-label="How to start">
                {START_MODES.map((m) => (
                  <button
                    key={m.mode}
                    type="button"
                    role="tab"
                    aria-selected={mode === m.mode}
                    className={mode === m.mode ? 'studio-mode is-active' : 'studio-mode'}
                    onClick={() => setMode(m.mode)}
                  >
                    <span className="studio-mode-icon" aria-hidden>
                      {m.icon}
                    </span>
                    <span className="studio-mode-text">
                      <strong>{m.label}</strong>
                      <span>{m.sub}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {!started && dashboardId && (
            <div className="bf-intro">
              <p className="bf-intro-lede">Tell ShuttleViz how to change this dashboard: layout, styling, new charts, notes, groups or tabs.</p>
            </div>
          )}

          <ol className="bf-entries" ref={listRef}>
            {entries.map((e) => {
              switch (e.kind) {
                case 'you':
                  return (
                    <li key={e.id} className="bf-entry bf-you">
                      <p>{e.text}</p>
                      {e.note && <span className="mono-label bf-you-note">{e.note}</span>}
                    </li>
                  )
                case 'plan':
                  return (
                    <li key={e.id} className={e.open ? 'bf-entry bf-plan is-open' : 'bf-entry bf-plan'}>
                      <span className="mono-label bf-from">ShuttleViz · {e.open ? 'waiting for you' : 'answered'}</span>
                      <Markdown text={e.message} className="bf-md" />
                      {e.open && (
                        <div className="bf-plan-actions">
                          {e.choices.map((c) => (
                            <button key={c} type="button" className="btn-chip" onClick={() => reply(c)} disabled={busy}>
                              {rebrand(c)}
                            </button>
                          ))}
                          {e.choices.length === 0 && (
                            <button type="button" className="btn-primary" onClick={() => reply('Looks good. Build it.')} disabled={busy}>
                              ✓ Build it
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  )
                case 'work':
                  return <WorkEntry key={e.id} entry={e} />
                case 'done':
                  return (
                    <li key={e.id} className="bf-entry bf-done">
                      <span className="mono-label bf-from">ShuttleViz · {e.changed ? 'saved' : 'nothing changed'}</span>
                      <Markdown text={e.message} className="bf-md" />
                    </li>
                  )
                case 'error':
                  return (
                    <li key={e.id} className="bf-entry bf-error" role="alert">
                      {rebrand(e.message)}
                    </li>
                  )
                case 'analysis':
                  return (
                    <li key={e.id} className="bf-entry bf-analysis">
                      <span className="mono-label bf-from">
                        {!e.done && <span className="sp-shuttle" aria-hidden />} Shuttle {e.done ? '' : `· ${rebrand(e.steps[e.steps.length - 1] ?? 'thinking')}`}
                      </span>
                      {e.text && <Markdown text={e.text} className="bf-md" />}
                      {e.answers.map((a) => (
                        <AnswerTile key={a.id} answer={a} kept={kept.includes(a.id)} onToggle={dashboardId ? undefined : () => toggleKeep(a.id)} />
                      ))}
                    </li>
                  )
              }
            })}
          </ol>

          {!dashboardId && keptAnswers.length > 0 && !task && (
            <div className="bf-tray">
              <span>
                <strong>{keptAnswers.length}</strong> {keptAnswers.length === 1 ? 'chart' : 'charts'} kept
              </span>
              <button type="button" className="btn-primary" onClick={buildFromAnswers} disabled={busy}>
                Make it a dashboard →
              </button>
            </div>
          )}

          <form className={busy ? 'bf-composer is-busy' : 'bf-composer'} onSubmit={submit}>
            {phase === 'refine' && !busy && (
              <div className="bf-suggest">
                {REFINEMENTS.map((r) => (
                  <button key={r} type="button" className="bf-suggestion" onClick={() => refine(r)}>
                    {r}
                  </button>
                ))}
              </div>
            )}
            {(phase === 'start' || phase === 'explore') && !started && (
              <div className="bf-suggest">
                {EXAMPLES[mode].map((x) => (
                  <button key={x} type="button" className="bf-suggestion" onClick={() => setDraft(x)}>
                    {x.length > 90 ? `${x.slice(0, 88)}…` : x}
                  </button>
                ))}
              </div>
            )}
            <textarea
              value={draft}
              rows={mode === 'rebuild' && phase === 'start' ? 5 : 2}
              placeholder={busy ? 'ShuttleViz is working…' : placeholder}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) submit(e)
              }}
            />
            <div className="bf-composer-row">
              {((phase === 'start' && !started) || (phase === 'explore' && keptAnswers.length > 0)) && !task && (
                <>
                  <input className="bf-name" value={name} placeholder="Dashboard name (optional)" maxLength={100} onChange={(e) => setName(e.target.value)} />
                  <label className="pin-toggle" title="Sends the Storeloom colours to ShuttleViz as hex codes">
                    <input type="checkbox" checked={styled} onChange={(e) => setStyled(e.target.checked)} />
                    <span className="pin-toggle-track" aria-hidden />
                    <span>Storeloom style</span>
                  </label>
                </>
              )}
              <button type="submit" className="btn-primary bf-send" disabled={busy || !draft.trim()}>
                {phase === 'reply' ? 'Reply' : phase === 'refine' ? 'Change it' : phase === 'explore' ? 'Ask' : 'Brief it'} <span aria-hidden>→</span>
              </button>
            </div>
          </form>
        </section>

        {/* ---- Stage ---- */}
        <section className="bf-stage" aria-label="Dashboard">
          <header className="bf-stage-head">
            <div className="dash-tabs" role="tablist" aria-label="Show">
              <button type="button" role="tab" aria-selected={view === 'dashboard'} className={view === 'dashboard' ? 'dash-tab is-active' : 'dash-tab'} onClick={() => setView('dashboard')}>
                Dashboard
              </button>
              {canGetData && dashboardId && (
                <button type="button" role="tab" aria-selected={view === 'numbers'} className={view === 'numbers' ? 'dash-tab is-active' : 'dash-tab'} onClick={() => setView('numbers')}>
                  The numbers
                </button>
              )}
            </div>
            {dashboardId && (
              <div className="bf-stage-links">
                <Link to={`/studio?mode=search&dashboard=${dashboardId}`} className="studio-open">
                  ⌕ Edit in Studio
                </Link>
                <Link to={`/dashboards/${dashboardId}`} className="studio-open">
                  Open dashboard <span aria-hidden>↗</span>
                </Link>
              </div>
            )}
          </header>
          <div className="bf-stage-body">
            {!dashboardId ? (
              <Loom seed={seed} weaving={entries.some((e) => e.kind === 'work' && !e.endedAt)} />
            ) : view === 'numbers' ? (
              <Numbers dashboardId={dashboardId} version={version} />
            ) : (
              <div className={busy ? 'bf-embed is-changing' : 'bf-embed'}>
                <LiveboardEmbed
                  key={`${dashboardId}-${version}`}
                  liveboardId={dashboardId}
                  hiddenActions={PINNED_CHART_HIDDEN_ACTIONS}
                  hideLiveboardHeader
                  fullHeight
                  minimumHeight={480}
                />
                {busy && (
                  <div className="bf-embed-veil">
                    <span className="sp-shuttle" aria-hidden /> ShuttleViz is changing the dashboard
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
