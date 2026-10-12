import { searchData } from './storePerformance'

/** "Sales per Store Sq Ft vs Store Space" on the Region Performance dashboard. */
export const STORE_SCATTER_VIZ_ID = 'd3bee419-976d-4970-aa06-64267d80b9d7'
/** Context-menu action on a clicked store (charts that support point context menus). */
export const STORE_ACTION_ID = 'store-action-plan'
/** Chart-header action: pick a store from the region (works on any chart type). */
export const STORE_PICK_ACTION_ID = 'store-action-pick'

/** A store picked on the scatter chart. */
export type StoreSelection = { name: string; region?: string; sales?: number; sqFt?: number }

type PointColumn = { column?: { name?: string }; value?: unknown }
type ClickedPoint = { selectedAttributes?: PointColumn[]; selectedMeasures?: PointColumn[] }

const find = (cols: PointColumn[] | undefined, re: RegExp) => cols?.find((c) => re.test(c.column?.name ?? ''))?.value
const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v))

/** Reads the store from a clicked point (VizPointClick or a context-menu custom action). */
export function storeFromPoint(point: ClickedPoint | undefined): StoreSelection | null {
  const name = find(point?.selectedAttributes, /store name/i)
  if (!name) return null
  return {
    name: String(name),
    region: find(point?.selectedAttributes, /store region/i) as string | undefined,
    sales: num(find(point?.selectedMeasures, /^(total )?sales$/i)),
    sqFt: num(find(point?.selectedMeasures, /square footage/i)),
  }
}

