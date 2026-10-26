import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ContextType, HostEvent } from '@thoughtspot/visual-embed-sdk'
import { LiveboardEmbed, useEmbedRef } from '@thoughtspot/visual-embed-sdk/react'
import { rebrand } from '../brand'
import { PINNED_CHART_HIDDEN_ACTIONS } from '../chartActions'
import { DashboardMosaic } from '../components/DashboardMosaic'
import { EditableTitle } from '../components/EditableTitle'
import { SHUTTLE_BRIEFS } from '../components/ShuttleBuilder'
import { Markdown } from '../components/SpotterTurn'
import { getDashboard, listDashboards, renameDashboard, tileCount, type Dashboard } from '../dashboards'
import { usePaths } from '../experience'
import { HIDDEN_BRANDED_ACTIONS, RETAIL_MODEL_ID, WITH_LIVEBOARD_HEADER } from '../thoughtspot'
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
import { LAB_STORE_PREFIX } from '../tsMcp'
import { useFillHeight } from '../useFillHeight'
import '../components/SpotterTurn.css'
import './Dashboards.css'
import './Studio.css'
import './Lab.css'

// Dashboard Lab's ShuttleViz: a conversation over ThoughtSpot's
// Spotter MCP Server (SpotterViz designs, Spotter analyses). The user briefs it,
// it answers with a plan, the user approves or changes it, it builds and styles
// the dashboard, and the conversation keeps going to refine it. Two ways in:
// describe it, or explore first and keep the charts worth keeping. Separate
// from Studio and its embedded ShuttleViz, so the two can be compared.

type StartMode = 'describe' | 'explore'

const START_MODES: { mode: StartMode; icon: string; label: string; sub: string }[] = [
  { mode: 'describe', icon: '✦', label: 'Describe it', sub: 'One sentence is enough' },
  { mode: 'explore', icon: '⌕', label: 'Explore first', sub: 'Ask, then keep the best charts' },
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

/** The hand editor fills its panel (see `.lab-embed.is-editing`). */
const EDITOR_FRAME = { height: '100%', width: '100%' }

/** Sent with the first request after the user edited the dashboard by hand. */
const KEEP_HAND_EDITS =
  'The user has changed this dashboard by hand since your last change (layout, sizes, notes or tiles). Keep their changes unless they ask otherwise.'

/** Sent with every request: text the designer writes onto the dashboard is read by Storeloom users. */
const VOCABULARY = 'In any text you write on the dashboard, call it a dashboard, never a Liveboard, and don’t mention ThoughtSpot or Spotter.'

const withVocabulary = (instructions: string) => `${instructions}\n\n${VOCABULARY}`

type Answer = { id: string; title: string; url?: string; query?: string }

type Entry =
  | { id: string; kind: 'you'; text: string; note?: string }
  | { id: string; kind: 'plan'; message: string; choices: string[]; open: boolean }
  | { id: string; kind: 'work'; label: string; steps: string[]; startedAt: number; endedAt?: number; failed?: boolean }
  | { id: string; kind: 'done'; message: string; changed: boolean }
  | { id: string; kind: 'error'; message: string }
  | { id: string; kind: 'manual' }
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
  /** The user changed the dashboard by hand since ShuttleViz last did: tell it to keep those changes. */
  handEdited?: boolean
}

/**
 * One saved conversation per route: `new` while a dashboard is being made, then
 * the dashboard's ID (`/lab/<id>`). Kept for the tab, so a reload picks up where
 * it was.
 */
const storeKey = (key: string) => `${LAB_STORE_PREFIX}${key}`
const EMPTY: Saved = { entries: [], dashboardId: null, title: '', task: null, running: null, analysisId: null, kept: [] }

/** Clears the saved new-dashboard conversation, for a fresh start. */
export function forgetNewLabConversation() {
  try {
    sessionStorage.removeItem(storeKey('new'))
  } catch {
    // Nothing was kept.
  }
}

