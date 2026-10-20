import type { FilterUpdate } from './liveboardFilters'
import { RETAIL_MODEL_ID } from './thoughtspot'
import { tsFetch } from './tsApi'

export const REGIONS = ['East', 'Midwest', 'South', 'Southwest', 'West'] as const
export const ALL_REGIONS = 'All regions'
/** A row on the Store Performance tab: one region, or every region unfiltered. */
export type Region = (typeof REGIONS)[number] | typeof ALL_REGIONS

/** The Store KPIs shown on each region row. */
export type RegionKpis = {
  region: Region
  stores: number
  /** Gross profit / sales (0–1). */
  grossMargin: number
  avgStoreSqFt: number
  footTrafficPerStore30d: number
  transactionsPerStore30d: number
  salesPerSqFt: number
}

/** Daily sales over the last 30 days: `days` (epoch seconds, oldest first) and one series per row. */
export type SalesTrend = { days: number[]; byRegion: Record<Region, number[]> }

export type StoreKpis = { regions: RegionKpis[]; all: RegionKpis; trend: SalesTrend }

export const KPI_COLUMNS: {
  key: Exclude<keyof RegionKpis, 'region'>
  label: string
  format: (n: number) => string
  /** Flag the highest and lowest region (higher is better). */
  ranked?: boolean
}[] = [
  { key: 'stores', label: 'Stores', format: (n) => Math.round(n).toLocaleString('en-US') },
  { key: 'grossMargin', label: 'Gross margin', format: (n) => `${(n * 100).toFixed(1)}%`, ranked: true },
  { key: 'avgStoreSqFt', label: 'Avg store size', format: (n) => compact(n) },
  { key: 'footTrafficPerStore30d', label: 'Foot traffic / store · 30d', format: (n) => compact(n), ranked: true },
  { key: 'transactionsPerStore30d', label: 'Txns / store · 30d', format: (n) => Math.round(n).toLocaleString('en-US'), ranked: true },
  { key: 'salesPerSqFt', label: 'Sales / sq ft', format: (n) => `$${n.toFixed(2)}`, ranked: true },
]

function compact(n: number) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(Math.round(n))
}

// ---------------------------------------------------------------------------
// ThoughtSpot Search Data API
// ---------------------------------------------------------------------------

/** The Liveboards' saved date filter, used when the user hasn't changed it. */
const DEFAULT_PERIOD = "[Transaction Date].'last 12 months'"
const LAST_30_DAYS = "[Transaction Date].'last 30 days'"

export type Row = (string | number | null)[]

/**
 * Runs a search query (ThoughtSpot Search Data API) as the signed-in user,
 * through Storeloom's server.
 */
export async function searchData(queryString: string, recordSize = 5000): Promise<Row[]> {
  return (await searchTable(queryString, recordSize)).rows
}

/** Like searchData, with the column names (e.g. "Store Name", "Gross Profit (%)"). */
export async function searchTable(queryString: string, recordSize = 5000): Promise<{ columns: string[]; rows: Row[] }> {
  const res = await tsFetch('/searchdata', {
    method: 'POST',
    body: JSON.stringify({
      query_string: queryString,
      logical_table_identifier: RETAIL_MODEL_ID,
      data_format: 'COMPACT',
      record_size: recordSize,
    }),
  })
  if (!res.ok) throw new Error(`Data request failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  const body = (await res.json()) as { contents: { column_names: string[]; data_rows: Row[] }[] }
  return { columns: body.contents[0]?.column_names ?? [], rows: body.contents[0]?.data_rows ?? [] }
}

const quote = (v: string | number) => `'${String(v).replace(/'/g, "\\'")}'`

/** Search tokens for the global attribute filters (date handled separately). */
function attributeTokens(filters: FilterUpdate[]): string[] {
  return filters.flatMap((f) => {
    if (f.type || !f.values.length) return []
    const col = `[${f.column}]`
    if (f.oper === 'IN' || f.oper === 'EQ') return f.values.map((v) => `${col}.${quote(v)}`)
    if (f.oper === 'NOT_IN' || f.oper === 'NE') return f.values.map((v) => `${col} != ${quote(v)}`)
    console.warn('Store KPIs: filter not applied to the KPI summary', f)
    return []
  })
}

const PERIODS: Record<string, string> = { DAY: 'day', WEEK: 'week', MONTH: 'month', QUARTER: 'quarter', YEAR: 'year' }

