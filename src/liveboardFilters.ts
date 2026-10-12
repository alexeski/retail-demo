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
