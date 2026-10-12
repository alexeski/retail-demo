import { searchData } from './storePerformance'

/** One day's network figures. `date` is the day bucket at UTC midnight. */
export type DayFigures = { date: Date; sales: number; transactions: number }

export type TodayKpis = {
  /** The latest day in the data, presented as "today". */
  today: DayFigures
  /** The same weekday a week earlier. */
  lastWeek: DayFigures
  storesTrading: number
  storesTotal: number
  topStores: { name: string; sales: number }[]
}

/** Date literal the Search API reads as an exact day (month first). */
const dayLiteral = (d: Date) =>
  `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`

/** "Greeley Store #705" → "Greeley #705" */
const shortStoreName = (name: string) => name.replace(/\s+Store\s+(?=#)/, ' ')

/**
 * Today's figures for the Home page. The demo data isn't refreshed on a fixed
 * schedule, so "today" is the latest day in the data rather than the calendar
 * date: the daily totals are read newest first, and the first row is today.
 */
export async function getTodayKpis(onProgress?: (done: number, total: number) => void): Promise<TodayKpis> {
  const total = 3
  let done = 0
  const step = <T,>(p: Promise<T>) =>
    p.then((v) => {
      onProgress?.(++done, total)
      return v
    })
  onProgress?.(0, total)

  const [daily, allStores] = await Promise.all([
    step(searchData('[Transaction Date].daily [Sales] [Number of Transactions] sort by [Transaction Date] descending', 8)),
    step(searchData('[Store Name]', 1000)),
  ])
  if (daily.length === 0) throw new Error('No sales data returned')

  const toDay = (row: (string | number | null)[]): DayFigures => ({
    date: new Date(Number(row[0]) * 1000),
    sales: Number(row[1]) || 0,
    transactions: Number(row[2]) || 0,
  })
  const today = toDay(daily[0])
  const lastWeek = toDay(daily[Math.min(7, daily.length - 1)])

  const stores = await step(searchData(`[Store Name] [Sales] [Transaction Date] = '${dayLiteral(today.date)}'`, 1000))
  const ranked = stores
    .map(([name, sales]) => ({ name: shortStoreName(String(name)), sales: Number(sales) || 0 }))
    .sort((a, b) => b.sales - a.sales)

  return {
    today,
    lastWeek,
    storesTrading: ranked.filter((s) => s.sales > 0).length,
    storesTotal: allStores.length,
    topStores: ranked.slice(0, 6),
  }
}
