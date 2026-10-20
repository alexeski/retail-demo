import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { SearchBuilder } from '../components/SearchBuilder'
import { ShuttleBuilder } from '../components/ShuttleBuilder'
import { listDashboards, tileCount, type Dashboard } from '../dashboards'
import './Dashboards.css'
import './Studio.css'

type Mode = 'search' | 'ai'

const MODES: { mode: Mode; icon: string; label: string; sub: string }[] = [
  { mode: 'search', icon: '⌕', label: 'Search', sub: 'Chart by chart' },
  { mode: 'ai', icon: '✦', label: 'Shuttle', sub: 'Describe it' },
]

/**
 * The dashboard builder. `?mode=search|ai` picks the experience and
 * `?dashboard=<id>` the dashboard being edited (none: a new one). Only the
 * user's own dashboards are offered, and the data is always Retail Sales.
 */
export function Studio() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const mode: Mode = params.get('mode') === 'ai' ? 'ai' : 'search'
  const dashboardId = params.get('dashboard')
  const [dashboards, setDashboards] = useState<Dashboard[] | null>(null)
  const [listError, setListError] = useState(false)
  const [newName, setNewName] = useState('')
  /** Shuttle has unsaved changes on the dashboard. */
  const [dirty, setDirty] = useState(false)
  /**
   * Dashboards created in this visit, by ID: ThoughtSpot's search index can take
   * a moment to list a new one, and it must not look foreign meanwhile.
   */
  const [created, setCreated] = useState<Record<string, string>>({})

  const refresh = useCallback(() => {
    listDashboards()
      .then((d) => {
        setDashboards(d)
        setListError(false)
      })
      .catch(() => setListError(true))
  }, [])
  useEffect(refresh, [refresh])

  const current = dashboards?.find((d) => d.id === dashboardId)
  const title = current?.name ?? (dashboardId ? created[dashboardId] : undefined)
  // A dashboard ID that isn't in the user's own list: not theirs (or gone).
  const foreign = !!dashboardId && !!dashboards && !current && !(dashboardId in created)
  // Builders wait for the list when opened on a dashboard, so a foreign one never loads.
  const checking = !!dashboardId && !dashboards && !listError && !(dashboardId in created)

  const leaveOk = () => !dirty || window.confirm('Shuttle’s latest changes aren’t saved. Leave without saving?')

  const go = (next: { mode?: Mode; dashboard?: string | null }) => {
    if (!leaveOk()) return
    const p = new URLSearchParams(params)
    if (next.mode) p.set('mode', next.mode)
    if (next.dashboard !== undefined) {
      if (next.dashboard) p.set('dashboard', next.dashboard)
      else p.delete('dashboard')
    }
    setDirty(false)
    setParams(p)
  }

  const onCreated = useCallback(
    (id: string) => {
      setCreated((c) => ({ ...c, [id]: newName.trim() || 'Untitled dashboard' }))
      setParams((p) => {
        const next = new URLSearchParams(p)
        next.set('dashboard', id)
        return next
      })
      setNewName('')
      refresh()
    },
    [setParams, refresh, newName],
  )

  const onDone = useCallback((id: string) => navigate(`/dashboards/${id}`), [navigate])

  return (
    <div className="studio">
      <section className="studio-head">
        <div className="dash-title">
          <Link to="/dashboards" className="dash-back mono-label" onClick={(e) => !leaveOk() && e.preventDefault()}>
            ← My dashboards
          </Link>
          <div className="eyebrow">
            <span className="tag">Studio</span>
            <span className="studio-model" title="Every chart in Studio reads the Retail Sales model. It can’t be changed here.">
              <span aria-hidden>▣</span> Retail Sales model · fixed
            </span>
          </div>
          <h1 className="display studio-h1">{title ?? (dashboardId ? ' ' : newName.trim() || 'New dashboard')}</h1>
        </div>

        <div className="studio-modes" role="tablist" aria-label="How to build">
          {MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              role="tab"
              aria-selected={mode === m.mode}
              className={mode === m.mode ? 'studio-mode is-active' : 'studio-mode'}
              onClick={() => mode !== m.mode && go({ mode: m.mode })}
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
      </section>

      <section className="studio-bar">
        <label className="studio-target">
          <span className="studio-bar-label">Dashboard</span>
          <select value={dashboardId ?? ''} onChange={(e) => go({ dashboard: e.target.value || null })} disabled={!dashboards && !listError}>
            <option value="">＋ New dashboard</option>
            {dashboards && dashboards.length > 0 && (
              <optgroup label="Yours">
                {dashboards.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} · {tileCount(d.tiles)}
                  </option>
                ))}
              </optgroup>
            )}
            {dashboardId && !current && dashboardId in created && <option value={dashboardId}>{created[dashboardId]}</option>}
            {foreign && <option value={dashboardId!}>Unavailable dashboard</option>}
          </select>
        </label>
        {!dashboardId && (
          <label className="studio-name">
            <span className="studio-bar-label">Name</span>
            <input value={newName} placeholder="Untitled dashboard" maxLength={100} onChange={(e) => setNewName(e.target.value)} />
          </label>
        )}
        <span className="studio-bar-note">
          {listError ? 'Couldn’t load your dashboards' : dashboardId ? 'Changes go to this dashboard' : mode === 'search' ? 'Created on your first pin' : 'Created when Shuttle starts'}
        </span>
        {dashboardId && !foreign && (
          <Link to={`/dashboards/${dashboardId}`} className="studio-open" onClick={(e) => !leaveOk() && e.preventDefault()}>
            Open dashboard <span aria-hidden>↗</span>
          </Link>
        )}
      </section>

      {checking ? (
        <div className="studio-blocked mono-label">Loading your dashboards…</div>
      ) : foreign ? (
        <div className="studio-blocked">
          <strong>This dashboard isn’t one of yours.</strong>
          <p>Studio only edits dashboards you created. Pick one of yours above, or start a new one.</p>
        </div>
      ) : mode === 'search' ? (
        <SearchBuilder dashboardId={dashboardId} newName={newName} onCreated={onCreated} onChanged={refresh} />
      ) : (
        <ShuttleBuilder dashboardId={dashboardId} newName={newName} onCreated={onCreated} onChanged={refresh} onDirtyChange={setDirty} onDone={onDone} />
      )}
    </div>
  )
}
