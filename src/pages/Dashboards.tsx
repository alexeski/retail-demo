import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { DashboardMosaic } from '../components/DashboardMosaic'
import { deleteDashboard, formatEdited, listDashboards, tileCount, type Dashboard } from '../dashboards'
import './Dashboards.css'

/** The two ways to build, shared with the empty state. */
const BUILD_MODES = [
  {
    mode: 'search',
    n: '01',
    title: 'Build with Search',
    body: 'Pick columns from Retail Sales and shape each chart yourself. Pin it, and it stays linked: keep editing and the dashboard follows.',
    cta: 'Start with Search',
  },
  {
    mode: 'ai',
    n: '02',
    title: 'Build with Shuttle',
    body: 'Describe the dashboard you need in plain words. Shuttle picks the charts, lays them out and refines them as you talk.',
    cta: 'Start with Shuttle',
  },
] as const

export function Dashboards() {
  const navigate = useNavigate()
  const [dashboards, setDashboards] = useState<Dashboard[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /** The dashboard whose delete is waiting for a second click. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listDashboards()
      .then((d) => !cancelled && setDashboards(d))
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? dashboards?.filter((d) => `${d.name} ${d.description}`.toLowerCase().includes(q)) : dashboards
  }, [dashboards, query])

  const remove = async (d: Dashboard) => {
    setDeleting(d.id)
    try {
      await deleteDashboard(d.id)
      setDashboards((list) => list?.filter((x) => x.id !== d.id) ?? null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDeleting(null)
      setConfirming(null)
    }
  }

  return (
    <div className="dashboards">
      <section className="dash-head">
        <div className="dash-title">
          <div className="eyebrow">
            <span className="tag">Dashboards</span>
            <span>Yours · Retail Sales</span>
          </div>
          <h1 className="display dash-h1">
            Build your <span className="highlight">own view</span>
          </h1>
          <p className="dash-lede">
            Dashboards you build here are yours: only you see them in this list, and every chart reads the same Retail Sales data as the rest of
            Storeloom.
          </p>
        </div>
      </section>

      <section className="dash-modes" aria-label="Start a new dashboard">
        {BUILD_MODES.map((m) => (
          <Link key={m.mode} to={`/studio?mode=${m.mode}`} className={`mode-card is-${m.mode}`}>
            <span className="mode-card-n">{m.n}</span>
            <div className="mode-card-art" aria-hidden>
              {m.mode === 'search' ? (
                <>
                  <span className="mode-token">Sales</span>
                  <span className="mode-token">Store Region</span>
                  <span className="mode-token is-ghost">Monthly</span>
                  <span className="mode-pin">⤓ Pin</span>
                </>
              ) : (
                <>
                  <span className="shuttle-pill is-large" />
                  <span className="mode-prompt">“An exec overview of sales and margin by region”</span>
                </>
              )}
            </div>
            <h2 className="mode-card-title">{m.title}</h2>
            <p className="mode-card-body">{m.body}</p>
            <span className="mode-card-cta">
              {m.cta} <span aria-hidden>→</span>
            </span>
          </Link>
        ))}
      </section>

      <section className="dash-library">
        <div className="dash-library-head">
          <div>
            <h2 className="dash-h2">My dashboards</h2>
            <span className="mono-label">
              {dashboards ? `${dashboards.length} ${dashboards.length === 1 ? 'dashboard' : 'dashboards'} · created by you` : error ? '' : 'Loading…'}
            </span>
          </div>
          {!!dashboards?.length && (
            <label className="dash-filter">
              <span className="mono-label">Find</span>
              <input type="search" value={query} placeholder="Dashboard name" onChange={(e) => setQuery(e.target.value)} />
            </label>
          )}
        </div>

        {error && (
          <div className="dash-notice is-error" role="alert">
            {error}
            <button type="button" className="btn-outline" onClick={() => window.location.reload()}>
              Retry
            </button>
          </div>
        )}

        {!dashboards && !error && (
          <div className="dash-grid" aria-busy>
            {[0, 1, 2].map((i) => (
              <div key={i} className="dash-card is-loading" aria-hidden>
                <div className="dash-card-art" />
                <div className="dash-card-body">
                  <span className="dash-skeleton is-wide" />
                  <span className="dash-skeleton" />
                </div>
              </div>
            ))}
          </div>
        )}

        {dashboards?.length === 0 && (
          <div className="dash-empty">
            <DashboardMosaic seed="storeloom" tiles={5} />
            <div>
              <strong>No dashboards yet.</strong>
              <p>Start with Search to build chart by chart, or let Shuttle draft a whole dashboard from one sentence.</p>
            </div>
          </div>
        )}

        {!!shown?.length && (
          <div className="dash-grid">
            {shown.map((d, i) => (
              <article key={d.id} className="dash-card" style={{ '--i': i } as CSSProperties}>
                <Link to={`/dashboards/${d.id}`} className="dash-card-open" aria-label={`Open ${d.name}`}>
                  <div className="dash-card-art">
                    <DashboardMosaic seed={d.id} tiles={d.tiles} />
                  </div>
                  <div className="dash-card-body">
                    <h3 className="dash-card-name">{d.name}</h3>
                    {d.description && <p className="dash-card-desc">{d.description}</p>}
                    <span className="mono-label dash-card-meta">
                      {tileCount(d.tiles)} · {formatEdited(d.modified)}
                    </span>
                  </div>
                </Link>
                <div className="dash-card-actions">
                  <button type="button" onClick={() => navigate(`/studio?mode=search&dashboard=${d.id}`)} title="Add or change charts with Search">
                    ⌕ Search
                  </button>
                  <button type="button" onClick={() => navigate(`/studio?mode=ai&dashboard=${d.id}`)} title="Edit this dashboard with Shuttle">
                    ✦ Shuttle
                  </button>
                  {confirming === d.id ? (
                    <button type="button" className="is-danger" disabled={deleting === d.id} onClick={() => remove(d)} onBlur={() => setConfirming(null)} autoFocus>
                      {deleting === d.id ? 'Deleting…' : 'Delete for good?'}
                    </button>
                  ) : (
                    <button type="button" className="is-quiet" onClick={() => setConfirming(d.id)} aria-label={`Delete ${d.name}`} title="Delete">
                      Delete
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}

        {dashboards && !!dashboards.length && shown?.length === 0 && <div className="dash-notice">No dashboard matches “{query}”.</div>}
      </section>
    </div>
  )
}