function load(key: string): Saved {
  const blank = key === 'new' ? EMPTY : { ...EMPTY, dashboardId: key }
  let saved: Saved
  try {
    const raw = sessionStorage.getItem(storeKey(key))
    saved = raw ? { ...blank, ...(JSON.parse(raw) as Saved) } : blank
  } catch {
    return blank
  }
  // Work that was under way when the page went away. With a running task, the
  // page resumes it under a new entry; without one (the first request, before
  // the designer gave it an ID) there's nothing to follow, so say so.
  const entries = saved.entries.map((e): Entry => {
    if (e.kind === 'work' && !e.endedAt && !saved.running)
      return { ...e, endedAt: Date.now(), failed: true, steps: [...e.steps, 'Interrupted: the page was left before ShuttleViz replied.'] }
    if (e.kind === 'analysis' && !e.done) return { ...e, done: true }
    return e
  })
  return { ...saved, entries }
}

function save(key: string, s: Saved) {
  try {
    sessionStorage.setItem(storeKey(key), JSON.stringify(s))
  } catch {
    // Private mode or full storage: the conversation just won't survive a reload.
  }
}

let seq = 0
const uid = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`

/** A dashboard name from the brief: its first clause without the instruction, capitalised, at most ~60 characters. */
/** How a brief tends to start ("Build an…", "Create a…", "Show me…"): not part of the name. */
const BRIEF_LEAD = /^(?:please\s+)?(?:(?:build|create|make|design|draft|put together|give|show)(?:\s+(?:me|us))?|i\s+(?:need|want)|we\s+(?:need|want))\s+(?:(?:an?|the)\s+)?/i

function titleFrom(text: string) {
  const first = text.trim().split(/[.:\n]/)[0]!.trim().replace(BRIEF_LEAD, '')
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

/** ShuttleViz reports a step as "Its tool\nWhat it's doing": the tool as a label, the rest as a note. */
function StepText({ text }: { text: string }) {
  const [label, ...rest] = text.split('\n')
  return (
    <>
      <span className="lab-step-label">{label}</span>
      {rest.length > 0 && <span className="lab-step-note">{rest.join(' ')}</span>}
    </>
  )
}

function WorkEntry({ entry }: { entry: Extract<Entry, { kind: 'work' }> }) {
  const elapsed = useElapsed(entry.startedAt, entry.endedAt)
  const running = !entry.endedAt
  return (
    <li className={running ? 'lab-entry lab-work is-running' : entry.failed ? 'lab-entry lab-work is-failed' : 'lab-entry lab-work'}>
      <div className="lab-work-head">
        <span className="lab-work-icon" aria-hidden>
          {running ? <span className="sp-shuttle" /> : entry.failed ? '!' : '✓'}
        </span>
        <strong>{entry.label}</strong>
        <span className="mono-label lab-work-time">{elapsed}</span>
      </div>
      {entry.steps.length > 0 && (
        <ol className="lab-steps">
          {entry.steps.map((s, i) => (
            <li key={i} className={running && i === entry.steps.length - 1 ? 'is-current' : undefined}>
              <StepText text={rebrand(s)} />
            </li>
          ))}
        </ol>
      )}
    </li>
  )
}

function AnswerTile({ answer, kept, onToggle }: { answer: Answer; kept: boolean; onToggle?: () => void }) {
  return (
    <figure className={kept ? 'lab-answer is-kept' : 'lab-answer'}>
      <figcaption>
        <span className="lab-answer-title">{rebrand(answer.title)}</span>
        {onToggle && (
          <label className="lab-keep">
            <input type="checkbox" checked={kept} onChange={onToggle} />
            <span>{kept ? 'Kept' : 'Keep'}</span>
          </label>
        )}
      </figcaption>
      {answer.query && <code className="sp-answer-query">{answer.query}</code>}
      {answer.url && (
        <div className="lab-answer-frame">
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
    <div className={weaving ? 'lab-loom is-weaving' : 'lab-loom'}>
      <DashboardMosaic seed={seed || 'brief'} tiles={7} />
      <p className="lab-loom-note">
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

type Cell = VizData['data_rows'][number][number]

/**
 * How to show one column: get_data returns raw values, so dates come as epoch
 * seconds (bucketed by the column's "Month(…)"-style name) and percentages as
 * fractions.
 */
function columnFormat(name: string, values: Cell[]): (v: Cell) => string {
  const nums = values.filter((v): v is number => typeof v === 'number')
  const bucket = name.match(/^(Day|Week|Month|Quarter|Year)\(/i)?.[1]?.toLowerCase()
  if ((bucket || /date/i.test(name)) && nums.length && nums.every((v) => v > 1e8 && v < 1e11)) {
    const opts: Intl.DateTimeFormatOptions =
      bucket === 'year' ? { year: 'numeric' } : bucket === 'month' || bucket === 'quarter' ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' }
    const fmt = new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' })
    return (v) => (typeof v === 'number' ? fmt.format(v * 1000) : String(v ?? '—'))
  }
  if (/%/.test(name) && nums.length && nums.every((v) => Math.abs(v) <= 1)) {
    return (v) => (typeof v === 'number' ? `${(v * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : String(v ?? '—'))
  }
  return (v) => (typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v ?? '—'))
}

