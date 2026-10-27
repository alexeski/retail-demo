import { useSyncExternalStore } from 'react'

// Demo controls set on the unlinked /config page (see pages/Config.tsx): Shuttle
// question metering, the plan and account rep the upgrade flow shows, and
// hotkey phrases. Kept in this browser's localStorage and synced across tabs, so
// a presenter can adjust them in a hidden tab mid-demo. Nothing here is real:
// "purchases" and "meetings" only change these values.

/** A small persisted store: localStorage-backed, synced across tabs, safe when storage is unavailable. */
export function persistedStore<T extends object>(key: string, defaults: T) {
  const read = (): T => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? { ...defaults, ...(JSON.parse(raw) as Partial<T>) } : defaults
    } catch {
      return defaults
    }
  }
  let state = read()
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((l) => l())

  window.addEventListener('storage', (e) => {
    if (e.key !== key) return
    state = read()
    emit()
  })

  return {
    get: () => state,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
      try {
        localStorage.setItem(key, JSON.stringify(state))
      } catch {
        // Private mode or blocked storage: keep it in memory for this page.
      }
      emit()
    },
    reset() {
      state = defaults
      try {
        localStorage.removeItem(key)
      } catch {
        // ignore
      }
      emit()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function useStore<T extends object>(store: ReturnType<typeof persistedStore<T>>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export type PlanId = 'growth' | 'scale' | 'enterprise'

export type Plan = {
  id: PlanId
  name: string
  /** Shuttle questions per billing month; null = unlimited. */
  questions: number | null
  /** USD per month, billed monthly; null = custom pricing. */
  monthly: number | null
  /** USD per month when billed annually. */
  annualMonthly: number | null
  tagline: string
  features: string[]
}

export const PLANS: Record<PlanId, Plan> = {
  growth: {
    id: 'growth',
    name: 'Growth',
    questions: 500,
    monthly: 499,
    annualMonthly: 399,
    tagline: 'For teams getting started with AI analytics',
    features: ['500 Shuttle questions / month', 'Live store dashboards', '10 editor seats', 'Email support'],
  },
  scale: {
    id: 'scale',
    name: 'Scale',
    questions: 2500,
    monthly: 1490,
    annualMonthly: 1190,
    tagline: 'For multi-region retail operations',
    features: [
      '2,500 Shuttle questions / month',
      'Store action plans & routing',
      'Priority compute for Shuttle',
      '50 editor seats · SSO',
      'Priority support, 4h response',
    ],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    questions: null,
    monthly: null,
    annualMonthly: null,
    tagline: 'For national chains with custom needs',
    features: [
      'Unlimited Shuttle questions',
      'Dedicated compute & data residency',
      'Unlimited seats · SSO & SCIM',
      'Named account team & 99.9% SLA',
    ],
  },
}

export const formatQuestions = (n: number | null) => (n === null ? 'Unlimited' : n.toLocaleString('en-US'))

// ---------------------------------------------------------------------------
// Shuttle usage (metering)
// ---------------------------------------------------------------------------

export type Usage = {
  enabled: boolean
  used: number
  /** Questions in the current plan's monthly allowance. */
  total: number
  plan: PlanId
}

// 494 of 500 used out of the box: the meter shows real usage running low, with a
// few questions left before the upgrade flow. "One left" / "At limit" on /config
// bring it up sooner.
export const USAGE_DEFAULTS: Usage = { enabled: true, used: 494, total: 500, plan: 'growth' }

export const usageStore = persistedStore<Usage>('storeloom.demo.usage', USAGE_DEFAULTS)
export const useUsage = () => useStore(usageStore)

export const limitReached = (u: Usage) => u.enabled && u.used >= u.total

/**
 * Counts one Shuttle question. Returns false (and counts nothing) when the
 * limit is already reached; metering off always allows.
 */
export function consumeQuestion(): boolean {
  const u = usageStore.get()
  if (!u.enabled) return true
  if (u.used >= u.total) return false
  usageStore.set({ used: u.used + 1 })
  return true
}

/** After a (simulated) upgrade: the new plan's allowance applies straight away. */
export function applyPlan(plan: PlanId) {
  const questions = PLANS[plan].questions
  usageStore.set({ plan, total: questions ?? Number.MAX_SAFE_INTEGER })
}

/** First day of next month: when the allowance "renews". */
export function renewalDate(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1)
}

// ---------------------------------------------------------------------------
// Account (who the customer is, who their rep is)
// ---------------------------------------------------------------------------

export type Account = {
  company: string
  repName: string
  repTitle: string
  repEmail: string
}

export const ACCOUNT_DEFAULTS: Account = {
  company: 'Storeloom Retail Group',
  repName: 'Jordan Reyes',
  repTitle: 'Senior Account Executive',
  repEmail: 'jordan.reyes@storeloom.example',
}

export const accountStore = persistedStore<Account>('storeloom.demo.account', ACCOUNT_DEFAULTS)
export const useAccount = () => useStore(accountStore)

// ---------------------------------------------------------------------------
// Hotkeys: a key combo pastes a saved phrase into the focused field
// ---------------------------------------------------------------------------

export type KeyCombo = { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }
export type Hotkey = { id: string; combo: KeyCombo; phrase: string }

export const hotkeyStore = persistedStore<{ hotkeys: Hotkey[] }>('storeloom.demo.hotkeys', { hotkeys: [] })
export const useHotkeys = () => useStore(hotkeyStore).hotkeys

// ---------------------------------------------------------------------------
// Display size
// ---------------------------------------------------------------------------

/** Scale of the whole app, embeds included: `auto` is 80% on laptop widths, 100% above. */
export type DisplayScale = 'auto' | 1 | 0.9 | 0.8 | 0.75

export const DISPLAY_SCALES: { value: DisplayScale; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 1, label: '100%' },
  { value: 0.9, label: '90%' },
  { value: 0.8, label: '80%' },
  { value: 0.75, label: '75%' },
]

export const displayStore = persistedStore<{ scale: DisplayScale }>('storeloom.demo.display', { scale: 'auto' })
export const useDisplay = () => useStore(displayStore)
