import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../auth'
import {
  getRegionStores,
  getStoreProfile,
  QUADRANTS,
  recommendedPlays,
  shortStoreName,
  type Play,
  type RegionStore,
  type StoreProfile,
  type StoreSelection,
} from '../storeActions'
import { CountUp } from './CountUp'
import './StoreActionPanel.css'

const money0 = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
const money2 = (n: number) => '$' + n.toFixed(2)
const int = (n: number) => Math.round(n).toLocaleString('en-US')
const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : int(n))
const pct = (a: number, b: number) => (b ? Math.round((a / b - 1) * 100) : 0)
const signed = (n: number) => (n > 0 ? `+${n}` : String(n))

const isoInDays = (days: number) => {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}
const prettyDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

type Phase = 'form' | 'running' | 'done'
type RunStep = { label: string; ref?: string }

/**
 * From insight to action: a store picked on the scatter chart, profiled against
 * its region, with plays recommended for its quadrant. Submitting runs a
 * simulated workflow (nothing leaves the browser).
 */
export function StoreActionPanel({
  store,
  region,
  onClose,
  onPick,
}: {
  /** null: start by picking a store from `region`. */
  store: StoreSelection | null
  region?: string
  onClose: () => void
  onPick: (store: StoreSelection) => void
}) {
  const { user } = useAuth()
  const [profile, setProfile] = useState<StoreProfile | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [values, setValues] = useState<Record<string, Record<string, string>>>({})
  const [due, setDue] = useState<Record<string, string>>({})
  const [priority, setPriority] = useState('High')
  const [notifySlack, setNotifySlack] = useState(true)
  const [notifyEmail, setNotifyEmail] = useState(true)
  const [notes, setNotes] = useState('')

  const [phase, setPhase] = useState<Phase>('form')
  const [run, setRun] = useState<RunStep[]>([])
  const [runDone, setRunDone] = useState(0)

  useEffect(() => {
    if (!store) return
    let cancelled = false
    setProfile(null)
    setPhase('form')
    setError(false)
    getStoreProfile(store)
      .then((p) => !cancelled && setProfile(p))
      .catch((err) => {
        console.error('Could not load store profile', err)
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [store, attempt])

  const recs = useMemo(() => (profile ? recommendedPlays(profile) : null), [profile])

  // Pre-fill the form once the profile lands.
  useEffect(() => {
    if (!profile || !recs) return
    setSelected(new Set(recs.preselected))
    setValues(Object.fromEntries(recs.plays.map((p) => [p.id, { ...p.defaults }])))
    setDue(Object.fromEntries(recs.plays.map((p) => [p.id, isoInDays(p.dueInDays)])))
    const q = QUADRANTS[profile.quadrant]
    setPriority(q.tone === 'risk' ? 'High' : 'Medium')
    setNotes(
      `${shortStoreName(profile.name)} (${profile.region}) · ${q.label}. ` +
        `${money2(profile.salesPerSqFt)} sales per sq ft vs ${money2(profile.regionMedianSalesPerSqFt)} region median ` +
        `on ${int(profile.sqFt)} sq ft (rank ${profile.rankInRegion}/${profile.regionStores}).` +
        (profile.opportunity > 0 ? ` Annual opportunity to median: ${money0(profile.opportunity)}.` : ''),
    )
  }, [profile, recs])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || phase === 'running') return
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, phase])

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const setValue = (play: string, key: string, v: string) => setValues((all) => ({ ...all, [play]: { ...all[play], [key]: v } }))

  const launch = () => {
    if (!profile || !recs || selected.size === 0) return
    const ticket = `SL-${48000 + Math.floor(Math.random() * 1000)}`
    const chosen = recs.plays.filter((p) => selected.has(p.id))
    const steps: RunStep[] = [
      { label: `Action plan ${ticket} created for ${shortStoreName(profile.name)}`, ref: ticket },
      ...chosen.flatMap((p, i) =>
        p.steps.map((label, j) => ({
          label: `${label} · due ${prettyDate(due[p.id])}`,
          ref: j === 0 ? `${ticket}-${i + 1}` : undefined,
        })),
      ),
      ...(notifySlack ? [{ label: `Posted to #${profile.region.toLowerCase()}-store-ops with the chart snapshot` }] : []),
      ...(notifyEmail ? [{ label: `${chosen.length} owner${chosen.length === 1 ? '' : 's'} notified by email` }] : []),
      { label: 'Follow-up check scheduled: re-measure sales per sq ft in 30 days' },
    ]
    setRun(steps)
    setRunDone(0)
    setPhase('running')
  }

  // Reveal the simulated workflow one step at a time.
  useEffect(() => {
    if (phase !== 'running') return
    if (runDone >= run.length) {
      const t = setTimeout(() => setPhase('done'), 500)
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => setRunDone((n) => n + 1), 550 + Math.random() * 350)
    return () => clearTimeout(t)
  }, [phase, runDone, run.length])

  const q = profile ? QUADRANTS[profile.quadrant] : null
  const chosen = recs?.plays.filter((p) => selected.has(p.id)) ?? []

  return createPortal(
    <div className="sa-scrim" onClick={phase === 'running' ? undefined : onClose}>
      <aside
        className="sa-panel"
        role="dialog"
        aria-label={store ? `Action plan for ${store.name}` : 'Pick a store'}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sa-head">
          <div>
            <span className="sa-eyebrow mono-label">From insight to action</span>
            <h2>{store ? shortStoreName(store.name) : 'Act on a store'}</h2>
            <span className="sa-sub mono-label">
              {store
                ? `${profile?.region ?? store.region ?? 'Loading region…'} · Store action plan`
                : `${region || 'All regions'} · weakest sales per sq ft first`}
            </span>
          </div>
          <button type="button" className="drawer-close" aria-label="Close" onClick={onClose} disabled={phase === 'running'}>
            ×
          </button>
        </header>

        {!store ? (
          <StorePicker region={region ?? ''} onPick={onPick} />
        ) : (
        <>
        <div className="sa-body">
          {error && (
            <div className="sa-error" role="alert">
              Couldn’t load this store’s figures.
              <button type="button" onClick={() => setAttempt((a) => a + 1)}>
                Retry
              </button>
            </div>
          )}

          {/* SNAPSHOT */}
          <section className="sa-section">
            <h3 className="mono-label">Snapshot · last 12 months</h3>
            <div className="sa-stats">
              {[
                { label: 'Sales', value: profile?.sales12m, format: money0 },
                { label: 'Selling sq ft', value: profile?.sqFt, format: int, note: profile && `${signed(pct(profile.sqFt, profile.regionMedianSqFt))}% vs median` },
                {
                  label: 'Sales / sq ft',
                  value: profile?.salesPerSqFt,
                  format: money2,
                  note: profile && `${signed(pct(profile.salesPerSqFt, profile.regionMedianSalesPerSqFt))}% vs median`,
                  bad: profile ? profile.salesPerSqFt < profile.regionMedianSalesPerSqFt : false,
                },
                { label: 'Foot traffic · 30d', value: profile?.footTraffic30d, format: compact },
                { label: 'Transactions · 30d', value: profile?.transactions30d, format: int },
                {
                  label: 'Avg ticket · 30d',
                  value: profile && profile.transactions30d ? profile.sales30d / profile.transactions30d : profile ? 0 : undefined,
                  format: money2,
                },
              ].map((s, i) => (
                <div key={s.label} className="sa-stat">
                  <span className="mono-label">{s.label}</span>
                  {s.value === undefined ? (
                    <span className="home-skeleton is-tall" />
                  ) : (
                    <CountUp className="sa-stat-value" value={s.value} format={s.format} delay={i * 60} />
                  )}
                  {s.note && <span className={s.bad ? 'sa-stat-note is-bad' : 'sa-stat-note'}>{s.note}</span>}
                </div>
              ))}
            </div>
            {profile && profile.topCategories.length > 0 && (
              <div className="sa-mix">
                <span className="mono-label">Sales mix</span>
                <div className="sa-mix-bar">
                  {profile.topCategories.map((c, i) => (
                    <span key={c.name} style={{ width: `${c.share * 100}%` }} className={`is-${i}`} title={`${c.name} ${Math.round(c.share * 100)}%`}>
                      {c.share > 0.12 ? `${c.name} ${Math.round(c.share * 100)}%` : ''}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* DIAGNOSIS */}
          {profile && q && (
            <section className={`sa-diagnosis is-${q.tone}`}>
              <div className="sa-diagnosis-head">
                <span className="sa-badge">{q.label}</span>
                <span className="mono-label">
                  Rank {profile.rankInRegion} of {profile.regionStores} in {profile.region} on sales per sq ft
                </span>
              </div>
              <p>{q.summary}</p>
              {profile.opportunity > 0 && (
                <p className="sa-opportunity">
                  Reaching the {profile.region} median of {money2(profile.regionMedianSalesPerSqFt)} per sq ft is worth{' '}
                  <strong>
                    <CountUp value={profile.opportunity} format={money0} duration={1200} />
                  </strong>{' '}
                  in annual sales.
                </p>
              )}
            </section>
          )}

          {/* PLAYS */}
          {recs && phase === 'form' && (
            <section className="sa-section">
              <h3 className="mono-label">Recommended plays · pick any</h3>
              <div className="sa-plays">
                {recs.plays.map((p) => (
                  <PlayCard
                    key={p.id}
                    play={p}
                    on={selected.has(p.id)}
                    onToggle={() => toggle(p.id)}
                    values={values[p.id] ?? {}}
                    onValue={(k, v) => setValue(p.id, k, v)}
                    due={due[p.id] ?? ''}
                    onDue={(v) => setDue((d) => ({ ...d, [p.id]: v }))}
                  />
                ))}
              </div>
            </section>
          )}

          {/* ROUTING */}
          {recs && phase === 'form' && (
            <section className="sa-section sa-routing">
              <h3 className="mono-label">Routing</h3>
              <div className="sa-routing-row">
                <label className="sa-field">
                  <span>Priority</span>
                  <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                    {['Critical', 'High', 'Medium', 'Low'].map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                </label>
                <label className="sa-check">
                  <input type="checkbox" checked={notifySlack} onChange={(e) => setNotifySlack(e.target.checked)} />
                  <span>Post to #{(profile?.region ?? 'region').toLowerCase()}-store-ops</span>
                </label>
                <label className="sa-check">
                  <input type="checkbox" checked={notifyEmail} onChange={(e) => setNotifyEmail(e.target.checked)} />
                  <span>Email the owners</span>
                </label>
              </div>
              <label className="sa-field">
                <span>Context for the team</span>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
              </label>
            </section>
          )}

          {/* RUN */}
          {phase !== 'form' && (
            <section className="sa-section sa-run" aria-live="polite">
              <h3 className="mono-label">{phase === 'done' ? 'Action plan launched' : 'Launching action plan…'}</h3>
              <ol>
                {run.map((s, i) => (
                  <li key={i} className={i < runDone ? 'is-done' : i === runDone ? 'is-current' : ''}>
                    <span className="sa-run-icon" aria-hidden>
                      {i < runDone ? '✓' : i === runDone ? <span className="sa-shuttle" /> : '·'}
                    </span>
                    <span>{s.label}</span>
                    {s.ref && i < runDone && <code>{s.ref}</code>}
                  </li>
                ))}
              </ol>
              {phase === 'done' && (
                <div className="sa-done">
                  <strong>
                    {chosen.length} play{chosen.length === 1 ? '' : 's'} in motion for {shortStoreName(store.name)}.
                  </strong>{' '}
                  Owners have their tasks; Shuttle will re-check sales per sq ft in 30 days and flag the result on your Home page.
                  <span className="sa-demo-note mono-label">Demo · simulated, nothing was sent</span>
                </div>
              )}
            </section>
          )}
        </div>

        <footer className="sa-foot">
          {phase === 'form' ? (
            <>
              <span className="mono-label">
                {chosen.length} play{chosen.length === 1 ? '' : 's'} · requested by {user?.displayName ?? 'you'}
              </span>
              <button type="button" className="btn-primary" disabled={!recs || chosen.length === 0} onClick={launch}>
                Launch action plan →
              </button>
            </>
          ) : (
            <>
              <span className="mono-label">{phase === 'running' ? `${runDone}/${run.length} steps` : 'All steps complete'}</span>
              <button type="button" className="btn-primary" disabled={phase === 'running'} onClick={onClose}>
                Done
              </button>
            </>
          )}
        </footer>
        </>
        )}
      </aside>
    </div>,
    document.body,
  )
}

function PlayCard({
  play,
  on,
  onToggle,
  values,
  onValue,
  due,
  onDue,
}: {
  play: Play
  on: boolean
  onToggle: () => void
  values: Record<string, string>
  onValue: (key: string, v: string) => void
  due: string
  onDue: (v: string) => void
}) {
  return (
    <div className={on ? 'sa-play is-on' : 'sa-play'}>
      <label className="sa-play-head">
        <input type="checkbox" checked={on} onChange={onToggle} />
        <span className="sa-play-box" aria-hidden />
        <span className="sa-play-title">{play.title}</span>
        <span className="sa-play-owner mono-label">{play.owner}</span>
      </label>
      <p className="sa-play-why">{play.why}</p>
      {on && (
        <div className="sa-play-fields">
          {play.fields.map((f) =>
            f.kind === 'select' ? (
              <label key={f.key} className="sa-field">
                <span>{f.label}</span>
                <select value={values[f.key] ?? ''} onChange={(e) => onValue(f.key, e.target.value)}>
                  {f.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </label>
            ) : f.kind === 'number' ? (
              <label key={f.key} className="sa-field">
                <span>{f.label}</span>
                <span className="sa-input-wrap">
                  {f.prefix && <span>{f.prefix}</span>}
                  <input type="number" min={0} value={values[f.key] ?? ''} onChange={(e) => onValue(f.key, e.target.value)} />
                  {f.suffix && <span>{f.suffix}</span>}
                </span>
              </label>
            ) : null,
          )}
          <label className="sa-field">
            <span>{play.fields.some((f) => f.kind === 'date') ? 'Visit date' : 'Due'}</span>
            <input type="date" value={due} onChange={(e) => onDue(e.target.value)} />
          </label>
        </div>
      )}
    </div>
  )
}

/** First step from the chart-header action: choose which store to act on. */
function StorePicker({ region, onPick }: { region: string; onPick: (store: StoreSelection) => void }) {
  const [stores, setStores] = useState<RegionStore[] | null>(null)
  const [error, setError] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    getRegionStores(region)
      .then((s) => !cancelled && setStores(s))
      .catch((err) => {
        console.error('Could not load region stores', err)
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [region])

  const shown = (stores ?? []).filter((s) => s.name.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <div className="sa-body">
      <p className="sa-picker-intro">
        Choose a store from the chart. Stores are ordered by sales per sq ft, weakest first, and tagged with their
        quadrant.
      </p>
      <input
        className="sa-picker-search"
        type="search"
        placeholder="Search stores…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      {error && <div className="sa-error">Couldn’t load the region’s stores.</div>}
      <ul className="sa-picker">
        {stores === null && !error
          ? Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="sa-picker-row">
                <span className="home-skeleton" />
              </li>
            ))
          : shown.map((s) => (
              <li key={s.name}>
                <button
                  type="button"
                  className="sa-picker-row"
                  onClick={() => onPick({ name: s.name, region: region || undefined, sales: s.sales, sqFt: s.sqFt })}
                >
                  <span className="sa-picker-name">{shortStoreName(s.name)}</span>
                  <span className={`sa-picker-tag is-${QUADRANTS[s.quadrant].tone}`}>{QUADRANTS[s.quadrant].label}</span>
                  <span className="sa-picker-num">{int(s.sqFt)} sq ft</span>
                  <span className="sa-picker-num is-strong">{money2(s.salesPerSqFt)}/sq ft</span>
                  <span aria-hidden>→</span>
                </button>
              </li>
            ))}
      </ul>
    </div>
  )
}