export const shortStoreName = (name: string) => name.replace(/\s+Store\s+(?=#)/, ' ')

// ---------------------------------------------------------------------------
// Store profile, benchmarked against its region
// ---------------------------------------------------------------------------

export type Quadrant = 'big-efficient' | 'big-under' | 'small-efficient' | 'small-low'

export type StoreProfile = {
  name: string
  region: string
  sales12m: number
  sqFt: number
  salesPerSqFt: number
  regionMedianSqFt: number
  regionMedianSalesPerSqFt: number
  regionStores: number
  /** 1 = best sales per sq ft in the region. */
  rankInRegion: number
  quadrant: Quadrant
  /** Annual sales if the store reached the region's median sales per sq ft (0 if already above). */
  opportunity: number
  footTraffic30d: number
  transactions30d: number
  sales30d: number
  topCategories: { name: string; sales: number; share: number }[]
  /** Region stores with the lowest sales per sq ft (excluding this one), for peer plays. */
  weakestPeers: string[]
  /** Region stores with the highest sales per sq ft (excluding this one). */
  strongestPeers: string[]
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0
}

const q = (v: string) => `'${v.replace(/'/g, "\\'")}'`

export type RegionStore = { name: string; sqFt: number; sales: number; salesPerSqFt: number; quadrant: Quadrant }

/** Every store in a region (last 12 months), weakest sales per sq ft first, with its quadrant. */
export async function getRegionStores(region: string): Promise<RegionStore[]> {
  const rows = await searchData(
    `[Store Name] [Store Selling Square Footage] [Sales] [Transaction Date].'last 12 months' ${region ? `[Store Region].${q(region)}` : ''}`,
    1000,
  )
  const stores = rows
    .map(([name, sqFt, sales]) => ({ name: String(name), sqFt: Number(sqFt) || 0, sales: Number(sales) || 0 }))
    .filter((s) => s.sqFt > 0)
    .map((s) => ({ ...s, salesPerSqFt: s.sales / s.sqFt }))
  const mSqFt = median(stores.map((s) => s.sqFt))
  const mSpsf = median(stores.map((s) => s.salesPerSqFt))
  return stores
    .map((s) => {
      const big = s.sqFt >= mSqFt
      const eff = s.salesPerSqFt >= mSpsf
      const quadrant: Quadrant = big ? (eff ? 'big-efficient' : 'big-under') : eff ? 'small-efficient' : 'small-low'
      return { ...s, quadrant }
    })
    .sort((a, b) => a.salesPerSqFt - b.salesPerSqFt)
}

export async function getStoreProfile(store: StoreSelection): Promise<StoreProfile> {
  const storeToken = `[Store Name].${q(store.name)}`
  // Region first (from the click, or looked up), then everything else in parallel.
  const region =
    store.region ??
    String((await searchData(`[Store Name] [Store Region] ${storeToken}`, 5))[0]?.[1] ?? '')
  const regionToken = region ? `[Store Region].${q(region)}` : ''

  const [peers, traffic, txns, categories] = await Promise.all([
    searchData(`[Store Name] [Store Selling Square Footage] [Sales] [Transaction Date].'last 12 months' ${regionToken}`, 1000),
    searchData(`[Foot Traffic] [Transaction Date].'last 30 days' ${storeToken}`, 5),
    searchData(`[Sales] [Number of Transactions] [Transaction Date].'last 30 days' ${storeToken}`, 5),
    searchData(`[Category] [Sales] [Transaction Date].'last 12 months' ${storeToken} sort by [Sales] descending`, 10),
  ])

  const stores = peers
    .map(([name, sqFt, sales]) => ({ name: String(name), sqFt: Number(sqFt) || 0, sales: Number(sales) || 0 }))
    .filter((s) => s.sqFt > 0)
    .map((s) => ({ ...s, spsf: s.sales / s.sqFt }))
    .sort((a, b) => b.spsf - a.spsf)

  const me = stores.find((s) => s.name === store.name) ?? {
    name: store.name,
    sqFt: store.sqFt ?? 0,
    sales: store.sales ?? 0,
    spsf: store.sqFt ? (store.sales ?? 0) / store.sqFt : 0,
  }
  const medianSqFt = median(stores.map((s) => s.sqFt))
  const medianSpsf = median(stores.map((s) => s.spsf))
  const big = me.sqFt >= medianSqFt
  const efficient = me.spsf >= medianSpsf
  const quadrant: Quadrant = big ? (efficient ? 'big-efficient' : 'big-under') : efficient ? 'small-efficient' : 'small-low'

  const catTotal = categories.reduce((n, r) => n + (Number(r[1]) || 0), 0) || 1
  const others = stores.filter((s) => s.name !== store.name)

  return {
    name: store.name,
    region,
    sales12m: me.sales,
    sqFt: me.sqFt,
    salesPerSqFt: me.spsf,
    regionMedianSqFt: medianSqFt,
    regionMedianSalesPerSqFt: medianSpsf,
    regionStores: stores.length,
    rankInRegion: stores.findIndex((s) => s.name === store.name) + 1 || stores.length,
    quadrant,
    opportunity: Math.max(0, (medianSpsf - me.spsf) * me.sqFt),
    footTraffic30d: Number(traffic[0]?.[0]) || 0,
    sales30d: Number(txns[0]?.[0]) || 0,
    transactions30d: Number(txns[0]?.[1]) || 0,
    topCategories: categories.slice(0, 3).map(([name, sales]) => ({
      name: String(name),
      sales: Number(sales) || 0,
      share: (Number(sales) || 0) / catTotal,
    })),
    weakestPeers: others.slice(-3).reverse().map((s) => shortStoreName(s.name)),
    strongestPeers: others.slice(0, 3).map((s) => shortStoreName(s.name)),
  }
}

// ---------------------------------------------------------------------------
// Diagnosis and recommended plays
// ---------------------------------------------------------------------------

export const QUADRANTS: Record<Quadrant, { label: string; tone: 'risk' | 'good' | 'watch'; summary: string }> = {
  'big-under': {
    label: 'Big & underperforming',
    tone: 'risk',
    summary: 'More floor space than most stores in the region, earning less per square foot. Space isn’t paying its way.',
  },
  'small-low': {
    label: 'Small & low yield',
    tone: 'watch',
    summary: 'A compact store that still earns below the region’s median per square foot. Demand, not space, is the constraint.',
  },
  'small-efficient': {
    label: 'Small & efficient',
    tone: 'good',
    summary: 'Out-earns the region per square foot on a smaller footprint. Likely capacity-constrained: protect it and learn from it.',
  },
  'big-efficient': {
    label: 'Big & efficient',
    tone: 'good',
    summary: 'A flagship: large and productive. Keep it in stock and use it as the model for weaker stores.',
  },
}

export type PlayField =
  | { kind: 'date'; key: string; label: string }
  | { kind: 'select'; key: string; label: string; options: string[] }
  | { kind: 'number'; key: string; label: string; prefix?: string; suffix?: string }

export type Play = {
  id: string
  title: string
  why: string
  owner: string
  /** Days from today for the default due date. */
  dueInDays: number
  fields: PlayField[]
  defaults: Record<string, string>
  /** What the simulated workflow does for this play. */
  steps: string[]
}

const fmtMoney = (n: number) => '$' + Math.round(n).toLocaleString('en-US')

export function recommendedPlays(p: StoreProfile): { plays: Play[]; preselected: string[] } {
  const top = p.topCategories[0]?.name ?? 'top category'
  const short = shortStoreName(p.name)
  const visitDays = { kind: 'date', key: 'date', label: 'Visit date' } as const

  const replan: Play = {
    id: 'space-replan',
    title: 'Re-plan the selling floor',
    why: `${fmtMoney(p.opportunity)} a year sits in the gap to the ${p.region} median. Give ${top} (${Math.round((p.topCategories[0]?.share ?? 0) * 100)}% of sales) more of the floor and consolidate low-yield bays.`,
    owner: 'Visual merchandising',
    dueInDays: 21,
    fields: [
      { kind: 'number', key: 'release', label: 'Floor to re-allocate', suffix: '% of space' },
      { kind: 'select', key: 'focus', label: 'Grow', options: p.topCategories.map((c) => c.name) },
    ],
    defaults: { release: '15', focus: top },
    steps: ['Space plan request opened with Visual merchandising', `Planogram review booked for ${short}`],
  }
  const rebalance: Play = {
    id: 'assortment',
    title: 'Rebalance assortment & inventory',
    why: `Shift depth toward ${top} and transfer slow stock to stronger ${p.region} stores (${p.strongestPeers.join(', ')}).`,
    owner: 'Merchandise planning',
    dueInDays: 10,
    fields: [{ kind: 'select', key: 'source', label: 'Transfer slow stock to', options: p.strongestPeers }],
    defaults: { source: p.strongestPeers[0] ?? '' },
    steps: ['Inventory transfer proposal drafted', 'Allocation rules updated for next replenishment cycle'],
  }
  const campaign: Play = {
    id: 'local-campaign',
    title: 'Launch a local demand campaign',
    why: `${Math.round(p.footTraffic30d).toLocaleString('en-US')} visitors in 30 days but only ${p.transactions30d.toLocaleString('en-US')} transactions. Target nearby loyalty members to convert visits into baskets.`,
    owner: 'Marketing',
    dueInDays: 7,
    fields: [
      { kind: 'number', key: 'budget', label: 'Budget', prefix: '$' },
      { kind: 'select', key: 'channel', label: 'Channel', options: ['Email + SMS', 'Email', 'Paid social', 'In-app offer'] },
      { kind: 'number', key: 'radius', label: 'Radius', suffix: 'miles' },
    ],
    defaults: { budget: '2500', channel: 'Email + SMS', radius: '10' },
    steps: ['Campaign brief created in the marketing queue', 'Loyalty audience within the radius saved'],
  }
  const visit: Play = {
    id: 'dm-visit',
    title: 'Schedule a district manager visit',
    why: `Rank ${p.rankInRegion} of ${p.regionStores} in ${p.region} on sales per sq ft. Walk the floor with the store team and agree a 30-day recovery plan.`,
    owner: `${p.region} district manager`,
    dueInDays: 5,
    fields: [visitDays],
    defaults: {},
    steps: ['Store visit added to the district manager’s calendar', 'Visit checklist attached (space, staffing, availability)'],
  }
  const protect: Play = {
    id: 'protect',
    title: 'Protect availability',
    why: `Sells ${p.salesPerSqFt >= p.regionMedianSalesPerSqFt ? Math.round((p.salesPerSqFt / p.regionMedianSalesPerSqFt - 1) * 100) : 0}% above the ${p.region} median per sq ft. Stock-outs here cost more than anywhere else.`,
    owner: 'Supply chain',
    dueInDays: 3,
    fields: [{ kind: 'select', key: 'level', label: 'Replenishment priority', options: ['Tier 1 (daily)', 'Tier 2 (twice weekly)'] }],
    defaults: { level: 'Tier 1 (daily)' },
    steps: ['Replenishment priority raised', 'Safety stock recalculated for top categories'],
  }
  const clone: Play = {
    id: 'clone',
    title: 'Clone the playbook to weaker peers',
    why: `Share what works here with the region’s lowest-yield stores: ${p.weakestPeers.join(', ')}.`,
    owner: 'Retail operations',
    dueInDays: 14,
    fields: [{ kind: 'select', key: 'format', label: 'Format', options: ['Store-to-store visit', 'Recorded walkthrough', 'Peer call'] }],
    defaults: { format: 'Store-to-store visit' },
    steps: ['Best-practice pack requested from the store team', `Sessions offered to ${p.weakestPeers.length} peer stores`],
  }
  const expand: Play = {
    id: 'expansion',
    title: 'Open an expansion study',
    why: `Earns ${fmtMoney(p.salesPerSqFt)} per sq ft on ${Math.round(p.sqFt).toLocaleString('en-US')} sq ft. More space could unlock more sales.`,
    owner: 'Real estate',
    dueInDays: 30,
    fields: [{ kind: 'number', key: 'extra', label: 'Additional space to evaluate', suffix: 'sq ft' }],
    defaults: { extra: String(Math.max(500, Math.round((p.sqFt * 0.2) / 500) * 500)) },
    steps: ['Real estate study request opened', 'Landlord availability check requested'],
  }
  const lease: Play = {
    id: 'lease',
    title: 'Review lease & cost to serve',
    why: `Low yield on a small footprint. Check rent, labour hours and opening times against what this store earns.`,
    owner: 'Finance',
    dueInDays: 30,
    fields: [{ kind: 'select', key: 'scope', label: 'Scope', options: ['Lease + labour', 'Lease only', 'Opening hours'] }],
    defaults: { scope: 'Lease + labour' },
    steps: ['Cost-to-serve review opened with Finance'],
  }

  switch (p.quadrant) {
    case 'big-under':
      return { plays: [replan, rebalance, campaign, visit], preselected: ['space-replan', 'dm-visit', 'local-campaign'] }
    case 'small-low':
      return { plays: [campaign, visit, rebalance, lease], preselected: ['local-campaign', 'dm-visit'] }
    case 'small-efficient':
      return { plays: [protect, expand, clone, rebalance], preselected: ['protect', 'expansion'] }
    case 'big-efficient':
      return { plays: [protect, clone, expand, campaign], preselected: ['protect', 'clone'] }
  }
}
