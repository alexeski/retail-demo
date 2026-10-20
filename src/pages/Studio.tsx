import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { SearchBuilder } from '../components/SearchBuilder'
import { ShuttleBuilder } from '../components/ShuttleBuilder'
import { EditableTitle } from '../components/EditableTitle'
import { listDashboards, renameDashboard, tileCount, type Dashboard } from '../dashboards'
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
  const [params, setParams] = useSearchParams()
  const mode: Mode = params.get('mode') === 'ai' ? 'ai' : 'search'
  const dashboardId = params.get('dashboard')
  const editVizId = params.get('edit')
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
  /**
   * Bumped on a rename. Shuttle's edit-mode embed holds the dashboard as it was
   * loaded, and a later Save from it would bring the old name back, so it reloads.
   */
  const [renamedAt, setRenamedAt] = useState(0)

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

  const rename = async (name: string) => {
    if (dirty) throw new Error('Save Shuttle’s changes first, then rename.')
    const renamed = await renameDashboard(dashboardId!, name)
    setDashboards((list) => list?.map((d) => (d.id === renamed.id ? renamed : d)) ?? null)
    setCreated((c) => (renamed.id in c ? { ...c, [renamed.id]: renamed.name } : c))
    setRenamedAt(Date.now())
  }

  // ?edit=<vizId> opens a chart once; drop it so a reload doesn't reopen it.
  const onEditOpened = useCallback(
    () =>
      setParams(
        (p) => {
          const next = new URLSearchParams(p)
          next.delete('edit')
          return next
        },
        { replace: true },
      ),
    [setParams],
  )


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
          {dashboardId && title && !foreign ? (
            <EditableTitle name={title} className="display studio-h1" onRename={rename} />
          ) : (
            <h1 className="display studio-h1">{dashboardId ? '\u00a0' : newName.trim() || 'New dashboard'}</h1>
          )}
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
        <SearchBuilder
          dashboardId={dashboardId}
          newName={newName}
          editVizId={editVizId}
          onCreated={onCreated}
          onChanged={refresh}
          onEditOpened={onEditOpened}
        />
      ) : (
        <ShuttleBuilder
          reloadKey={renamedAt}
          dashboardId={dashboardId}
          tiles={current?.tiles ?? null}
          newName={newName}
          onCreated={onCreated}
          onChanged={refresh}
          onDirtyChange={setDirty}
        />
      )}
    </div>
  )
}
