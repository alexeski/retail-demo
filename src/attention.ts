import { searchData, type Row } from './storePerformance'
import { shortStoreName } from './storeActions'

// "Needs attention" on the Home page: the sharpest month-over-month declines in
// the data behind the Insights tabs (last full month vs the one before), each
// with a question for Shuttle. One signal per area:
// - Exec KPIs: the state with the steepest sales drop;
// - Store Performance: the store with the steepest sales drop, and the region
//   whose foot traffic fell most;
// - Category & Brand: the department that lost the most sales;
// - Customers & Basket: the age group that spent the least vs the month before.

export type AttentionAlert = {
  key: string
  /** Short code in the alert's tag, e.g. "#305", "IL", "45–54". */
  tag: string
  kind: string
  /** A steep drop (10% or more). */
  hot: boolean
  title: string
  detail: string
  /** What the Ask button sends to Shuttle. */
  q: string
  /** Size of the drop (0–1), for ordering. */
  severity: number
}

/** Complete months only: "last 2 months" excludes the month in progress. */
const LAST_TWO_MONTHS = "[Transaction Date].'last 2 months'"

/** Stores below this share of the median store's monthly sales are too small to flag. */
const MIN_STORE_SHARE = 0.5
/** States below this monthly sales level are too small to flag. */
const MIN_STATE_SALES = 10_000
const HOT = 0.1

type Change = { prev: number[]; cur: number[] }

/**
 * Splits rows of `[...keys, month, ...measures]` into the previous and current
 * month per key. Keys missing either month are dropped.
 */
function monthOverMonth(rows: Row[], keys: number): { changes: Map<string, Change>; month: number } {
  const month = Math.max(...rows.map((r) => Number(r[keys])))
  const byKey = new Map<string, Partial<Change>>()
  for (const r of rows) {
    const key = r.slice(0, keys).join('\u0000')
    const entry = byKey.get(key) ?? {}
    const values = r.slice(keys + 1).map((v) => Number(v) || 0)
    if (Number(r[keys]) === month) entry.cur = values
    else entry.prev = values
    byKey.set(key, entry)
  }
  const changes = new Map<string, Change>()
  for (const [k, v] of byKey) if (v.prev && v.cur) changes.set(k, v as Change)
  return { changes, month }
}

