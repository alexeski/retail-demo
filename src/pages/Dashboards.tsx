import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { DashboardMosaic } from '../components/DashboardMosaic'
import { cloneDashboard, deleteDashboard, formatEdited, listDashboards, listShared, tileCount, type Dashboard } from '../dashboards'
import './Dashboards.css'

/** The two ways to build, shared with the empty state. */
const BUILD_MODES = [
  {
    mode: 'search',
    title: 'Build with Search',
    body: 'Pick columns from Retail Sales and shape each chart yourself. Pin it, and it stays linked: keep editing and the dashboard follows.',
    cta: 'Start with Search',
  },
  {
    mode: 'ai',
    title: 'Build with ShuttleViz',
    body: 'Describe the dashboard you need in plain words. ShuttleViz picks the charts, lays them out and refines them as you talk.',
    cta: 'Start with ShuttleViz',
  },
] as const

type Tab = 'mine' | 'shared'

export function Dashboards() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('mine')
  const [mine, setMine] = useState<Dashboard[] | null>(null)
  const [shared, setShared] = useState<Dashboard[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sharedError, setSharedError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /** The dashboard whose delete is waiting for a second click. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [cloning, setCloning] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listDashboards()
      .then((d) => !cancelled && setMine(d))
      .catch((err: Error) => !cancelled && setError(err.message))
    listShared()
      .then((d) => !cancelled && setShared(d))
      .catch((err: Error) => !cancelled && setSharedError(err.message))
    return () => {
      cancelled = true
    }
  }, [])

  const list = tab === 'mine' ? mine : shared
  const listError = tab === 'mine' ? error : sharedError
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? list?.filter((d) => `${d.name} ${d.description} ${d.author}`.toLowerCase().includes(q)) : list
  }, [list, query])

  const remove = async (d: Dashboard) => {
    setDeleting(d.id)
    try {
      await deleteDashboard(d.id)
      setMine((l) => l?.filter((x) => x.id !== d.id) ?? null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDeleting(null)
      setConfirming(null)
    }
  }

  /** Copies a shared dashboard into a new one of the user's, and opens it in Studio. */
  const clone = async (d: Dashboard) => {
    setCloning(d.id)
    setSharedError(null)
    try {
      const copy = await cloneDashboard(d.id)
      navigate(`/studio?mode=search&dashboard=${copy.id}`)
    } catch (err) {
      setSharedError((err as Error).message)
      setCloning(null)
    }
  }

  const count = (l: Dashboard[] | null) => (l ? ` · ${l.length}` : '')

  return (
    <div className="dashboards">
      <section className="dash-head">
        <div className="dash-title">
          <div className="eyebrow">
            <span className="tag">Dashboards</span>
            <span>Retail Sales</span>
          </div>
          <h1 className="display dash-h1">
            Build your <span className="highlight">own view</span>
          </h1>
          <p className="dash-lede">
            Build dashboards of your own, or start from one a colleague shared with you. Every chart reads the same Retail Sales data as the rest of
            Storeloom.
          </p>
        </div>
      </section>

      <section className="dash-modes" aria-label="Start a new dashboard">
        {BUILD_MODES.map((m) => (
          <Link key={m.mode} to={`/studio?mode=${m.mode}`} className={`mode-card is-${m.mode}`}>
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
          <div className="dash-tabs" role="tablist" aria-label="Which dashboards">
            <button type="button" role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'dash-tab is-active' : 'dash-tab'} onClick={() => setTab('mine')}>
              My dashboards<span className="dash-tab-count">{count(mine)}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'shared'}
              className={tab === 'shared' ? 'dash-tab is-active' : 'dash-tab'}
              onClick={() => setTab('shared')}
            >
              Shared with you<span className="dash-tab-count">{count(shared)}</span>
            </button>
          </div>
          {!!list?.length && (
            <label className="dash-filter">
              <span className="mono-label">Find</span>
              <input type="search" value={query} placeholder={tab === 'mine' ? 'Dashboard name' : 'Name or author'} onChange={(e) => setQuery(e.target.value)} />
            </label>
          )}
        </div>
        <p className="dash-library-note mono-label">
          {tab === 'mine'
            ? 'Dashboards you created · open, edit in Studio or delete'
            : 'Retail Sales dashboards others made that you can open · clone one to make it yours and edit it'}
        </p>

        {listError && (
          <div className="dash-notice is-error" role="alert">
            {listError}
            <button type="button" className="btn-outline" onClick={() => window.location.reload()}>
              Retry
            </button>
          </div>
        )}

        {!list && !listError && (
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

        {list?.length === 0 &&
          (tab === 'mine' ? (
            <div className="dash-empty">
              <DashboardMosaic seed="storeloom" tiles={5} />
              <div>
                <strong>No dashboards yet.</strong>
                <p>Start with Search to build chart by chart, let ShuttleViz draft a whole dashboard from one sentence, or clone one shared with you.</p>
              </div>
            </div>
          ) : (
            <div className="dash-notice">Nobody has shared a Retail Sales dashboard with you yet.</div>
          ))}

        {!!shown?.length && (
          <div className="dash-grid">
            {shown.map((d, i) => (
              <article key={d.id} className={d.owned ? 'dash-card' : 'dash-card is-shared'} style={{ '--i': i } as CSSProperties}>
                <Link to={`/dashboards/${d.id}`} className="dash-card-open" aria-label={`Open ${d.name}`}>
                  <div className="dash-card-body">
                    {!d.owned && d.author && <span className="dash-card-author mono-label">By {d.author}</span>}
                    <h3 className="dash-card-name">{d.name}</h3>
                    {d.description && <p className="dash-card-desc">{d.description}</p>}
                    <span className="mono-label dash-card-meta">
                      {tileCount(d.tiles)} · {formatEdited(d.modified)}
                    </span>
                  </div>
                </Link>
                <div className="dash-card-actions">
                  {d.owned ? (
                    <>
                      <button type="button" onClick={() => navigate(`/studio?mode=search&dashboard=${d.id}`)} title="Add or change charts with Search">
                        ⌕ Search
                      </button>
                      <button type="button" onClick={() => navigate(`/studio?mode=ai&dashboard=${d.id}`)} title="Edit this dashboard with ShuttleViz">
                        ✦ ShuttleViz
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
                    </>
                  ) : (
                    <>
                      <button type="button" onClick={() => navigate(`/dashboards/${d.id}`)}>
                        Open
                      </button>
                      <button
                        type="button"
                        className="is-primary"
                        onClick={() => void clone(d)}
                        disabled={!!cloning}
                        title="Make your own copy and edit it in Studio"
                      >
                        {cloning === d.id ? 'Cloning…' : '⧉ Clone & edit'}
                      </button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}

        {list && !!list.length && shown?.length === 0 && <div className="dash-notice">No dashboard matches “{query}”.</div>}
      </section>
    </div>
  )
}
