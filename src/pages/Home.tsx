import { useEffect, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react'
import { useTrackedPlans } from '../actionTracker'
import { getAttentionAlerts, type AttentionAlert } from '../attention'
import { firstName, useAuth } from '../auth'
import { ActionsInMotion } from '../components/ActionsInMotion'
import { CountUp } from '../components/CountUp'
import { SHUTTLE_SUGGESTIONS, useShuttle } from '../components/Shuttle'
import { getTodayKpis, type TodayKpis } from '../homeKpis'
import { shortStoreName } from '../storeActions'
import './Home.css'

const FEED = [
  { t: '09:11', text: 'Transfer #4471 received at Boston #139' },
  { t: '09:06', text: 'Price change pushed to 214 stores · Fall outerwear' },
  { t: '08:52', text: 'Online order picked up at Portland #002' },
  { t: '08:40', text: 'Atlanta #079 · 3 registers switched to offline mode' },
]

const formatNow = (d: Date) => {
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).replace(',', '')
  return `${day} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}

const greeting = (d: Date) => (d.getHours() < 12 ? 'Good morning' : d.getHours() < 18 ? 'Good afternoon' : 'Good evening')

const money0 = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
const money2 = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const int = (n: number) => Math.round(n).toLocaleString('en-US')

const pctChange = (now: number, before: number) => (before ? ((now - before) / before) * 100 : 0)
const arrow = (d: number) => (d >= 0 ? '▲' : '▼')

/** Day buckets are UTC midnight, so read the weekday in UTC. */
const weekday = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })

type KpiCard = { label: string; value?: number; format: (n: number) => string; suffix?: string; delta?: string; down?: boolean; alert?: boolean }

function kpiCards(k: TodayKpis | null): KpiCard[] {
  if (!k) {
    return [
      { label: 'Net sales · today', format: money0 },
      { label: 'Transactions', format: int },
      { label: 'Avg basket', format: money2 },
      { label: 'Stores trading', format: int },
    ]
  }
  const { today, lastWeek } = k
  const salesD = pctChange(today.sales, lastWeek.sales)
  const txD = pctChange(today.transactions, lastWeek.transactions)
  const basket = today.transactions ? today.sales / today.transactions : 0
  const basketPrev = lastWeek.transactions ? lastWeek.sales / lastWeek.transactions : 0
  const basketD = basket - basketPrev
  const quiet = k.storesTotal - k.storesTrading
  return [
    { label: 'Net sales · today', value: today.sales, format: money0, delta: `${arrow(salesD)} ${Math.abs(salesD).toFixed(1)}% vs last ${weekday(lastWeek.date)}`, down: salesD < 0 },
    { label: 'Transactions', value: today.transactions, format: int, delta: `${arrow(txD)} ${Math.abs(txD).toFixed(1)}%`, down: txD < 0 },
    { label: 'Avg basket', value: basket, format: money2, delta: `${arrow(basketD)} ${money2(Math.abs(basketD))}`, down: basketD < 0 },
    {
      label: 'Stores trading',
      value: k.storesTrading,
      format: int,
      suffix: ` / ${int(k.storesTotal)}`,
      delta: quiet > 0 ? `${quiet} with no sales yet today` : 'All stores trading',
      alert: quiet > 0,
    },
  ]
}

export function Home() {
  const { user } = useAuth()
  const { ask } = useShuttle()
  const [now] = useState(() => new Date())

  const [kpis, setKpis] = useState<TodayKpis | null>(null)
  const [status, setStatus] = useState<{ loading: boolean; error?: boolean; at?: Date }>({ loading: true })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setStatus((s) => ({ ...s, loading: true, error: false }))
    getTodayKpis()
      .then((k) => {
        if (cancelled) return
        setKpis(k)
        setStatus({ loading: false, at: new Date() })
      })
      .catch((err) => {
        if (cancelled) return
        console.error("Could not load today's figures", err)
        setStatus({ loading: false, error: true })
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  // Needs attention: the sharpest declines in the dashboards' data.
  const [alerts, setAlerts] = useState<AttentionAlert[] | null>(null)
  const [alertsError, setAlertsError] = useState(false)
  const [alertsAttempt, setAlertsAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    setAlertsError(false)
    getAttentionAlerts()
      .then((a) => !cancelled && setAlerts(a))
      .catch((err) => {
        if (cancelled) return
        console.error('Could not load the attention alerts', err)
        setAlertsError(true)
      })
    return () => {
      cancelled = true
    }
  }, [alertsAttempt])

  // Plans launched this session lead the feed.
  const plans = useTrackedPlans()
  const feed = [
    ...plans.map((p) => ({
      key: p.ticket,
      t: new Date(p.launchedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      text: `Action plan ${p.ticket} launched for ${shortStoreName(p.store)} · ${p.plays.length} play${p.plays.length === 1 ? '' : 's'}`,
      mine: true,
    })),
    ...FEED.map((f) => ({ ...f, key: f.t, mine: false })),
  ]

  const cards = kpiCards(kpis)
  const topMax = kpis?.topStores[0]?.sales || 1

  return (
    <div className="home">
      {/* HERO / SHUTTLE */}
      <section className="hero">
        <div className="eyebrow">
          <span>{formatNow(now)}</span>
          <span className="eyebrow-rule" />
          <span>{greeting(now)}, {user ? firstName(user) : 'there'}</span>
        </div>
        <h1 className="display hero-h1">
          What should we <span className="highlight">pull together</span> today?
        </h1>

        <AskPalette onAsk={ask} />
      </section>

      {/* TODAY STRIP */}
      <div className={`today-status is-${status.error ? 'error' : status.loading ? 'loading' : 'ready'}`} aria-live="polite">
        {status.loading ? (
          <>
            <span className="today-spinner" aria-hidden />
            Syncing today's figures…
          </>
        ) : status.error ? (
          <>
            Couldn’t load today’s figures.
            <button type="button" onClick={() => setAttempt((a) => a + 1)}>
              Retry
            </button>
          </>
        ) : (
          <>
            <span className="today-live" aria-hidden />
            Live · updated {status.at?.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </>
        )}
      </div>
      <section className={kpis ? 'kpi-strip is-ready' : 'kpi-strip'} aria-busy={status.loading}>
        {cards.map((k, i) => (
          <div key={k.label} className="kpi" style={{ '--i': i } as CSSProperties}>
            <span className="mono-label">{k.label}</span>
            {k.value === undefined ? (
              <>
                <span className="kpi-value">
                  <span className="home-skeleton is-tall" />
                </span>
                <span className="kpi-delta">
                  <span className="home-skeleton" />
                </span>
              </>
            ) : (
              <>
                <span className="kpi-value">
                  <CountUp value={k.value} format={k.format} delay={i * 90} />
                  {k.suffix && <span className="kpi-suffix">{k.suffix}</span>}
                </span>
                <span className={['kpi-delta', k.down && 'is-down', k.alert && 'is-alert'].filter(Boolean).join(' ')}>{k.delta}</span>
              </>
            )}
          </div>
        ))}
      </section>

      {/* WORK AREA */}
      <section className="work">
        <div className="work-col">
          <div className="work-head">
            <h2>Needs attention</h2>
            <span className="mono-label">{alerts ? `${alerts.length} open · last month` : alertsError ? '' : 'Checking…'}</span>
          </div>
          <div className={alerts ? 'alerts is-ready' : 'alerts'}>
            {alertsError && (
              <div className="alerts-error">
                Couldn’t check the latest figures.
                <button type="button" onClick={() => setAlertsAttempt((n) => n + 1)}>
                  Retry
                </button>
              </div>
            )}
            {!alerts && !alertsError &&
              Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="alert is-loading" aria-hidden>
                  <div className="alert-tag" />
                  <div className="alert-body">
                    <span className="home-skeleton" />
                    <span className="home-skeleton is-wide" />
                  </div>
                </div>
              ))}
            {alerts?.length === 0 && <div className="alerts-error">No sharp declines last month.</div>}
            {alerts?.map((a, i) => (
              <div key={a.key} className="alert" style={{ '--i': i } as CSSProperties}>
                <div className={a.hot ? 'alert-tag is-hot' : 'alert-tag'}>
                  <span className="alert-store">{a.tag}</span>
                  <span className="alert-kind">{a.kind}</span>
                </div>
                <div className="alert-body">
                  <span className="alert-title">{a.title}</span>
                  <span className="alert-detail">{a.detail}</span>
                </div>
                <button type="button" className="alert-ask" onClick={() => ask(a.q)}>
                  Ask ↗
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="work-col">
          <div className="work-head">
            <h2>Top stores today</h2>
            <span className="mono-label">Net sales</span>
          </div>
          <div className={kpis ? 'leaders is-ready' : 'leaders'}>
            {kpis
              ? kpis.topStores.map((l, i) => (
                  <div key={l.name} className="leader" style={{ '--i': i } as CSSProperties}>
                    <span className="leader-rank">{String(i + 1).padStart(2, '0')}</span>
                    <span className="leader-city" title={l.name}>
                      {l.name}
                    </span>
                    <span className="bar">
                      <span
                        style={{ width: `${Math.round((l.sales / topMax) * 100)}%`, background: i === 0 ? 'var(--accent)' : 'var(--ink)' }}
                      />
                    </span>
                    <CountUp className="leader-sales" value={l.sales} format={money0} delay={i * 70} />
                  </div>
                ))
              : Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="leader">
                    <span className="leader-rank">{String(i + 1).padStart(2, '0')}</span>
                    <span className="home-skeleton" />
                    <span className="bar" />
                    <span className="home-skeleton" />
                  </div>
                ))}
          </div>

          <div className="feed">
            <span className="feed-title">Network feed</span>
            {feed.map((f) => (
              <div key={f.key} className={f.mine ? 'feed-row is-mine' : 'feed-row'}>
                <span className="feed-time">{f.t}</span>
                <span>{f.text}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ACTIONS LAUNCHED THIS SESSION */}
      <ActionsInMotion />
    </div>
  )
}

/**
 * The hero's Shuttle bar as a command palette: the question box with the starter
 * questions as rows beneath it. Typing narrows the rows; arrow keys pick one and
 * Enter asks it.
 */
function AskPalette({ onAsk }: { onAsk: (q: string) => void }) {
  const [text, setText] = useState('')
  const [active, setActive] = useState(-1)

  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  const rows = SHUTTLE_SUGGESTIONS.filter(({ q }) => words.every((w) => q.toLowerCase().includes(w)))

  const ask = (q: string) => {
    if (!q.trim()) return
    onAsk(q)
    setText('')
    setActive(-1)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    ask(active >= 0 && rows[active] ? rows[active].q : text)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!rows.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % rows.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i <= 0 ? rows.length - 1 : i - 1))
    } else if (e.key === 'Escape') {
      setActive(-1)
    }
  }

  return (
    <form onSubmit={submit} className="ask-card">
      <div className="ask-card-row">
        <span className="shuttle-pill is-large" aria-hidden />
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setActive(-1)
          }}
          onKeyDown={onKeyDown}
          placeholder="Ask Shuttle about any store, product or shift…"
          className="ask-input"
          role="combobox"
          aria-label="Ask Shuttle"
          aria-expanded={rows.length > 0}
          aria-controls="ask-suggestions"
          aria-activedescendant={active >= 0 ? `ask-suggestion-${active}` : undefined}
          aria-autocomplete="list"
        />
        <button type="submit" className="ask-btn">
          Ask <span>→</span>
        </button>
      </div>
      {rows.length > 0 && (
        <ul className="ask-suggestions" id="ask-suggestions" role="listbox" aria-label="Suggested questions">
          {rows.map(({ q, topic }, i) => (
            <li
              key={q}
              id={`ask-suggestion-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'is-active' : undefined}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(-1)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => ask(q)}
            >
              <span className="ask-suggestion-icon" aria-hidden>
                ↗
              </span>
              <span className="ask-suggestion-q">{q}</span>
              <span className="ask-suggestion-meta">{i === active ? 'Enter ↵' : topic}</span>
            </li>
          ))}
        </ul>
      )}
    </form>
  )
}