/** Search tokens for the global date filter, defaulting to the Liveboards' saved one. */
function periodTokens(filters: FilterUpdate[]): string {
  const f = filters.find((u) => u.type)
  if (!f) return DEFAULT_PERIOD
  const col = `[${f.column}]`
  const period = f.datePeriod ? PERIODS[f.datePeriod] : undefined
  const n = Number(f.values[0])
  switch (f.type) {
    case 'LAST_N_PERIOD':
    case 'NEXT_N_PERIOD':
      if (period) return `${col}.'${f.type === 'LAST_N_PERIOD' ? 'last' : 'next'} ${n} ${period}${n === 1 ? '' : 's'}'`
      break
    case 'THIS_PERIOD':
      if (period) return `${col}.'this ${period}'`
      break
    case 'PERIOD_TO_DATE':
      if (period) return `${col}.'${period} to date'`
      break
    case 'YESTERDAY':
    case 'TODAY':
      return `${col}.${f.type.toLowerCase()}`
    case 'YEAR_ONLY':
      return `${col}.${quote(f.values[0])}`
    // Exact ranges aren't supported: the Search API ignores >= / <= on dates and
    // reads range literals in the viewer's locale, so they'd silently mis-filter.
  }
  console.warn('Store KPIs: date filter not supported, using the default period', f)
  return DEFAULT_PERIOD
}

type StoreFacts = { region: string; sqFt: number; sales: number; grossProfit: number }

function kpisFor(region: Region, stores: StoreFacts[], footTraffic: number[], transactions: number[]): RegionKpis {
  const sellingSqFt = stores.reduce((n, s) => n + s.sqFt, 0)
  const sales = stores.reduce((n, s) => n + s.sales, 0)
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  return {
    region,
    stores: stores.length,
    grossMargin: sales ? stores.reduce((n, s) => n + s.grossProfit, 0) / sales : 0,
    avgStoreSqFt: stores.length ? sellingSqFt / stores.length : 0,
    footTrafficPerStore30d: avg(footTraffic),
    transactionsPerStore30d: avg(transactions),
    salesPerSqFt: sellingSqFt ? sales / sellingSqFt : 0,
  }
}

/**
 * KPI summary per region and for all regions, computed from store-level rows:
 * - stores, gross margin, average store size and sales / sq ft over the selected
 *   period (the Liveboards' "last 12 months" unless changed);
 * - foot traffic and transactions per store over the last 30 days.
 * - daily sales over the last 30 days, for the sparklines.
 * Foot traffic and transactions sit across a chasm trap, so each gets its own query.
 * Store Region is never applied: each row is one region.
 */
export async function getRegionKpis(
  globalFilters: FilterUpdate[],
  onProgress?: (done: number, total: number) => void,
): Promise<StoreKpis> {
  const filters = attributeTokens(globalFilters).join(' ')
  const queries = [
    `[Store Name] [Store Region] [Store Selling Square Footage] [Sales] [Gross Profit ($)] ${periodTokens(globalFilters)} ${filters}`,
    `[Store Name] [Store Region] [Foot Traffic] ${LAST_30_DAYS} ${filters}`,
    `[Store Name] [Store Region] [Number of Transactions] ${LAST_30_DAYS} ${filters}`,
    `[Store Region] [Transaction Date].daily [Sales] ${LAST_30_DAYS} ${filters}`,
  ]
  let done = 0
  onProgress?.(0, queries.length)
  const [facts, traffic, txns, daily] = await Promise.all(
    queries.map((q) =>
      searchData(q).then((rows) => {
        onProgress?.(++done, queries.length)
        return rows
      }),
    ),
  )

  const stores: StoreFacts[] = facts.map(([, region, sqFt, sales, grossProfit]) => ({
    region: String(region),
    sqFt: Number(sqFt) || 0,
    sales: Number(sales) || 0,
    grossProfit: Number(grossProfit) || 0,
  }))
  const byRegion = (rows: Row[], region?: string) =>
    rows.filter((r) => !region || r[1] === region).map((r) => Number(r[2]) || 0)

  return {
    regions: REGIONS.map((region) =>
      kpisFor(
        region,
        stores.filter((s) => s.region === region),
        byRegion(traffic, region),
        byRegion(txns, region),
      ),
    ),
    all: kpisFor(ALL_REGIONS, stores, byRegion(traffic), byRegion(txns)),
    trend: salesTrend(daily),
  }
}

/** Rows of [region, day (epoch seconds), sales] into aligned daily series; missing days count as 0. */
function salesTrend(rows: Row[]): SalesTrend {
  const days = [...new Set(rows.map((r) => Number(r[1])))].sort((a, b) => a - b)
  const index = new Map(days.map((d, i) => [d, i]))
  const series = () => days.map(() => 0)
  const byRegion = Object.fromEntries([ALL_REGIONS, ...REGIONS].map((r) => [r, series()])) as Record<Region, number[]>
  for (const [region, day, sales] of rows) {
    const i = index.get(Number(day))!
    const value = Number(sales) || 0
    byRegion[ALL_REGIONS][i] += value
    if (region && String(region) in byRegion) byRegion[String(region) as Region][i] += value
  }
  return { days, byRegion }
}
