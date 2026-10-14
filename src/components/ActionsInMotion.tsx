import { useEffect, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import {
  advancePlay,
  pickupPending,
  planStatus,
  playStatus,
  useTrackedPlans,
  type PlayStatus,
  type TrackedPlan,
} from '../actionTracker'
import { shortStoreName } from '../storeActions'
import { useShuttle } from './Shuttle'
import './ActionsInMotion.css'

const STATUS_LABEL: Record<PlayStatus, string> = { assigned: 'Assigned', 'in-progress': 'In progress', done: 'Done' }
const STATUS_ICON: Record<PlayStatus, string> = { assigned: '○', 'in-progress': '◐', done: '✓' }

const compactMoney = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `$${Math.round(n / 1_000)}K` : `$${Math.round(n)}`

const ago = (ms: number) => {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  return `${h} h ago`
}

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

function dueLabel(iso: string, now: number) {
  const days = Math.round((dayStart(new Date(`${iso}T12:00:00`)) - dayStart(new Date(now))) / 86_400_000)
  if (days < 0) return { text: 'overdue', late: true }
  if (days === 0) return { text: 'due today', late: false }
  if (days === 1) return { text: 'due tomorrow', late: false }
  return { text: `due in ${days} days`, late: false }
}

const prettyDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

/**
 * Home page: the action plans launched this session, each with its plays, owners
 * and status, so the user sees what is in motion in one place. Clicking a play's
 * status moves it along (assigned → in progress → done).
 */
export function ActionsInMotion() {
  const plans = useTrackedPlans()
  const [now, setNow] = useState(() => Date.now())

  // Keep "ago" labels and simulated pickups current.
  useEffect(() => {
    if (!plans.length) return
    const t = setInterval(() => setNow(Date.now()), pickupPending(plans) ? 5_000 : 30_000)
    return () => clearInterval(t)
  }, [plans])

  const counts = { assigned: 0, 'in-progress': 0, done: 0 } as Record<PlayStatus, number>
  for (const plan of plans) plan.plays.forEach((_, i) => counts[playStatus(plan, i, now)]++)
  const plays = counts.assigned + counts['in-progress'] + counts.done

  return (
    <section className="actions" aria-labelledby="actions-title">
      <div className="actions-head">
        <div className="work-head">
          <h2 id="actions-title">Actions in motion</h2>
          <span className="mono-label">
            {plans.length
              ? `${plans.length} plan${plans.length === 1 ? '' : 's'} · ${plays} play${plays === 1 ? '' : 's'} · this session`
              : 'This session'}
          </span>
        </div>
        {plans.length > 0 && (
          <div className="actions-summary" aria-label="Plays by status">
            {(['assigned', 'in-progress', 'done'] as PlayStatus[]).map((s) => (
              <span key={s} className={`actions-count is-${s}`}>
                <span className="actions-dot" aria-hidden />
                <strong>{counts[s]}</strong> {STATUS_LABEL[s]}
              </span>
            ))}
          </div>
        )}
      </div>

      {plans.length === 0 ? (
        <div className="actions-empty">
          <span className="actions-empty-icon" aria-hidden>⚡</span>
          <div>
            <strong>No actions launched yet.</strong>
            <span>
              Act on a store from Insights or from a Shuttle answer, and its plan shows up here with owners, due dates and
              status.
            </span>
          </div>
          <Link to="/insights" className="actions-empty-link">
            Find a store to act on →
          </Link>
        </div>
      ) : (
        <div className="actions-grid">
          {plans.map((plan, i) => (
            <PlanCard key={plan.ticket} plan={plan} now={now} index={i} />
          ))}
        </div>
      )}
    </section>
  )
}

function PlanCard({ plan, now, index }: { plan: TrackedPlan; now: number; index: number }) {
  const { ask } = useShuttle()
  const status = planStatus(plan, now)
  const statuses = plan.plays.map((_, i) => playStatus(plan, i, now))
  const done = statuses.filter((s) => s === 'done').length
  const store = shortStoreName(plan.store)

  return (
    <article className={`plan is-${status}`} style={{ '--i': index } as CSSProperties}>
      <header className="plan-head">
        <span className={`plan-status is-${status}`}>{status === 'done' ? 'Completed' : STATUS_LABEL[status]}</span>
        <code className="plan-ticket">{plan.ticket}</code>
        <span className={plan.priority === 'High' ? 'plan-priority is-high' : 'plan-priority'}>{plan.priority}</span>
      </header>

      <div className="plan-store">
        <div>
          <h3>{store}</h3>
          <span className="mono-label">
            {plan.region} · {plan.profile}
          </span>
        </div>
        {plan.opportunity > 0 && (
          <span className="plan-stake" title="Annual sales if the store reached its region's median sales per sq ft">
            <strong>{compactMoney(plan.opportunity)}</strong>/yr at stake
          </span>
        )}
      </div>

      <div className="plan-progress">
        <div className="plan-bar" role="img" aria-label={`${done} of ${plan.plays.length} plays done`}>
          {statuses.map((s, i) => (
            <span key={i} className={`is-${s}`} />
          ))}
        </div>
        <span className="mono-label">
          {done}/{plan.plays.length} done
        </span>
      </div>

      <ul className="plan-plays">
        {plan.plays.map((play, i) => {
          const s = statuses[i]
          const due = dueLabel(play.due, now)
          return (
            <li key={play.id} className={`is-${s}`}>
              <button
                type="button"
                className={`play-status is-${s}`}
                onClick={() => advancePlay(plan.ticket, i)}
                title="Change status"
                aria-label={`${play.title}: ${STATUS_LABEL[s]}. Change status`}
              >
                {STATUS_ICON[s]}
              </button>
              <div className="play-body">
                <span className="play-title">{play.title}</span>
                <span className="play-meta">
                  {play.owner} ·{' '}
                  {s === 'done' ? (
                    'done'
                  ) : (
                    <span className={due.late ? 'is-late' : undefined}>{due.text}</span>
                  )}
                </span>
              </div>
              <span className={`play-pill is-${s}`}>{STATUS_LABEL[s]}</span>
            </li>
          )
        })}
      </ul>

      <footer className="plan-foot">
        <span className="mono-label">
          {ago(now - plan.launchedAt)} · {plan.requestedBy}
          {plan.channels.length > 0 && ` · ${plan.channels.join(', ')}`} · re-check {prettyDate(plan.recheckOn)}
        </span>
        <button
          type="button"
          className="plan-ask"
          onClick={() =>
            ask(
              `How have sales per square foot and gross margin at ${plan.store} trended over the last 30 days, compared with the ${plan.region} region?`,
            )
          }
        >
          Check in with Shuttle ↗
        </button>
      </footer>
    </article>
  )
}
