import type { Turn } from './spotter'
import { searchData, searchTable } from './storePerformance'
import { shortStoreName, type StoreSelection } from './storeActions'

// Stores a Shuttle answer points at, so the conversation can turn into an action
// plan. Spotter answers vary (a chart, a table, prose, several of each), so leads
// come from two independent sources and are checked against the real store list:
// 1. structured: each answer's own search (sage_query), re-run through the Search
//    Data API when it lists stores, which gives exact names, regions and figures;
// 2. text: store mentions anywhere in the written answer ("Portland Store #508",
//    "Portland #508", "store #508"), resolved by store number.

export type LeadMetric = { label: string; text: string }
export type StoreLead = {
  name: string
  region?: string
  metrics: LeadMetric[]
  /** What surfaced it: the answer's title, or the question for a text mention. */
  source?: string
}
export type StoreLeads = {
  leads: StoreLead[]
  /** The answer is about weak performance (bottom N, declines…): offer action up front. */
  attention: boolean
}

/** A table with more stores than this is a listing, not a set of recommendations. */
const MAX_TABLE_STORES = 25
const MAX_LEADS = 10

const ATTENTION =
  /\b(least|lowest|bottom|worst|weak|poor(ly)?|under-?perform\w*|declin\w*|drop\w*|fall\w*|los(s|ses|ing)|negative|risk\w*|struggl\w*|issues?|problems?|below|lag\w*|decreas\w*|slow\w*|miss\w*)\b/i

// ---------------------------------------------------------------------------
// Store catalog (every store and its region), loaded once
// ---------------------------------------------------------------------------

type CatalogStore = { name: string; region: string; number: string; city: string }
let catalog: Promise<CatalogStore[]> | null = null