const change = (prev: number, cur: number) => (prev ? (cur - prev) / prev : 0)
const pct = (d: number) => `${Math.abs(d * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0)}%`
const money = (n: number) =>
  n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `$${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
      : `$${Math.round(n)}`
const money2 = (n: number) => `$${n.toFixed(2)}`

/** The entry with the steepest decline, if any declined. */
function steepest<T>(items: T[], delta: (t: T) => number): T | undefined {
  const worst = items.reduce<T | undefined>((w, t) => (w === undefined || delta(t) < delta(w) ? t : w), undefined)
  return worst !== undefined && delta(worst) < 0 ? worst : undefined
}

const STATE_CODES: Record<string, string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT',
  Delaware: 'DE', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI',
  Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC',
  'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
  Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
}

export async function getAttentionAlerts(): Promise<AttentionAlert[]> {
  const [stores, regionSales, regionTraffic, departments, states, ages] = await Promise.all([
    searchData(`[Store Name] [Store Region] [Transaction Date].monthly [Sales] ${LAST_TWO_MONTHS}`, 1000),
    searchData(`[Store Region] [Transaction Date].monthly [Sales] ${LAST_TWO_MONTHS}`, 50),
    searchData(`[Store Region] [Transaction Date].monthly [Foot Traffic] ${LAST_TWO_MONTHS}`, 50),
    searchData(`[Department] [Transaction Date].monthly [Sales] [Gross Profit (%)] ${LAST_TWO_MONTHS}`, 100),
    searchData(`[Store State] [Transaction Date].monthly [Sales] ${LAST_TWO_MONTHS}`, 200),
    searchData(`[Age Group] [Transaction Date].monthly [Sales] [Average Ticket Size] ${LAST_TWO_MONTHS}`, 50),
  ])

  const { changes: storeChanges, month } = monthOverMonth(stores, 2)
  const at = new Date(month * 1000)
  const mon = at.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  const monthName = at.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  const prevAt = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1))
  const prevMon = prevAt.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  const prevName = prevAt.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  const vs = `${monthName} versus ${prevName}`

  const alerts: AttentionAlert[] = []
  const regionSalesChange = new Map(
    [...monthOverMonth(regionSales, 1).changes].map(([r, c]) => [r, change(c.prev[0], c.cur[0])]),
  )

  // Store Performance: the store whose sales fell furthest.
  const storeList = [...storeChanges].map(([k, c]) => {
    const [name, region] = k.split('\u0000')
    return { name, region, prev: c.prev[0], cur: c.cur[0], d: change(c.prev[0], c.cur[0]) }
  })
  const prevSorted = storeList.map((s) => s.prev).sort((a, b) => a - b)
  const medianStore = prevSorted[Math.floor(prevSorted.length / 2)] ?? 0
  const store = steepest(
    storeList.filter((s) => s.prev >= medianStore * MIN_STORE_SHARE),
    (s) => s.d,
  )
  if (store) {
    const short = shortStoreName(store.name)
    const regionD = regionSalesChange.get(store.region)
    alerts.push({
      key: 'store',
      tag: short.match(/#\d+/)?.[0] ?? short,
      kind: 'Store',
      hot: -store.d >= HOT,
      title: `${short} sales down ${pct(store.d)} in ${mon}`,
      detail:
        `${money(store.prev)} in ${prevMon} to ${money(store.cur)}. ` +
        (regionD !== undefined ? `The ${store.region} region moved ${regionD < 0 ? '−' : '+'}${pct(regionD)}.` : ''),
      q: `Why did sales at ${store.name} drop in ${vs}, and which departments drove it?`,
      severity: -store.d,
    })
  }

  // Store Performance: the region whose foot traffic fell furthest.
  const traffic = [...monthOverMonth(regionTraffic, 1).changes].map(([region, c]) => ({
    region,
    d: change(c.prev[0], c.cur[0]),
  }))
  const region = steepest(traffic, (t) => t.d)
  if (region) {
    const salesD = regionSalesChange.get(region.region)
    alerts.push({
      key: 'traffic',
      tag: region.region.toUpperCase(),
      kind: 'Traffic',
      hot: -region.d >= HOT,
      title: `${region.region} foot traffic down ${pct(region.d)} in ${mon}`,
      detail:
        `The steepest drop of the ${traffic.length} regions.` +
        (salesD !== undefined ? ` Sales ${salesD < 0 ? 'fell' : 'rose'} ${pct(salesD)} vs ${prevMon}.` : ''),
      q: `Why did foot traffic in the ${region.region} region fall in ${vs}, and which stores were hit hardest?`,
      severity: -region.d,
    })
  }

  // Category & Brand: the department that lost the most sales in dollars.
  const depts = [...monthOverMonth(departments, 1).changes].map(([name, c]) => ({
    name,
    lost: c.prev[0] - c.cur[0],
    d: change(c.prev[0], c.cur[0]),
    margin: c.cur[1],
  }))
  const dept = steepest(depts, (x) => -x.lost)
  if (dept) {
    alerts.push({
      key: 'department',
      tag: dept.name.slice(0, 6).toUpperCase(),
      kind: 'Dept',
      hot: -dept.d >= HOT,
      title: `${dept.name} sales down ${pct(dept.d)} in ${mon}`,
      detail: `The biggest dollar decline of any department, ${money(dept.lost)}. Gross margin ${(dept.margin * 100).toFixed(1)}%.`,
      q: `Which stores and brands drove the drop in ${dept.name} sales in ${vs}?`,
      severity: -dept.d,
    })
  }

  // Exec KPIs: the state whose sales fell furthest (of those with meaningful sales).
  const stateList = [...monthOverMonth(states, 1).changes]
    .map(([name, c]) => ({ name, prev: c.prev[0], cur: c.cur[0], d: change(c.prev[0], c.cur[0]) }))
    .filter((s) => s.prev >= MIN_STATE_SALES)
  const state = steepest(stateList, (s) => s.d)
  if (state) {
    alerts.push({
      key: 'state',
      tag: STATE_CODES[state.name] ?? state.name.slice(0, 2).toUpperCase(),
      kind: 'State',
      hot: -state.d >= HOT,
      title: `${state.name} sales down ${pct(state.d)} in ${mon}`,
      detail: `${money(state.prev)} in ${prevMon} to ${money(state.cur)}, the steepest drop of any state over ${money(MIN_STATE_SALES)} a month.`,
      q: `Which stores and departments drove the drop in ${state.name} sales in ${vs}?`,
      severity: -state.d,
    })
  }

  // Customers & Basket: the age group whose spending fell furthest.
  const ageList = [...monthOverMonth(ages, 1).changes]
    .filter(([name]) => /\d/.test(name))
    .map(([name, c]) => ({ name, d: change(c.prev[0], c.cur[0]), ticket: c.cur[1], ticketD: change(c.prev[1], c.cur[1]) }))
  const age = steepest(ageList, (a) => a.d)
  if (age) {
    const label = age.name.replace('-', '–')
    alerts.push({
      key: 'age',
      tag: label,
      kind: 'Customers',
      hot: -age.d >= HOT,
      title: `Customers ${label} spent ${pct(age.d)} less in ${mon}`,
      detail: `Average ticket ${age.ticketD < 0 ? 'down' : 'up'} ${pct(age.ticketD)} to ${money2(age.ticket)}.`,
      q: `Why did customers aged ${age.name} spend less in ${vs}, and which categories did they cut back on?`,
      severity: -age.d,
    })
  }

  return alerts.sort((a, b) => b.severity - a.severity)
}
