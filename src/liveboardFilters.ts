import type { LiveboardFilter } from './components/FilterBar'

// The subset of the HostEvent.GetFilters response used here.
type DateFilterValue = {
  type?: string
  op?: string
  datePeriod?: string
  number?: number
  includeCurrentPeriod?: boolean
  monthName?: string
  quarterName?: string
  yearName?: string
  dateRange?: { lowEpoch?: string; highEpoch?: string }
}

type FilterState = {
  filterContent?: { filterType?: string; negate?: boolean; value?: { key: string }[] }[]
  dateFilterContent?: { dateFilter?: DateFilterValue; negate?: boolean }[]
}

export type GetFiltersResult = {
  liveboardFilters?: {
    displayName?: string
    columnInfo?: { name?: string; dataType?: string }
    groupId?: { logicalColumnId?: string }
    filters?: FilterState[]
  }[]
}

/** One entry of the HostEvent.UpdateFilters payload. Date filters take numeric values. */
export type FilterUpdate = {
  column: string
  oper: string
  values: (string | number)[]
  type?: string
  datePeriod?: string
  includeCurrentPeriod?: boolean
}

export const toFilterBarItems = (res: GetFiltersResult): LiveboardFilter[] =>
  (res.liveboardFilters ?? []).flatMap((f) => {
    const columnId = f.groupId?.logicalColumnId
    const column = f.columnInfo?.name
    const label = f.displayName || column
    return columnId && column && label ? [{ columnId, column, label }] : []
  })

const NEGATED: Record<string, string> = { IN: 'NOT_IN', EQ: 'NE' }

function dateUpdate(column: string, d: DateFilterValue): FilterUpdate | null {
  const oper = d.op || 'EQ'
  switch (d.type) {
    case 'LAST_N_PERIOD':
    case 'NEXT_N_PERIOD':
      return { column, oper, type: d.type, datePeriod: d.datePeriod, values: [d.number ?? 1], includeCurrentPeriod: !!d.includeCurrentPeriod }
    case 'THIS_PERIOD':
    case 'PERIOD_TO_DATE':
      return { column, oper, type: d.type, datePeriod: d.datePeriod, values: [''] }
    case 'YESTERDAY':
    case 'TODAY':
    case 'TOMORROW':
      return { column, oper, type: d.type, values: [''] }
    case 'YEAR_ONLY':
      return { column, oper, type: d.type, values: [d.yearName ?? ''] }
    case 'MONTH_YEAR':
      return { column, oper, type: d.type, values: [d.monthName ?? '', d.yearName ?? ''] }
    case 'QUARTER_YEAR':
      return { column, oper, type: d.type, values: [d.quarterName ?? '', d.yearName ?? ''] }
    case 'EXACT_DATE':
      return d.dateRange?.lowEpoch ? { column, oper, type: d.type, values: [Number(d.dateRange.lowEpoch)] } : null
    case 'EXACT_DATE_RANGE':
      return d.dateRange?.lowEpoch && d.dateRange.highEpoch
        ? { column, oper: 'BW_INC', type: d.type, values: [Number(d.dateRange.lowEpoch), Number(d.dateRange.highEpoch)] }
        : null
    default:
      return null
  }
}

/** Converts each Liveboard filter's current state into an UpdateFilters entry. */
function toUpdates(res: GetFiltersResult): Map<string, FilterUpdate> {
  const out = new Map<string, FilterUpdate>()
  for (const f of res.liveboardFilters ?? []) {
    const column = f.columnInfo?.name
    const state = f.filters?.[0]
    if (!column || !state) continue
    const date = state.dateFilterContent?.[0]?.dateFilter
    if (date?.type) {
      const u = dateUpdate(column, date)
      if (u) out.set(column, u)
      continue
    }
    const content = state.filterContent?.[0]
    if (!content) continue
    const values = (content.value ?? []).map((v) => v.key)
    const op = content.filterType || 'IN'
    // A cleared filter reads back as IN [] or EQ []; treat every empty filter alike.
    out.set(column, { column, oper: values.length ? (content.negate ? (NEGATED[op] ?? op) : op) : 'IN', values })
  }
  return out
}

export type FilterBaseline = Map<string, FilterUpdate>

