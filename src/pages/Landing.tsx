import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Brand } from '../components/Brand'
import './Login.css'
import './Landing.css'

const STORES = [
  ['#002', 'Portland', 'OR'], ['#014', 'Phoenix', 'AZ'], ['#031', 'Denver', 'CO'], ['#047', 'Austin', 'TX'],
  ['#058', 'Chicago', 'IL'], ['#063', 'Nashville', 'TN'], ['#079', 'Atlanta', 'GA'], ['#088', 'Minneapolis', 'MN'],
  ['#102', 'Brooklyn', 'NY'], ['#117', 'Salt Lake', 'UT'], ['#126', 'San Diego', 'CA'], ['#139', 'Boston', 'MA'],
] as const

const ITEMS = [
  ['Linen overshirt', 68], ['Trail runner 9.5', 142], ['Wool beanie', 28], ['Canvas tote', 34], ['Rain shell M', 189], ['Merino crew L', 96],
  ['Camp mug', 18], ['Denim, 32×30', 118], ['Gift card', 50], ['Fleece vest S', 84], ['Sun hat', 39], ['Day pack 22L', 129],
] as const

const QUERIES = [
  'Which stores run out of size M fleece by Friday?',
  'Compare weekend sell-through, Denver vs. Austin',
  'What did loyalty members buy after the rain shell launch?',
]

const MODULES = [
  { code: 'MOD-01', tag: 'Front', name: 'Checkout', desc: 'Fast counter and mobile checkout that keeps selling when the internet drops, then syncs.', meta: 'Offline mode · Split tender', num: '0.8s' },
  { code: 'MOD-02', tag: 'Back', name: 'Inventory', desc: 'One stock pool across stores and warehouses, with transfers, counts and auto-reorder.', meta: 'Per-store bins · Cycle counts', num: '1 pool' },
  { code: 'MOD-03', tag: 'Front', name: 'Loyalty', desc: 'Points, tiers and receipts that follow the customer to any store or the website.', meta: 'Tiers · Digital receipts', num: '1 profile' },
  { code: 'MOD-04', tag: 'Online', name: 'Commerce', desc: 'Web storefront, buy online pick up in store, and ship-from-store on the same catalog.', meta: 'BOPIS · Ship-from-store', num: 'Any store' },
  { code: 'MOD-05', tag: 'Back', name: 'Workforce', desc: 'Shifts, clock-ins and commissions tied to the register each associate actually used.', meta: 'Scheduling · Commissions', num: 'Per shift' },
  { code: 'MOD-06', tag: 'Insight', name: 'Insights', desc: 'Ask questions in plain language and get answers from live sales and stock data.', meta: 'Search analytics · Alerts', num: 'Live' },
]

const CAPABILITIES = [
  'Transfer stock between any two stores',
  'Endless aisle: sell from a neighbor store',
  'Push prices and promos to every register at once',
]

const RISK = ([['Denver', 1.5], ['Salt Lake', 2], ['Minneapolis', 2.5], ['Chicago', 3], ['Boston', 3.5], ['Brooklyn', 4]] as const).map(([city, d]) => ({
  city,
  days: d + 'd',
  w: 100 - d * 18 + '%',
  hot: d <= 2,
}))

const SIZES = ['2–10', '11–50', '51–200', '200+']

// The loom band: each store is a warp thread, each sale, transfer or pickup a weft
// thread woven across them, knotted at the store it happened in.
type Kind = 'sale' | 'transfer' | 'pickup'
type Weft = { id: number; store: number; kind: Kind; item: string; price: number }
const KINDS: Kind[] = ['sale', 'sale', 'transfer', 'pickup']
const KIND_LABEL: Record<Kind, string> = { sale: 'Sold', transfer: 'Transfer', pickup: 'Pickup' }
const WEFT_ROWS = 8
/** Warp threads per store: enough for the cloth to read as woven. */
const THREADS = 4
const WARPS = Array.from({ length: STORES.length * THREADS }, (_, j) => j)
const warpX = (j: number) => `${((j + 0.5) / WARPS.length) * 100}%`
/** The middle of a store's group of threads. */
const storeX = (i: number) => `${((i + 0.5) / STORES.length) * 100}%`
const weftText = (w: Weft) => `${KIND_LABEL[w.kind]} · ${STORES[w.store][1]} ${STORES[w.store][0]} · ${w.item} · ${money(w.price)}`

