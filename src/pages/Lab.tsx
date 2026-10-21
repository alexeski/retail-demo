import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatEdited, listDashboards, tileCount, type Dashboard } from '../dashboards'
import { LAB_STORE_PREFIX } from '../tsMcp'
import { forgetNewLabConversation } from './LabBuilder'
import './Dashboards.css'
import './Lab.css'

// Dashboard Lab: a second, separate way to build dashboards, by conversation
// over ThoughtSpot's Spotter MCP Server. Studio (Search and ShuttleViz) stays as
// it is; the Lab is offered alongside it so people can try both.

const STARTS = [
  {
    mode: 'describe',
    n: '01',
    title: 'Describe it',
    body: 'Say what you need in a sentence. Shuttle comes back with a plan and the data it will use, builds once you approve, then keeps refining as you talk.',
    cta: 'Describe a dashboard',
    prompt: '“Where are we losing margin? By category, brand and region”',
  },
  {
    mode: 'explore',
    n: '02',
    title: 'Explore first',
    body: 'Ask Shuttle questions about Retail Sales. Keep the charts worth keeping, and turn them into a laid-out, styled dashboard in one click.',
    cta: 'Start exploring',
    prompt: '“Top 10 brands by gross margin” → “and their monthly sales?”',
  },
] as const

/** Whether this tab has a new-dashboard conversation in progress. */
function hasDraft() {
  try {
    const raw = sessionStorage.getItem(`${LAB_STORE_PREFIX}new`)
    return !!raw && (JSON.parse(raw) as { entries?: unknown[] }).entries?.length
  } catch {
    return false
  }
}

export function Lab() {
  const navigate = useNavigate()
  const [mine, setMine] = useState<Dashboard[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [draft] = useState(hasDraft)

  useEffect(() => {
    let cancelled = false
    listDashboards()
      .then((d) => !cancelled && setMine(d))
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? mine?.filter((d) => `${d.name} ${d.description}`.toLowerCase().includes(q)) : mine
  }, [mine, query])

  const start = (mode: string) => {
    forgetNewLabConversation()
    navigate(`/lab/new?mode=${mode}`)
  }

  return (
    <div className="dashboards lab-home">
      <section className="dash-head">
        <div className="dash-title">
          <div className="eyebrow">
            <span className="tag">Dashboard Lab</span>
            <span className="lab-beta">Beta</span>
            <span>Retail Sales</span>
          </div>
          <h1 className="display dash-h1">
            Talk a dashboard <span className="highlight">into being</span>
          </h1>
          <p className="dash-lede">
            A new way to build: a conversation with Shuttle that plans, builds and styles the whole dashboard, then changes it as you talk. It runs on
            ThoughtSpot’s Spotter MCP Server, and it’s separate from Studio, so you can try both and compare.
          </p>
        </div>
      </section>

      <section className="dash-modes" aria-label="Start a new dashboard">
        {STARTS.map((m) => (
          <button key={m.mode} type="button" className={`mode-card lab-start is-${m.mode}`} onClick={() => start(m.mode)}>
            <span className="mode-card-n">{m.n}</span>
            <div className="mode-card-art lab-start-art" aria-hidden>
              <span className="lab-start-bubble">{m.prompt}</span>
              <span className="lab-start-reply">
                <span className="sp-shuttle" /> {m.mode === 'describe' ? 'Here’s my plan…' : 'Kept · 2 charts'}
              </span>
            </div>
            <h2 className="mode-card-title">{m.title}</h2>
            <p className="mode-card-body">{m.body}</p>
            <span className="mode-card-cta">
              {m.cta} <span aria-hidden>→</span>
            </span>
          </button>
        ))}
        {draft && (
          <button type="button" className="lab-resume" onClick={() => navigate('/lab/new')}>
            <span className="tag">In progress</span>
            <span>Your last new dashboard isn’t finished. Pick up the conversation where you left it.</span>
            <span className="mode-card-cta">
              Continue <span aria-hidden>→</span>
            </span>
          </button>
        )}
      </section>

      <section className="dash-library">
        <div className="dash-library-head">
          <h2 className="lab-library-h">Change one of yours</h2>
          {!!mine?.length && (
            <label className="dash-filter">
              <span className="mono-label">Find</span>
              <input type="search" value={query} placeholder="Dashboard name" onChange={(e) => setQuery(e.target.value)} />
            </label>
          )}
        </div>
        <p className="dash-library-note mono-label">Open a dashboard you created and tell Shuttle what to change: layout, styling, new charts, notes, tabs</p>

        {error && <div className="dash-notice is-error">{error}</div>}
        {!mine && !error && (
          <div className="dash-grid" aria-busy>
            {[0, 1, 2].map((i) => (
              <div key={i} className="dash-card is-loading" aria-hidden>
                <div className="dash-card-body">
                  <span className="dash-skeleton is-wide" />
                  <span className="dash-skeleton" />
                </div>
              </div>
            ))}
          </div>
        )}
        {mine?.length === 0 && <div className="dash-notice">No dashboards yet. Start one above.</div>}
        {!!shown?.length && (
          <div className="dash-grid">
            {shown.map((d, i) => (
              <article key={d.id} className="dash-card" style={{ '--i': i } as CSSProperties}>
                <button type="button" className="dash-card-open lab-card-open" onClick={() => navigate(`/lab/${d.id}`)} aria-label={`Open ${d.name} in Dashboard Lab`}>
                  <div className="dash-card-body">
                    <h3 className="dash-card-name">{d.name}</h3>
                    {d.description && <p className="dash-card-desc">{d.description}</p>}
                    <span className="mono-label dash-card-meta">
                      {tileCount(d.tiles)} · {formatEdited(d.modified)}
                    </span>
                  </div>
                </button>
              </article>
            ))}
          </div>
        )}
        {mine && !!mine.length && shown?.length === 0 && <div className="dash-notice">No dashboard matches “{query}”.</div>}
      </section>
    </div>
  )
}
