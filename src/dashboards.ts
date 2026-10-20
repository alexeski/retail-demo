import { SIGNED_OUT_EVENT } from './tsApi'

// The signed-in user's own dashboards (Liveboards they created and own), through
// Storeloom's server (server/dashboards.ts), which checks ownership on every call.

export type Dashboard = {
  id: string
  name: string
  description: string
  created: number | null
  modified: number | null
  /** Number of charts and tables on it. */
  tiles: number
  /** Its charts and tables, in the dashboard's order. */
  charts: { id: string; name: string; created: number | null }[]
}

export class DashboardError extends Error {
  status: number
  code: string

  constructor(status: number, code: string) {
    super(
      code === 'not-a-chart'
        ? 'That tile is a Shuttle insight, not a Search chart: edit it with Shuttle instead.'
        : status === 404
        ? 'That dashboard doesn’t exist, or it isn’t yours.'
        : status === 403
          ? 'Your account isn’t allowed to do that.'
          : code === 'cluster-idle'
            ? 'Analytics is waking up. Try again in a minute.'
            : 'Analytics didn’t answer. Try again.',
    )
    this.status = status
    this.code = code
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/dashboards${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  })
  if (res.status === 401) window.dispatchEvent(new Event(SIGNED_OUT_EVENT))
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new DashboardError(res.status, body.error ?? 'unavailable')
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

export const listDashboards = () => call<{ dashboards: Dashboard[] }>('').then((r) => r.dashboards)

export const getDashboard = (id: string) => call<{ dashboard: Dashboard }>(`/${id}`).then((r) => r.dashboard)

export const deleteDashboard = (id: string) => call<void>(`/${id}`, { method: 'DELETE' })

export const renameDashboard = (id: string, name: string) =>
  call<{ dashboard: Dashboard }>(`/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }).then((r) => r.dashboard)

/** Takes a chart off the dashboard. */
export const removeTile = (id: string, vizId: string) => call<void>(`/${id}/tiles/${vizId}`, { method: 'DELETE' })

/** Copies a tile into a draft Answer that Search can open for editing. */
export const openDraft = (id: string, vizId: string) => call<{ answerId: string; title: string }>(`/${id}/tiles/${vizId}/draft`, { method: 'POST' })

/** Deletes a draft once editing ends; `keepalive` lets it finish as the page unloads. */
export const deleteDraft = (answerId: string, keepalive = false) =>
  fetch(`/api/dashboards/drafts/${answerId}`, { method: 'DELETE', keepalive }).catch(() => {})

/** Re-points a pinned tile at `answer` (Search's current TML), in place. */
export const replaceTile = (id: string, vizId: string, answer: unknown, title: string) =>
  call<void>(`/${id}/tiles/${vizId}`, { method: 'POST', body: JSON.stringify({ answer, title }) })

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000

/** "Edited 3 min ago", "Edited yesterday", "Edited 12 Oct 2026". */
export function formatEdited(ms: number | null, now = Date.now()) {
  if (!ms) return 'Never edited'
  const diff = now - ms
  if (diff < 60_000) return 'Edited just now'
  if (diff < 60 * 60_000) return `Edited ${Math.round(diff / 60_000)} min ago`
  if (diff < DAY && new Date(ms).getDate() === new Date(now).getDate()) return `Edited ${Math.round(diff / (60 * 60_000))} h ago`
  if (diff < 2 * DAY) return 'Edited yesterday'
  return `Edited ${new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
}

export const tileCount = (n: number) => (n === 1 ? '1 chart' : `${n} charts`)

/**
 * A chart title from Search's query: "[Sales] [Store Region] [Date].monthly" →
 * "Sales by Store Region, Date". Only a starting point; the user can retitle it.
 */
export function titleFromQuery(query: string) {
  const tokens = [...query.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!.trim()).filter(Boolean)
  const unique = [...new Set(tokens)].map((t) => t.replace(/\b\w/g, (c) => c.toUpperCase()))
  if (!unique.length) return ''
  const [first, ...rest] = unique
  return rest.length ? `${first} by ${rest.join(', ')}` : first!
}