// Deterministic barcode from the design.
const BARCODE = (() => {
  const bars: { w: number; ink: boolean }[] = []
  let seed = 7
  for (let i = 0; i < 46; i++) {
    seed = (seed * 9301 + 49297) % 233280
    bars.push({ w: 1 + (seed % 4), ink: i % 2 === 0 })
  }
  return bars
})()

function money(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

type Line = { store: string; item: string; price: number }

export function Landing() {
  const [still] = useState(prefersReducedMotion)

  // Live receipt + store grid
  const [lines, setLines] = useState<Line[]>(() =>
    [0, 1, 2, 3, 4, 5, 6].map((i) => ({ store: STORES[(i * 5) % 12][0], item: ITEMS[i][0], price: ITEMS[i][1] })),
  )
  const [total, setTotal] = useState(48213.4)
  const [sales, setSales] = useState(() => STORES.map((_, i) => 2400 + ((i * 7919) % 4100)))
  const [pulse, setPulse] = useState(-1)
  const [wefts, setWefts] = useState<Weft[]>(() =>
    Array.from({ length: WEFT_ROWS }, (_, i) => ({
      id: WEFT_ROWS - i,
      store: (i * 7) % STORES.length,
      kind: KINDS[i % KINDS.length],
      item: ITEMS[(i * 5) % ITEMS.length][0],
      price: ITEMS[(i * 5) % ITEMS.length][1],
    })),
  )
  const [woven, setWoven] = useState(1284)

  useEffect(() => {
    if (still) return
    const t = setInterval(() => {
      const si = Math.floor(Math.random() * STORES.length)
      const [item, price] = pick(ITEMS)
      setLines((l) => [...l, { store: STORES[si][0], item, price }].slice(-7))
      setTotal((v) => v + price)
      setSales((s) => s.map((v, i) => (i === si ? v + price : v)))
      setPulse(si)
      setWefts((w) => [{ id: (w[0]?.id ?? 0) + 1, store: si, kind: pick(KINDS), item, price }, ...w].slice(0, WEFT_ROWS))
      setWoven((n) => n + 1)
    }, 1700)
    return () => clearInterval(t)
  }, [still])

  // Typed Insights query
  const [typing, setTyping] = useState({ qi: 0, typed: still ? QUERIES[0] : '', hold: 0 })
  useEffect(() => {
    if (still) return
    const t = setInterval(() => {
      setTyping((s) => {
        const q = QUERIES[s.qi]
        if (s.typed.length < q.length) return { ...s, typed: q.slice(0, s.typed.length + 1) }
        if (s.hold < 60) return { ...s, hold: s.hold + 1 }
        return { qi: (s.qi + 1) % QUERIES.length, typed: '', hold: 0 }
      })
    }, 50)
    return () => clearInterval(t)
  }, [still])

  // Demo request (local only)
  const [size, setSize] = useState('11–50')
  const [sent, setSent] = useState(false)
  const submitDemo = (e: FormEvent) => {
    e.preventDefault()
    setSent(true)
  }

  return (
    <div className="landing">
      <header className="site-header">
        <Brand to="/" large />
        <nav className="landing-nav">
          <a href="#platform">Platform</a>
          <a href="#network">Store network</a>
          <a href="#insights">Insights</a>
          <a href="#demo">Pricing</a>
          <Link to="/login" className="landing-login">
            Log in
          </Link>
        </nav>
      </header>

      {/* HERO */}
      <section className="landing-hero">
        <div className="landing-hero-copy">
          <div className="eyebrow">
            <span className="tag">Unified commerce</span>
            <span>for multi-location retail</span>
          </div>
          <h1 className="display landing-h1">
            One register for <span className="highlight">every store</span> you run.
          </h1>
          <p className="landing-lede">
            Storeloom puts checkout, inventory, loyalty and online orders on a single live ledger, so a sale in Portland
            updates the shelf count in Phoenix before the receipt finishes printing.
          </p>
          <div className="landing-ctas">
            <a href="#demo" className="cta-primary">
              Book a demo <span>→</span>
            </a>
            <a href="#platform" className="cta-link">
              Tour the platform
            </a>
          </div>
        </div>

        <div className="receipt-wrap">
          <div className="receipt">
            <div className="receipt-paper">
              <div className="receipt-head">
                <span className="receipt-title">STORELOOM</span>
                <span>NETWORK RECEIPT · ALL LOCATIONS</span>
                <span>01 OCT 2026 · LIVE</span>
              </div>
              <div className="receipt-lines">
                {lines.map((l, i) => (
                  <div key={i} className={i === lines.length - 1 && !still ? 'receipt-line is-new' : 'receipt-line'}>
                    <span>{l.store}</span>
                    <span className="receipt-item">{l.item}</span>
                    <span>{money(l.price)}</span>
                  </div>
                ))}
              </div>
              <div className="receipt-totals">
                <div>
                  <span>STORES ONLINE</span>
                  <span>214 / 214</span>
                </div>
                <div className="receipt-total">
                  <span>NETWORK TOTAL</span>
                  <span>{money(total)}</span>
                </div>
              </div>
              <div className="barcode" aria-hidden>
                {BARCODE.map((b, i) => (
                  <span key={i} style={{ width: b.w, background: b.ink ? 'var(--ink)' : 'transparent' }} />
                ))}
              </div>
            </div>
            <div className="receipt-tear" aria-hidden />
            <div className="receipt-stamp">
              <span className="receipt-stamp-n">1</span>
              <span>
                ledger
                <br />
                every store
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* LOOM: the network's day, woven live */}
      <section className={still ? 'loom is-still' : 'loom'} aria-label="Today's store activity, woven live">
        <div className="loom-key">
          <span className="loom-eyebrow">Woven live</span>
          <span className="loom-count">{woven.toLocaleString('en-US')}</span>
          <span className="loom-count-label">threads across {STORES.length} stores today</span>
          <ul className="loom-legend">
            {(['sale', 'transfer', 'pickup'] as Kind[]).map((k) => (
              <li key={k}>
                <span className={`loom-swatch is-${k}`} aria-hidden />
                {KIND_LABEL[k]}
              </li>
            ))}
          </ul>
        </div>
        <div className="loom-frame">
          <div className="loom-cloth" aria-hidden>
            {WARPS.map((j) => (
              <span key={j} className={Math.floor(j / THREADS) === pulse ? 'loom-warp is-hot' : 'loom-warp'} style={{ left: warpX(j) }} />
            ))}
            {wefts.map((w, row) => (
              <div key={w.id} className={`loom-weft is-${w.kind}`} style={{ top: `${row * 13 + 8}px`, opacity: 1 - row * 0.09 }}>
                {/* Over one warp, under the next: where the weft goes under, the warp shows on top. */}
                {WARPS.map((j) =>
                  (j + w.id) % 2 === 0 ? (
                    <span key={j} className={Math.floor(j / THREADS) === pulse ? 'loom-under is-hot' : 'loom-under'} style={{ left: warpX(j) }} />
                  ) : null,
                )}
                <span className="loom-knot" style={{ left: storeX(w.store) }} />
              </div>
            ))}
          </div>
          <div className="loom-stores" aria-hidden>
            {STORES.map((st, i) => (
              <span key={st[0]} className={i === pulse ? 'is-hot' : undefined} style={{ left: storeX(i) }} title={st[1]}>
                {st[0]}
              </span>
            ))}
          </div>
          {wefts[0] && <p className="loom-latest">■ {weftText(wefts[0])}</p>}
        </div>
      </section>

      {/* PLATFORM */}
      <section id="platform" className="landing-section">
        <div className="section-head">
          <h2 className="section-h2">Everything a store needs, stocked on one shelf.</h2>
          <p className="section-note">Six modules. One data model. Turn on what you need, store by store.</p>
        </div>
        <div className="modules">
          {MODULES.map((m) => (
            <article key={m.code} className="module">
              <div className="module-top">
                <span>{m.code}</span>
                <span className="module-tag">{m.tag}</span>
              </div>
              <h3>{m.name}</h3>
              <p>{m.desc}</p>
              <div className="module-foot">
                <span>{m.meta}</span>
                <span className="module-num">{m.num}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* NETWORK */}
      <section id="network" className="network">
        <div className="network-copy">
          <span className="network-eyebrow">Store network · live</span>
          <h2 className="section-h2 is-small">See every shelf from every store.</h2>
          <p>
            Each location runs on the same catalog, prices and stock pool. Move inventory between stores in two taps, sell
            from a neighbor's back room, and open store 215 by cloning store 214.
          </p>
          <div className="capabilities">
            {CAPABILITIES.map((c, i) => (
              <div key={c}>
                <span>{String(i + 1).padStart(2, '0')}</span>
                <span>{c}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="network-grid-wrap">
          <div className="network-legend">
            <span>Today's sales by store</span>
            <span className="network-legend-dot">
              <span />
              Last sale
            </span>
          </div>
          <div className="network-grid">
            {STORES.map((st, i) => (
              <div key={st[0]} className={i === pulse ? 'store-tile is-hot' : 'store-tile'}>
                <div className="store-tile-top">
                  <span>{st[0]}</span>
                  <span>{st[2]}</span>
                </div>
                <span className="store-tile-city">{st[1]}</span>
                <span className="store-tile-sales">{money(sales[i])}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* QUOTE */}
      <section className="quote">
        <blockquote>
          <p>
            “We closed out four separate systems in one quarter. Our district managers stopped calling stores to ask what was
            on the shelf.”
          </p>
          <footer>
            <span className="quote-avatar" aria-hidden />
            <span>
              <strong>Dana Okafor</strong> · COO, Fieldhouse Outfitters · 142 stores
            </span>
          </footer>
        </blockquote>
      </section>

      {/* INSIGHTS */}
      <section id="insights" className="landing-section landing-insights">
        <div className="section-head">
          <h2 className="section-h2">Ask your stores anything.</h2>
          <Link to="/insights" className="insights-link">
            Open Storeloom Insights →
          </Link>
        </div>
        <div className="ask-demo">
          <div className="ask-demo-query">
            <span className="ask-demo-mark" />
            <span>
              {typing.typed}
              <span className={still ? 'caret is-still' : 'caret'} />
            </span>
          </div>
          <div className="ask-demo-body">
            <div className="ask-demo-answer">
              <span className="mono-label">Answer · 6 stores at risk</span>
              {RISK.map((r) => (
                <div key={r.city} className="risk-row">
                  <span className="risk-city">{r.city}</span>
                  <span className="bar is-tall">
                    <span style={{ width: r.w, background: r.hot ? 'var(--accent)' : 'var(--ink)' }} />
                  </span>
                  <span className="risk-days">{r.days}</span>
                </div>
              ))}
            </div>
            <div className="ask-demo-side">
              <p>
                Insights reads the same ledger your registers write to. Questions are answered from live sales and stock,
                without exports or overnight reports.
              </p>
              <div className="ask-demo-chips">
                <span>Sell-through</span>
                <span>Stock cover</span>
                <span>Basket size</span>
                <span>Labor vs. traffic</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* DEMO */}
      <section id="demo" className="demo">
        <div className="demo-copy">
          <h2 className="display demo-h2">Open your next store on Storeloom.</h2>
          <p>Pricing is per location, with no per-register fees. We'll migrate your catalog and customer history for you.</p>
        </div>
        <form className="demo-form" onSubmit={submitDemo}>
          <div className="demo-form-head">
            <span>Demo request</span>
            <span>No. 0215</span>
          </div>
          <label className="field">
            Work email
            <input type="email" placeholder="you@company.com" />
          </label>
          <div className="field">
            <span>Number of stores</span>
            <div className="demo-sizes">
              {SIZES.map((s) => (
                <button key={s} type="button" className={s === size ? 'is-active' : ''} onClick={() => setSize(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
          <button type="submit" className="login-submit demo-submit">
            <span>{sent ? "Thanks, we'll be in touch" : 'Request a demo'}</span>
            <span>→</span>
          </button>
        </form>
      </section>

      <footer className="site-footer">
        <span>© 2026 Storeloom · Demo brand</span>
        <div>
          <a href="#platform">Platform</a>
          <a href="#network">Network</a>
          <a href="#insights">Insights</a>
          <a href="#demo">Contact</a>
        </div>
      </footer>
    </div>
  )
}
