import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import {
  FEATURE_ORDER,
  FEATURES,
  planHasFeature,
  planLabel,
  gatingStore,
  useFeatureAccess,
  usageStore,
  type FeatureId,
  type PlanId,
} from '../demoConfig'
import { UpgradeDialog, type UpgradeOutcome } from './UpgradeDialog'
import './Gating.css'

// The upgrade flow for what a pricing plan doesn't include (the question limit
// opens its own, from Shuttle). A locked feature opens it on that feature's
// pricing plan. Mounted once around the signed-in pages, so any of them can ask.

type UpgradeApi = {
  /** Whether the current pricing plan includes the feature. */
  has: (feature: FeatureId) => boolean
  /** Opens the upgrade flow, optionally on the feature that prompted it. */
  open: (feature?: FeatureId) => void
  /** Runs `run` if the feature is included; otherwise opens the upgrade flow on it. */
  require: (feature: FeatureId, run: () => void) => void
}

const UpgradeContext = createContext<UpgradeApi | null>(null)

export function useUpgrade() {
  const ctx = useContext(UpgradeContext)
  if (!ctx) throw new Error('useUpgrade must be used inside <UpgradeProvider>')
  return ctx
}

export function UpgradeProvider({ children }: { children: ReactNode }) {
  const has = useFeatureAccess()
  const [dialog, setDialog] = useState<{ feature?: FeatureId } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  /** The pricing plan when the dialog opened, and the one bought in it (if any). */
  const session = useRef<{ from: PlanId; to?: PlanId }>({ from: 'growth' })

  const open = useCallback((feature?: FeatureId) => {
    session.current = { from: usageStore.get().plan }
    setDialog({ feature })
  }, [])
  // Reads the live plan rather than closing over it, so callers holding an older `require` (memoized handlers) stay right after an upgrade.
  const require = useCallback(
    (feature: FeatureId, run: () => void) => (planHasFeature(usageStore.get().plan, feature, gatingStore.get().enabled) ? run() : open(feature)),
    [open],
  )
  const api = useMemo(() => ({ has, open, require }), [has, open, require])

  const onDone = (o: UpgradeOutcome) => {
    if (o.kind === 'upgrade') session.current.to = o.plan.id
  }
  const onClose = () => {
    setDialog(null)
    const { from, to } = session.current
    if (!to) return
    const unlocked = FEATURE_ORDER.filter((f) => !planHasFeature(from, f) && planHasFeature(to, f)).map((f) => FEATURES[f].name)
    setToast(`You’re on the ${planLabel(to)} now.${unlocked.length ? ` Unlocked: ${unlocked.join(', ')}.` : ''}`)
  }

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 7000)
    return () => clearTimeout(t)
  }, [toast])

  return (
    <UpgradeContext.Provider value={api}>
      {children}
      {dialog && <UpgradeDialog feature={dialog.feature} onClose={onClose} onDone={onDone} />}
      {toast && (
        <div className="gate-toast" role="status">
          <LockIcon open />
          <span>{toast}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
    </UpgradeContext.Provider>
  )
}

export function LockIcon({ open = false }: { open?: boolean }) {
  return (
    <svg className="gate-lock" viewBox="0 0 16 16" width="13" height="13" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d={open ? 'M5.5 7V5a2.5 2.5 0 0 1 4.9-.7' : 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2'} />
    </svg>
  )
}

/**
 * One of Storeloom's own buttons for a ThoughtSpot action. When the pricing plan
 * doesn't include the feature it shows a lock and opens the upgrade flow;
 * otherwise it runs `onUnlocked`. (ThoughtSpot's own disabled buttons can't be clicked.)
 */
export function GatedButton({
  feature,
  onUnlocked,
  disabled,
  title,
  className,
  children,
  ...rest
}: { feature: FeatureId; onUnlocked: () => void } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  const { has, open } = useUpgrade()
  const locked = !has(feature)
  // Which edge the tip lines up with, so it stays inside the window (set when it's about to show).
  const [tipSide, setTipSide] = useState<'left' | 'right'>('left')
  const placeTip = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setTipSide(r.left + r.width / 2 > window.innerWidth / 2 ? 'right' : 'left')
  }
  return (
    <button
      type="button"
      {...rest}
      className={[className, locked && 'is-locked'].filter(Boolean).join(' ')}
      // A locked button is always clickable: it's the way to the upgrade flow.
      disabled={!locked && disabled}
      // A locked button's tip is the instant CSS one below: the browser's own `title` waits about a second.
      title={locked ? undefined : title}
      onClick={() => (locked ? open(feature) : onUnlocked())}
      onPointerEnter={locked ? (e) => placeTip(e.currentTarget) : undefined}
      onFocus={locked ? (e) => placeTip(e.currentTarget) : undefined}
    >
      {locked && <LockIcon />}
      {children}
      {locked && (
        <span className={`gate-tip is-${tipSide}`} role="tooltip">
          <strong>{FEATURES[feature].name}</strong>
          Included in the {planLabel(FEATURES[feature].plan)}. Click to upgrade.
        </span>
      )}
    </button>
  )
}
