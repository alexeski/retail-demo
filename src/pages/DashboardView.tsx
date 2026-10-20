import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { HostEvent } from '@thoughtspot/visual-embed-sdk'
import { LiveboardEmbed, useEmbedRef } from '@thoughtspot/visual-embed-sdk/react'
import { AskShuttleBar } from '../components/AskShuttleBar'
import { useShuttle } from '../components/Shuttle'
import { EditableTitle } from '../components/EditableTitle'
import { formatEdited, getDashboard, renameDashboard, tileCount, type Dashboard } from '../dashboards'
import { HIDDEN_BRANDED_ACTIONS, WITH_LIVEBOARD_HEADER } from '../thoughtspot'
import './Dashboards.css'

/** Three starter questions for Shuttle, from the dashboard's own tiles. */
function questionsFor(d: Dashboard) {
  const tiles = d.charts.slice(0, 2).map((c) => c.name)
  const questions = tiles.map((t) => `What is driving the latest change in “${t}”?`)
  questions.push('Which regions and stores stand out on this dashboard, and why?')
  if (questions.length < 3) questions.push('What changed most versus the previous month?')
  return questions.slice(0, 3)
}

/** One of the user's dashboards, embedded and fully interactive. */
export function DashboardView() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rendered, setRendered] = useState(false)
  const embedRef = useEmbedRef<typeof LiveboardEmbed>()

  useEffect(() => {
    let cancelled = false
    setDashboard(null)
    setError(null)
    setRendered(false)
    getDashboard(id)
      .then((d) => !cancelled && setDashboard(d))
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [id])

  // Stable for the SDK's React wrapper, which re-creates the embed on a new handler.
  const onRendered = useCallback(() => setRendered(true), [])

  const { ask, streaming } = useShuttle()
  const askShuttle = (question: string) =>
    dashboard &&
    ask(question, {
      scope: dashboard.name,
      tag: dashboard.name,
      preamble:
        `I'm looking at my own dashboard "${dashboard.name}", built on the Retail Sales data` +
        (dashboard.charts.length ? `, with these charts: ${dashboard.charts.map((c) => c.name).join('; ')}.` : '.'),
    })

  if (error) {
    return (
      <div className="dashboards">
        <section className="dash-head">
          <div className="dash-title">
            <Link to="/dashboards" className="dash-back mono-label">
              ← My dashboards
            </Link>
            <h1 className="display dash-h1">Not found</h1>
            <p className="dash-lede">{error}</p>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="dashboards">
      <section className="dash-head">
        <div className="dash-title">
          <Link to="/dashboards" className="dash-back mono-label">
            ← My dashboards
          </Link>
          <div className="eyebrow">
            <span className="tag">Dashboard</span>
            <span>{dashboard ? `${tileCount(dashboard.tiles)} · ${formatEdited(dashboard.modified)}` : 'Loading…'}</span>
          </div>
          {dashboard ? (
            <EditableTitle
              name={dashboard.name}
              className="display dash-h1 is-name"
              onRename={async (name) => setDashboard(await renameDashboard(id, name))}
            />
          ) : (
            <h1 className="display dash-h1 is-name">{'\u00a0'}</h1>
          )}
          {dashboard?.description && <p className="dash-lede">{dashboard.description}</p>}
        </div>
        <div className="dash-actions">
          <button
            type="button"
            className="btn-outline btn-ai"
            onClick={() => embedRef.current?.trigger(HostEvent.AIHighlights)}
            disabled={!rendered || !dashboard?.tiles}
            title="AI highlights for this dashboard"
          >
            <span aria-hidden>✦</span> Shuttle Highlights
          </button>
          <button type="button" className="btn-outline" onClick={() => navigate(`/studio?mode=search&dashboard=${id}`)}>
            ⌕ Edit with Search
          </button>
          <button type="button" className="btn-outline" onClick={() => navigate(`/studio?mode=ai&dashboard=${id}`)}>
            ✦ Edit with Shuttle
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => embedRef.current?.trigger(HostEvent.DownloadAsPdf)}
            disabled={!rendered || !dashboard?.tiles}
          >
            Download PDF
          </button>
        </div>
      </section>

      {dashboard && !!dashboard.tiles && <AskShuttleBar scope={dashboard.name} questions={questionsFor(dashboard)} onAsk={askShuttle} busy={streaming} />}

      <section className="dash-body">
        <div className="dash-frame">
          {dashboard && dashboard.tiles === 0 ? (
            <div className="dash-blank">
              <strong>This dashboard is empty.</strong>
              <p>Add a first chart with Search, or ask Shuttle to draft the whole thing.</p>
              <div className="dash-blank-actions">
                <button type="button" className="btn-primary" onClick={() => navigate(`/studio?mode=search&dashboard=${id}`)}>
                  Add a chart with Search
                </button>
                <button type="button" className="btn-outline" onClick={() => navigate(`/studio?mode=ai&dashboard=${id}`)}>
                  ✦ Draft it with Shuttle
                </button>
              </div>
            </div>
          ) : (
            dashboard && (
              <div className="dash-embed">
                <LiveboardEmbed
                  key={id}
                  ref={embedRef}
                  liveboardId={id}
                  hiddenActions={HIDDEN_BRANDED_ACTIONS}
                  updatedSpotterChatPrompt
                  // ThoughtSpot's own header carries this dashboard's filters and tabs;
                  // Storeloom shows the title above.
                  customizations={WITH_LIVEBOARD_HEADER}
                  showLiveboardTitle={false}
                  showLiveboardDescription={false}
                  fullHeight
                  minimumHeight={640}
                  onLiveboardRendered={onRendered}
                />
              </div>
            )
          )}
        </div>
      </section>
    </div>
  )
}