/** While exploring: the charts kept so far, laid out as the dashboard-to-be. */
function DraftBoard({ answers, onRemove }: { answers: Answer[]; onRemove: (id: string) => void }) {
  return (
    <div className="lab-draft">
      <p className="mono-label lab-numbers-note">
        Draft · {answers.length} {answers.length === 1 ? 'chart' : 'charts'} kept · ShuttleViz lays them out and styles them when you make it a dashboard
      </p>
      <div className="lab-draft-grid">
        {answers.map((a) => (
          <figure key={a.id} className="lab-answer is-kept">
            <figcaption>
              <span className="lab-answer-title">{rebrand(a.title)}</span>
              <button type="button" className="lab-draft-remove" aria-label={`Remove ${a.title}`} title="Don’t keep this chart" onClick={() => onRemove(a.id)}>
                ×
              </button>
            </figcaption>
            {a.url && (
              <div className="lab-answer-frame">
                <div className="sp-answer-clip">
                  <iframe src={a.url} title={a.title} loading="lazy" />
                </div>
              </div>
            )}
          </figure>
        ))}
      </div>
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

  const formats = useMemo(() => data?.map((v) => v.columns.map((name, c) => columnFormat(name, v.data_rows.map((row) => row[c] ?? null)))) ?? [], [data])

  if (error) return <div className="dash-notice is-error">{error}</div>
  if (!data) return <div className="lab-numbers-loading mono-label">Reading the saved charts…</div>
  return (
    <div className="lab-numbers">
      <p className="mono-label lab-numbers-note">The rows behind each chart, read live from the saved dashboard · up to 25 per chart</p>
      {data.map((v, i) => (
        <section key={v.viz_id ?? i} className="lab-table">
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
          <div className="lab-table-scroll">
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
                        {formats[i]![c]!(cell)}
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

/**
 * The conversation and the dashboard, filling the window below the bar. Its own
 * component so it measures itself whenever it appears: a new dashboard opens on
 * the brief screen, and the workspace only mounts once the brief is sent.
 */
function Workspace({ className, children }: { className: string; children: ReactNode }) {
  const [ref, height] = useFillHeight<HTMLDivElement>(560, 24)
  return (
    <div className={className} ref={ref} style={{ height }}>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/** The route: each conversation (`new`, or a dashboard's ID) is its own instance. */
export function LabBuilderRoute() {
  const { id = 'new' } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  // Arriving from "Build with ShuttleViz" starts a new dashboard from scratch; a
  // reload (no such state) picks the saved conversation up instead.
  const fresh = id === 'new' && !!(location.state as { fresh?: boolean } | null)?.fresh
  if (fresh) forgetNewLabConversation()
  useEffect(() => {
    if (fresh) navigate(location.pathname + location.search, { replace: true, state: null })
  }, [fresh, navigate, location.pathname, location.search])
  return <LabBuilder key={id} id={id} />
}

/** `/lab/new` starts a dashboard; `/lab/<id>` continues one. Rendered with `key={id}`, so each gets its own conversation. */
export function LabBuilder({ id }: { id: string }) {
  const navigate = useNavigate()
  const paths = usePaths()
  const [state, setState] = useState<Saved>(() => load(id))
  const { entries, dashboardId, title, task, kept } = state
  const [params] = useSearchParams()
  const [mode, setMode] = useState<StartMode>(() => (params.get('mode') === 'explore' ? 'explore' : 'describe'))
  const [draft, setDraft] = useState('')
  const [name, setName] = useState('')
  const [styled, setStyled] = useState(true)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'dashboard' | 'numbers'>('dashboard')
  /** The dashboard across the whole workspace, conversation folded away. */
  const [focus, setFocus] = useState(false)
  /** Bumped when the designer changes the dashboard, so the embed reloads. */
  const [version, setVersion] = useState(0)
  const [canGetData, setCanGetData] = useState(false)
  const listRef = useRef<HTMLOListElement>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    // A new dashboard that now exists moves to its own address, conversation and all.
    if (id === 'new' && state.dashboardId) {
      save(state.dashboardId, state)
      forgetNewLabConversation()
      if (!busy) navigate(paths.shuttleViz(state.dashboardId), { replace: true })
      return
    }
    save(id, state)
  }, [id, state, busy, navigate, paths])

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
    async (first: () => Promise<DesignResult>, kind: Task['kind'], label: string, resumeId?: string) => {
      setBusy(true)
      const workId = resumeId ?? uid()
      if (!resumeId) push({ id: workId, kind: 'work', label, steps: [], startedAt: Date.now() })
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
    const open = stateRef.current.entries.findLast((e) => e.kind === 'work' && !e.endedAt)
    void drive(() => dashboardStatus(running.id), running.kind, 'Picking up where ShuttleViz left off', open?.id)
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
    if (task.kind === 'create') void drive(() => createDashboard({ task_id: task.id, instructions: withVocabulary(instructions) }), 'create', 'Building your dashboard')
    else
      void drive(
        () => modifyDashboard({ dashboard_id: dashboardId!, task_id: task.id, instructions: withVocabulary(instructions) }),
        'modify',
        'Changing your dashboard',
      )
  }

  const startDesign = (text: string) => {
    const brief = text
    const dashboardTitle = name.trim() || titleFrom(text)
    update((s) => ({ ...s, title: dashboardTitle }))
    push({ id: uid(), kind: 'you', text, note: styled ? 'Storeloom style' : undefined })
    void drive(
      () =>
        createDashboard({
          title: dashboardTitle,
          instructions: withVocabulary(styled ? `${brief}\n\n${BRAND_STYLE}` : brief),
          data_source_id: RETAIL_MODEL_ID,
        }),
      'create',
      'Planning with ShuttleViz',
    )
  }

  const refine = (text: string) => {
    if (!dashboardId) return
    push({ id: uid(), kind: 'you', text })
    const handEdited = stateRef.current.handEdited
    if (handEdited) update((s) => ({ ...s, handEdited: false }))
    const instructions = withVocabulary(handEdited ? `${text}\n\n${KEEP_HAND_EDITS}` : text)
    void drive(() => modifyDashboard({ dashboard_id: dashboardId, instructions }), 'modify', 'Changing your dashboard')
  }

  // ---- Editing by hand: ThoughtSpot's own edit mode, without its SpotterViz agent ----
  // ShuttleViz saves the dashboard itself, and the editor saves what it loaded, so
  // the two take turns: no editing while ShuttleViz works or waits on a plan, and
  // no messages to ShuttleViz until the edits are saved or cancelled.
  const editorRef = useEmbedRef<typeof LiveboardEmbed>()
  const [editing, setEditing] = useState(false)
  // ThoughtSpot can report one save more than once: only the first ends the edit.
  const editingRef = useRef(false)
  editingRef.current = editing
  const canEdit = !!dashboardId && !busy && !task
  const onEditorRendered = useCallback(() => {
    editorRef.current?.trigger(HostEvent.Edit, {} as never, ContextType.Liveboard).catch(() => {})
  }, [editorRef])
  const onHandSaved = useCallback(() => {
    if (!editingRef.current) return
    editingRef.current = false
    setEditing(false)
    setVersion((v) => v + 1)
    update((s) => ({ ...s, handEdited: true, entries: [...s.entries, { id: uid(), kind: 'manual' }] }))
  }, [update])
  const onHandCancelled = useCallback(() => {
    if (!editingRef.current) return
    editingRef.current = false
    setEditing(false)
    setVersion((v) => v + 1)
  }, [])
  // Unsaved edits live in the editor only: warn before the tab is closed or reloaded.
  useEffect(() => {
    if (!editing) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [editing])

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
        // The same answer can arrive more than once (as it's drafted, then final): keep the latest.
        const seen = new Set(stateRef.current.entries.flatMap((e) => (e.kind === 'analysis' ? e.answers.map((a) => a.id) : [])))
        const answers: Answer[] = []
        for (const u of updates) {
          if (u.type !== 'answer' || !u.answer_id || seen.has(u.answer_id)) continue
          seen.add(u.answer_id)
          answers.push({ id: u.answer_id, title: u.answer_title ?? 'Answer', url: u.iframe_url, query: u.answer_query })
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

  const allAnswers = [...new Map(entries.flatMap((e) => (e.kind === 'analysis' ? e.answers : [])).map((a) => [a.id, a])).values()]
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
          instructions: withVocabulary(styled ? BRAND_STYLE : 'Organise these charts into a clear dashboard.'),
        }),
      'create',
      'Laying out your charts',
    )
  }

  const startOver = () => {
    forgetNewLabConversation()
    if (id === 'new') {
      setState(EMPTY)
      setDraft('')
      setName('')
    } else navigate(paths.shuttleViz())
  }

  const pickMode = (m: StartMode) => {
    if (m === mode) return
    setMode(m)
    // Each mode has its own examples: what was typed for one doesn't carry over.
    setDraft('')
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

  // The user's dashboards, for the Dashboard picker in the bar (as in Studio).
  const [mine, setMine] = useState<Dashboard[] | null>(null)
  useEffect(() => {
    listDashboards()
      .then(setMine)
      .catch(() => setMine([]))
  }, [version])
  const owned = !!dashboardId && !!mine?.some((d) => d.id === dashboardId)

  const rename = async (next: string) => {
    if (busy) throw new Error('Wait for ShuttleViz to finish, then rename.')
    if (editing) throw new Error('Save or cancel your edits first, then rename.')
    const renamed = await renameDashboard(dashboardId!, next)
    update((s) => ({ ...s, title: renamed.name }))
    setMine((l) => l?.map((d) => (d.id === renamed.id ? renamed : d)) ?? null)
    setVersion((v) => v + 1)
  }

  const pickDashboard = (next: string) => {
    if (next === (dashboardId ?? '')) return
    navigate(paths.shuttleViz(next || null), next ? undefined : { state: { fresh: true } })
  }

  /** Studio's brief screen, for a new dashboard: ShuttleViz starts from one description. */
  const [brief, setBrief] = useState('')
  const submitBrief = (e?: FormEvent) => {
    e?.preventDefault()
    if (!brief.trim() || busy) return
    const text = brief.trim()
    setBrief('')
    startDesign(text)
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
          : 'What do you need to see? “A weekly review of sales and margin by region”…'

  return (
    <div className="studio lab-page">
      <section className="studio-head">
        <div className="dash-title">
          <Link to={paths.home} className="dash-back mono-label">
            ← My dashboards
          </Link>
          <div className="eyebrow">
            <span className="tag">ShuttleViz</span>
            <span className="lab-beta">Dashboard Lab</span>
          </div>
          {dashboardId && title && owned ? (
            <EditableTitle name={title} className="display studio-h1" onRename={rename} />
          ) : (
            <h1 className="display studio-h1">{title || (dashboardId ? ' ' : name.trim() || 'New dashboard')}</h1>
          )}
        </div>
        <div className="lab-head-actions">
          {id === 'new' && started && !dashboardId && (
            <button type="button" className="btn-outline" onClick={startOver} disabled={busy}>
              ↺ Start over
            </button>
          )}
          {/* As in Studio: switch to Search on the same dashboard. */}
          <div className="studio-modes" role="tablist" aria-label="How to build">
            <button
              type="button"
              role="tab"
              aria-selected={false}
              className="studio-mode"
              disabled={busy || editing}
              onClick={() => navigate(paths.search(dashboardId))}
            >
              <span className="studio-mode-icon" aria-hidden>
                ⌕
              </span>
              <span className="studio-mode-text">
                <strong>Search</strong>
                <span>Chart by chart</span>
              </span>
            </button>
            <button type="button" role="tab" aria-selected className="studio-mode is-active">
              <span className="studio-mode-icon" aria-hidden>
                ✦
              </span>
              <span className="studio-mode-text">
                <strong>ShuttleViz</strong>
                <span>Talk it through</span>
              </span>
            </button>
          </div>
        </div>
      </section>

      {/* As in Studio: which dashboard, its name while it's new, and a way to open it. */}
      <section className="studio-bar">
        <label className="studio-target">
          <span className="studio-bar-label">Dashboard</span>
          <select value={dashboardId ?? ''} onChange={(e) => pickDashboard(e.target.value)} disabled={busy || editing || !mine}>
            <option value="">＋ New dashboard</option>
            {mine && mine.length > 0 && (
              <optgroup label="Yours">
                {mine.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} · {tileCount(d.tiles)}
                  </option>
                ))}
              </optgroup>
            )}
            {dashboardId && mine && !owned && <option value={dashboardId}>{title || 'This dashboard'}</option>}
          </select>
        </label>
        {!dashboardId && (
          <label className="studio-name">
            <span className="studio-bar-label">Name</span>
            <input value={name} placeholder="Named from your brief" maxLength={100} onChange={(e) => setName(e.target.value)} disabled={started} />
          </label>
        )}
        <span className="studio-bar-note">{dashboardId ? 'Changes go to this dashboard' : 'Created when you send the brief; built once you approve the plan'}</span>
        {dashboardId && (
          <Link to={paths.view(dashboardId)} className="studio-open">
            Open dashboard <span aria-hidden>↗</span>
          </Link>
        )}
      </section>

      {id === 'new' && !started && mode === 'describe' ? (
        <div className="builder is-shuttle">
          <section className="brief" aria-label="Brief ShuttleViz">
            <header className="brief-head">
              <span className="shuttle-pill is-large" aria-hidden />
              <div>
                <h2 className="brief-h2">What should this dashboard show?</h2>
                <p>
                  Write it the way you’d brief an analyst. ShuttleViz comes back with a plan and the Retail Sales data it will use, builds and styles the
                  dashboard once you approve, then keeps refining it as you talk. You can also edit it by hand at any point.
                </p>
              </div>
            </header>
            <form className="brief-form" onSubmit={submitBrief}>
              <textarea
                value={brief}
                rows={4}
                maxLength={1000}
                placeholder="e.g. A weekly view for regional managers: sales vs last year by region, the top and bottom stores, and foot traffic trends."
                onChange={(e) => setBrief(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitBrief(e)
                }}
              />
              <div className="brief-foot">
                <label className="pin-toggle lab-brief-style" title="Sends the Storeloom colours to ShuttleViz as hex codes">
                  <input type="checkbox" checked={styled} onChange={(e) => setStyled(e.target.checked)} />
                  <span className="pin-toggle-track" aria-hidden />
                  <span>Storeloom style</span>
                </label>
                <span className="mono-label">⌘ + Enter to start</span>
                <button type="submit" className="btn-primary" disabled={!brief.trim()}>
                  ✦ Plan it with ShuttleViz
                </button>
              </div>
            </form>
            <div className="brief-starters">
              <span className="mono-label">Or start from</span>
              <div className="brief-starter-list">
                {SHUTTLE_BRIEFS.map((b) => (
                  <button key={b.id} type="button" className="brief-starter" onClick={() => setBrief(b.prompt)}>
                    <strong>{b.label}</strong>
                    <span>{b.prompt}</span>
                  </button>
                ))}
              </div>
            </div>
            <button type="button" className="lab-explore-instead" onClick={() => pickMode('explore')}>
              <span className="studio-mode-icon" aria-hidden>
                ⌕
              </span>
              <span>
                <strong>Not sure yet? Explore first.</strong> Ask Shuttle questions about Retail Sales, keep the charts worth keeping, and turn them into a
                dashboard.
              </span>
              <span className="mode-card-cta">
                Explore <span aria-hidden>→</span>
              </span>
            </button>
          </section>
        </div>
      ) : (
        <Workspace className={focus && dashboardId ? 'lab-workspace is-focus' : 'lab-workspace'}>
          {/* ---- Conversation ---- */}
          <section className="lab-talk" aria-label="Conversation with ShuttleViz">
            {!started && !dashboardId && (
              <div className="lab-intro">
                <p className="lab-intro-lede">
                  Tell ShuttleViz what you need. It comes back with a plan and the data it will use, builds only once you approve, and keeps refining the
                  dashboard as you talk.
                </p>
                <div className="studio-modes lab-modes" role="tablist" aria-label="How to start">
                  {START_MODES.map((m) => (
                    <button
                      key={m.mode}
                      type="button"
                      role="tab"
                      aria-selected={mode === m.mode}
                      className={mode === m.mode ? 'studio-mode is-active' : 'studio-mode'}
                      onClick={() => pickMode(m.mode)}
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
              <div className="lab-intro">
                <p className="lab-intro-lede">Tell ShuttleViz how to change this dashboard: layout, styling, new charts, notes, groups or tabs.</p>
              </div>
            )}

            <ol className="lab-entries" ref={listRef}>
              {entries.map((e) => {
                switch (e.kind) {
                  case 'you':
                    return (
                      <li key={e.id} className="lab-entry lab-you">
                        <p>{e.text}</p>
                        {e.note && <span className="mono-label lab-you-note">{e.note}</span>}
                      </li>
                    )
                  case 'plan':
                    return (
                      <li key={e.id} className={e.open ? 'lab-entry lab-plan is-open' : 'lab-entry lab-plan'}>
                        <span className="mono-label lab-from">ShuttleViz · {e.open ? 'waiting for you' : 'answered'}</span>
                        <Markdown text={e.message} className="lab-md" />
                        {e.open && (
                          <div className="lab-plan-actions">
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
                      <li key={e.id} className="lab-entry lab-done">
                        <span className="mono-label lab-from">ShuttleViz · {e.changed ? 'saved' : 'nothing changed'}</span>
                        <Markdown text={e.message} className="lab-md" />
                      </li>
                    )
                  case 'error':
                    return (
                      <li key={e.id} className="lab-entry lab-error" role="alert">
                        {rebrand(e.message)}
                      </li>
                    )
                  case 'manual':
                    return (
                      <li key={e.id} className="lab-entry lab-manual">
                        <span aria-hidden>✎</span> You edited the dashboard by hand · saved
                      </li>
                    )
                  case 'analysis':
                    return (
                      <li key={e.id} className="lab-entry lab-analysis">
                        <span className="mono-label lab-from">
                          {!e.done && <span className="sp-shuttle" aria-hidden />} Shuttle {e.done ? '' : `· ${rebrand(e.steps[e.steps.length - 1] ?? 'thinking')}`}
                        </span>
                        {e.answers.map((a) => (
                          <AnswerTile key={a.id} answer={a} kept={kept.includes(a.id)} onToggle={dashboardId ? undefined : () => toggleKeep(a.id)} />
                        ))}
                        {e.text && <Markdown text={e.text} className="lab-md" />}
                      </li>
                    )
                }
              })}
            </ol>

            {!dashboardId && keptAnswers.length > 0 && !task && (
              <div className="lab-tray">
                <span>
                  <strong>{keptAnswers.length}</strong> {keptAnswers.length === 1 ? 'chart' : 'charts'} kept
                </span>
                <button type="button" className="btn-primary" onClick={buildFromAnswers} disabled={busy}>
                  Make it a dashboard →
                </button>
              </div>
            )}

            <form className={busy || editing ? 'lab-composer is-busy' : 'lab-composer'} onSubmit={submit}>
              {editing && (
                <p className="lab-editing-note" role="status">
                  <strong>You’re editing by hand.</strong> Save or cancel in the toolbar above the dashboard to keep talking to ShuttleViz.
                </p>
              )}
              {phase === 'refine' && !busy && !editing && (
                <div className="lab-suggest">
                  {REFINEMENTS.map((r) => (
                    <button key={r} type="button" className="lab-suggestion" onClick={() => refine(r)}>
                      {r}
                    </button>
                  ))}
                </div>
              )}
              {(phase === 'start' || phase === 'explore') && !started && (
                <div className="lab-suggest">
                  {EXAMPLES[mode].map((x) => (
                    <button key={x} type="button" className="lab-suggestion" onClick={() => setDraft(x)}>
                      {x.length > 90 ? `${x.slice(0, 88)}…` : x}
                    </button>
                  ))}
                </div>
              )}
              <textarea
                value={draft}
                rows={2}
                placeholder={busy ? 'ShuttleViz is working…' : editing ? 'ShuttleViz waits while you edit…' : placeholder}
                disabled={busy || editing}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) submit(e)
                }}
              />
              <div className="lab-composer-row">
                {((phase === 'start' && !started) || (phase === 'explore' && keptAnswers.length > 0)) && !task && (
                  <>
                    <label className="pin-toggle" title="Sends the Storeloom colours to ShuttleViz as hex codes">
                      <input type="checkbox" checked={styled} onChange={(e) => setStyled(e.target.checked)} />
                      <span className="pin-toggle-track" aria-hidden />
                      <span>Storeloom style</span>
                    </label>
                  </>
                )}
                <button type="submit" className="btn-primary lab-send" disabled={busy || editing || !draft.trim()}>
                  {phase === 'reply' ? 'Reply' : phase === 'refine' ? 'Change it' : phase === 'explore' ? 'Ask' : 'Brief it'} <span aria-hidden>→</span>
                </button>
              </div>
            </form>
          </section>

          {/* ---- Stage ---- */}
          <section className="lab-stage" aria-label="Dashboard">
            <header className="lab-stage-head">
              <div className="dash-tabs" role="tablist" aria-label="Show">
                <button type="button" role="tab" aria-selected={view === 'dashboard'} className={view === 'dashboard' ? 'dash-tab is-active' : 'dash-tab'} onClick={() => setView('dashboard')}>
                  Dashboard
                </button>
                {canGetData && dashboardId && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={view === 'numbers'}
                    className={view === 'numbers' ? 'dash-tab is-active' : 'dash-tab'}
                    onClick={() => setView('numbers')}
                    disabled={editing}
                  >
                    The numbers
                  </button>
                )}
              </div>
              {dashboardId && (
                <div className="lab-stage-links">
                  {editing ? (
                    <span className="mono-label lab-editing-badge">✎ Editing by hand</span>
                  ) : (
                    <button
                      type="button"
                      className="studio-open lab-edit-btn"
                      disabled={!canEdit}
                      onClick={() => {
                        setView('dashboard')
                        setEditing(true)
                      }}
                      title={
                        canEdit
                          ? 'Resize, move and add to the dashboard yourself, in the dashboard editor'
                          : task
                            ? 'Answer ShuttleViz first, then edit by hand'
                            : 'Wait for ShuttleViz to finish, then edit by hand'
                      }
                    >
                      ✎ Edit by hand
                    </button>
                  )}
                  <button type="button" className="studio-open" onClick={() => setFocus((f) => !f)} aria-pressed={focus}>
                    {focus ? '⤡ Show conversation' : '⤢ Full view'}
                  </button>
                </div>
              )}
            </header>
            <div className={editing ? 'lab-stage-body is-editing' : 'lab-stage-body'}>
              {!dashboardId && keptAnswers.length > 0 && !entries.some((e) => e.kind === 'work' && !e.endedAt) ? (
                <DraftBoard answers={keptAnswers} onRemove={toggleKeep} />
              ) : !dashboardId ? (
                <Loom seed={seed} weaving={entries.some((e) => e.kind === 'work' && !e.endedAt)} />
              ) : view === 'numbers' ? (
                <Numbers dashboardId={dashboardId} version={version} />
              ) : (
                <div className={busy ? 'lab-embed is-changing' : editing ? 'lab-embed is-editing' : 'lab-embed'}>
                  {editing ? (
                    // The editor: ThoughtSpot's edit toolbar (Save, Cancel, add, resize), but
                    // no SpotterViz button: language goes through ShuttleViz's conversation.
                    <LiveboardEmbed
                      key={`${dashboardId}-${version}-edit`}
                      ref={editorRef}
                      liveboardId={dashboardId}
                      hiddenActions={HIDDEN_BRANDED_ACTIONS}
                      customizations={WITH_LIVEBOARD_HEADER}
                      showLiveboardTitle={false}
                      // A frame the size of the panel, not the dashboard's full height: a
                      // chart's Edit opens ThoughtSpot's Search in this same frame, and it's
                      // laid out for a window-sized one. The dashboard scrolls inside it.
                      frameParams={EDITOR_FRAME}
                      onLiveboardRendered={onEditorRendered}
                      onSave={onHandSaved}
                      onCancel={onHandCancelled}
                    />
                  ) : (
                    <LiveboardEmbed
                      key={`${dashboardId}-${version}`}
                      liveboardId={dashboardId}
                      hiddenActions={PINNED_CHART_HIDDEN_ACTIONS}
                      hideLiveboardHeader
                      fullHeight
                      minimumHeight={480}
                    />
                  )}
                  {busy && (
                    <div className="lab-embed-veil">
                      <span className="sp-shuttle" aria-hidden /> ShuttleViz is changing the dashboard
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        </Workspace>
      )}
    </div>
  )
}
