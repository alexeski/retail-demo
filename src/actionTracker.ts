import { persistedStore, useStore } from './demoConfig'

// Action plans launched from the store action panel, tracked on the Home page so
// the loop closes: what was decided, who owns each play, and where it stands.
// Kept for the signed-in session only: signing in or out starts a fresh demo
// (see auth.tsx). Owners' progress is simulated.

export type PlayStatus = 'assigned' | 'in-progress' | 'done'

export type TrackedPlay = {
  id: string
  title: string
  owner: string
  /** ISO date (yyyy-mm-dd). */
  due: string
  /** Set once someone changes it on the Home page; otherwise simulated (see playStatus). */
  status?: PlayStatus
}

export type TrackedPlan = {
  ticket: string
  store: string
  region: string
  /** Quadrant label, e.g. "Big & underperforming". */
  profile: string
  priority: string
  requestedBy: string
  launchedAt: number
  plays: TrackedPlay[]
  /** Where the plan was announced, e.g. "#west-store-ops", "email". */
  channels: string[]
  /** Annual sales to the region's median sales per sq ft (0 if already above). */
  opportunity: number
  /** ISO date of the 30-day re-measure. */
  recheckOn: string
}

/** The first play's owner "picks it up" this long after launch. */
const PICKUP_MS = 45_000

export const actionTracker = persistedStore<{ plans: TrackedPlan[] }>('storeloom.demo.actions', { plans: [] })
export const useTrackedPlans = () => useStore(actionTracker).plans

export function trackPlan(plan: TrackedPlan) {
  actionTracker.set((s) => ({ plans: [plan, ...s.plans.filter((p) => p.ticket !== plan.ticket)] }))
}

export function playStatus(plan: TrackedPlan, index: number, now = Date.now()): PlayStatus {
  const play = plan.plays[index]
  if (play.status) return play.status
  return index === 0 && now - plan.launchedAt >= PICKUP_MS ? 'in-progress' : 'assigned'
}

export function planStatus(plan: TrackedPlan, now = Date.now()): PlayStatus {
  const all = plan.plays.map((_, i) => playStatus(plan, i, now))
  if (all.every((s) => s === 'done')) return 'done'
  return all.some((s) => s !== 'assigned') ? 'in-progress' : 'assigned'
}

const NEXT: Record<PlayStatus, PlayStatus> = { assigned: 'in-progress', 'in-progress': 'done', done: 'assigned' }

/** Moves a play to its next status (assigned → in progress → done → assigned). */
export function advancePlay(ticket: string, index: number) {
  actionTracker.set((s) => ({
    plans: s.plans.map((p) =>
      p.ticket !== ticket
        ? p
        : { ...p, plays: p.plays.map((play, i) => (i === index ? { ...play, status: NEXT[playStatus(p, i)] } : play)) },
    ),
  }))
}

/** True while a simulated pickup is still to come, so the page knows to keep its clock ticking. */
export const pickupPending = (plans: TrackedPlan[], now = Date.now()) =>
  plans.some((p) => !p.plays[0]?.status && now - p.launchedAt < PICKUP_MS)