/** Records the Liveboard's saved filter state, to diff later selections against. */
export const snapshotFilters = (res: GetFiltersResult): FilterBaseline => toUpdates(res)

const isSaved = (saved: FilterBaseline, u: FilterUpdate) => JSON.stringify(saved.get(u.column)) === JSON.stringify(u)

/** Filters the user changed relative to the saved state, ready for HostEvent.UpdateFilters. */
export const changedFilters = (res: GetFiltersResult, saved: FilterBaseline): FilterUpdate[] =>
  [...toUpdates(res).values()].filter((u) => !isSaved(saved, u))

/** UpdateFilters entries that put every changed filter back to its saved value. */
export const resetUpdates = (res: GetFiltersResult, saved: FilterBaseline): FilterUpdate[] =>
  changedFilters(res, saved).flatMap((u) => {
    const original = saved.get(u.column)
    return original ? [original] : []
  })

/** True once every update is reflected in the Liveboard's current filter state. */
export const filtersMatch = (res: GetFiltersResult, updates: FilterUpdate[]): boolean => {
  const current = toUpdates(res)
  return updates.every((u) => JSON.stringify(current.get(u.column)) === JSON.stringify(u))
}

export const REGION_COLUMN = 'Store Region'

/** Drops the Store Region filter, which the Store Performance tab sets per row instead. */
export const withoutRegion = (updates: FilterUpdate[]) => updates.filter((u) => u.column !== REGION_COLUMN)

/**
 * Selection read from a region Liveboard: its own changes, plus whatever Store
 * Region choice was carried in from the other tabs (it isn't shown there).
 */
export const mergeRegionSelection = (fromRegionTab: FilterUpdate[], previous: FilterUpdate[]) => [
  ...withoutRegion(fromRegionTab),
  ...previous.filter((u) => u.column === REGION_COLUMN),
]

// ---------------------------------------------------------------------------
// Filters in words, for Shuttle questions asked from a dashboard
// ---------------------------------------------------------------------------

/** Every filter currently restricting the Liveboard (saved or changed); empty ones are skipped. */
export const activeFilters = (res: GetFiltersResult): FilterUpdate[] =>
  [...toUpdates(res).values()].filter((u) => u.type || u.values.length > 0)

const PERIOD_WORDS: Record<string, string> = { DAY: 'day', WEEK: 'week', MONTH: 'month', QUARTER: 'quarter', YEAR: 'year' }
const day = (epochSeconds: number) =>
  new Date(epochSeconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const list = (values: (string | number)[], joiner: string) =>
  values.length <= 2 ? values.join(` ${joiner} `) : `${values.slice(0, -1).join(', ')} ${joiner} ${values.at(-1)}`

/** One filter as a short phrase, e.g. "Store Region is West or East", "Transaction Date in the last 12 months". */
export function describeFilter(u: FilterUpdate): string {
  const period = u.datePeriod ? PERIOD_WORDS[u.datePeriod] ?? u.datePeriod.toLowerCase() : ''
  const n = Number(u.values[0])
  switch (u.type) {
    case 'LAST_N_PERIOD':
      return `${u.column} in the last ${n === 1 ? period : `${n} ${period}s`}`
    case 'NEXT_N_PERIOD':
      return `${u.column} in the next ${n === 1 ? period : `${n} ${period}s`}`
    case 'THIS_PERIOD':
      return `${u.column} in this ${period}`
    case 'PERIOD_TO_DATE':
      return `${u.column} ${period} to date`
    case 'TODAY':
    case 'YESTERDAY':
    case 'TOMORROW':
      return `${u.column} is ${u.type.toLowerCase()}`
    case 'YEAR_ONLY':
      return `${u.column} in ${u.values[0]}`
    case 'MONTH_YEAR':
    case 'QUARTER_YEAR':
      return `${u.column} in ${u.values.filter(Boolean).join(' ')}`
    case 'EXACT_DATE':
      return `${u.column} on ${day(n)}`
    case 'EXACT_DATE_RANGE':
      return `${u.column} between ${day(n)} and ${day(Number(u.values[1]))}`
  }
  if (u.oper === 'NOT_IN' || u.oper === 'NE') return `${u.column} is not ${list(u.values, 'or')}`
  return `${u.column} is ${list(u.values, 'or')}`
}