export function getStoreCatalog(): Promise<CatalogStore[]> {
  catalog ??= searchData('[Store Name] [Store Region]', 2000)
    .then((rows) =>
      rows.map(([name, region]) => {
        const n = String(name)
        return {
          name: n,
          region: String(region),
          number: n.match(/#\s*(\d+)/)?.[1] ?? '',
          city: n.replace(/\s*(Store\s*)?#\s*\d+.*$/i, '').trim(),
        }
      }),
    )
    .catch((err) => {
      catalog = null // retry next time
      throw err
    })
  return catalog
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim()

/** Store mentions in free text, in order of appearance, resolved against the catalog. */
function storesInText(text: string, stores: CatalogStore[]): CatalogStore[] {
  const byNumber = new Map(stores.map((s) => [s.number, s]))
  const found: CatalogStore[] = []
  // "<City> Store #508", "<City> #508", "Store #508", "#508"
  // Case-sensitive on purpose: a city is capitalised, so "for store #508" reads as no city.
  const re = /(?:([A-Z][\w.'’-]*(?:[ \t]+[A-Z][\w.'’-]*){0,3})[ \t]+)?(?:[Ss]tore[ \t]*)?#[ \t]?(\d{1,4})\b/g
  for (const m of text.matchAll(re)) {
    const store = byNumber.get(m[2])
    if (!store) continue
    // A city in front must agree with the store's (guards against "#3" style list markers).
    const city = m[1] ? norm(m[1].replace(/\bstore$/i, '')) : ''
    if (city && !norm(store.city).endsWith(city.split(' ').slice(-1)[0])) continue
    if (!found.includes(store)) found.push(store)
  }
  return found
}

// ---------------------------------------------------------------------------
// Structured: re-run the answer's search
// ---------------------------------------------------------------------------

function formatMetric(column: string, value: number): string {
  if (/\(%\)|margin|percent|rate|share/i.test(column) && Math.abs(value) <= 1.5) return `${(value * 100).toFixed(1)}%`
  if (/\(\$\)|sales|profit|revenue|cost|ticket|spend|rent|\$/i.test(column)) {
    const a = Math.abs(value)
    const sign = value < 0 ? '-' : ''
    return a >= 1e6 ? `${sign}$${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `${sign}$${(a / 1e3).toFixed(1)}K` : `${sign}$${Math.round(a).toLocaleString('en-US')}`
  }
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

const shortLabel = (column: string) =>
  /gross profit \(%\)|margin/i.test(column)
    ? 'Margin'
    : column.replace(/^(Total|Average|Sum of|Avg)\s+/i, '').replace(/\s*\((\$|%)\)/, (_, u) => (u === '%' ? ' %' : ''))

async function storesFromAnswers(turn: Turn): Promise<StoreLead[]> {
  // One search per distinct query, keeping the answer's title as the reason.
  const queries = new Map<string, string | undefined>()
  for (const a of [...turn.answers, ...turn.steps.flatMap((s) => (s.answer ? [s.answer] : []))]) {
    const q = a.sage_query?.trim()
    if (q && /\[store name\]/i.test(q) && !queries.has(q)) queries.set(q, a.title)
  }
  const tables = await Promise.all(
    [...queries].map(([q, title]) =>
      searchTable(q, MAX_TABLE_STORES + 1)
        .then((t) => ({ ...t, title }))
        .catch((err) => {
          console.warn('Shuttle: could not re-run answer search', q, err)
          return null
        }),
    ),
  )
  const leads: StoreLead[] = []
  for (const table of tables) {
    if (!table) continue
    const nameCol = table.columns.findIndex((c) => /store name/i.test(c))
    if (nameCol < 0 || table.rows.length > MAX_TABLE_STORES) continue
    const regionCol = table.columns.findIndex((c) => /store region/i.test(c))
    for (const row of table.rows) {
      const name = String(row[nameCol] ?? '')
      if (!name || leads.some((l) => l.name === name)) continue
      const metrics = table.columns.flatMap((col, i) =>
        typeof row[i] === 'number' && i !== nameCol ? [{ label: shortLabel(col), text: formatMetric(col, row[i] as number) }] : [],
      )
      leads.push({
        name,
        region: regionCol >= 0 ? String(row[regionCol]) : undefined,
        metrics: metrics.slice(0, 2),
        source: table.title?.replace(/^show\s+/i, ''),
      })
    }
  }
  return leads
}

/** Finds the stores a finished turn talks about. Never throws: no leads on failure. */
export async function findStoreLeads(turn: Turn): Promise<StoreLeads> {
  const [structured, mentioned] = await Promise.all([
    storesFromAnswers(turn).catch(() => [] as StoreLead[]),
    /#\s?\d/.test(turn.text)
      ? getStoreCatalog()
          .then((stores) => storesInText(turn.text, stores))
          .catch(() => [] as CatalogStore[])
      : Promise.resolve([] as CatalogStore[]),
  ])
  const leads = [...structured]
  for (const s of mentioned) {
    const known = leads.find((l) => l.name === s.name)
    if (known) known.region ??= s.region
    else leads.push({ name: s.name, region: s.region, metrics: [], source: turn.question })
  }
  const sageQueries = turn.answers.map((a) => a.sage_query ?? '').join(' ')
  return {
    leads: leads.slice(0, MAX_LEADS),
    attention: ATTENTION.test(turn.question) || ATTENTION.test(turn.text) || /\bbottom\b|ascending/i.test(sageQueries),
  }
}

// ---------------------------------------------------------------------------
// Replies: "the 2nd one", "Portland", "#508", "act on Toledo #766"
// ---------------------------------------------------------------------------

const ACTION = /\b(act|action|plan|fix|go with|pick|choose|select|open|start|launch|let'?s)\b/i
// Ordinals only: cardinal words ("one", "two") show up in ordinary questions.
const ORDINALS: Record<string, number> = {
  first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5,
  sixth: 6, '6th': 6, seventh: 7, '7th': 7, eighth: 8, '8th': 8, ninth: 9, '9th': 9, tenth: 10, '10th': 10,
}

const cityOf = (name: string) => name.replace(/\s*(Store\s*)?#\s*\d+.*$/i, '').trim()
const numberOf = (name: string) => name.match(/#\s*(\d+)/)?.[1]

function pickFromLeads(text: string, leads: StoreLead[]): StoreLead | null {
  const t = ` ${norm(text)} `
  const hits = new Set<StoreLead>()
  for (const l of leads) {
    const num = numberOf(l.name)
    if (num && new RegExp(`(#|\\s)${num}\\s`).test(t)) hits.add(l)
    else if (t.includes(` ${norm(cityOf(l.name))} `)) hits.add(l)
  }
  if (hits.size === 1) return [...hits][0]
  if (hits.size > 1) return null
  // Positions: "the 2nd one", "number 3", "3", "the last one"
  if (/\blast (one|store)\b|^\s*(the )?last\s*$/.test(t)) return leads[leads.length - 1] ?? null
  const word = t.split(' ').find((w) => w in ORDINALS)
  const pos = word ? ORDINALS[word] : Number(t.match(/^\s*(?:no |number )?(\d{1,2})\s*$/)?.[1] ?? t.match(/\bnumber (\d{1,2})\b/)?.[1])
  return pos >= 1 && pos <= leads.length ? leads[pos - 1] : null
}

/**
 * The store a chat reply asks to act on, or null to send the reply to Shuttle as
 * a normal question. Short replies ("Portland", "the 2nd one") or replies with
 * an action word ("act on Portland") pick from the latest leads; an action
 * reply can also name any other store ("plan an action for Toledo #766").
 */
export async function storeFromReply(text: string, leads: StoreLead[]): Promise<StoreSelection | null> {
  const wantsAction = ACTION.test(text)
  // A short reply picks a store ("Portland", "the 2nd one"); a short question is still a question.
  const short = text.trim().split(/\s+/).length <= 5 && !text.includes('?')
  if (!wantsAction && !short) return null
  const lead = leads.length ? pickFromLeads(text, leads) : null
  if (lead) return leadSelection(lead)
  if (!wantsAction || !/#\s?\d/.test(text)) return null
  const [store] = storesInText(text, await getStoreCatalog().catch(() => []))
  return store ? { name: store.name, region: store.region } : null
}

/** The store to open an action plan for, with why Shuttle surfaced it. */
export const leadSelection = (l: StoreLead): StoreSelection => ({
  name: l.name,
  region: l.region,
  reason: [
    l.source && `Surfaced by Shuttle: ${l.source.replace(/^\w/, (c) => c.toUpperCase())}`,
    l.metrics.map((m) => `${m.label} ${m.text}`).join(' · '),
  ]
    .filter(Boolean)
    .join('. '),
})

export const leadLabel = (l: { name: string; region?: string }) =>
  `${shortStoreName(l.name)}${l.region ? ` · ${l.region}` : ''}`
