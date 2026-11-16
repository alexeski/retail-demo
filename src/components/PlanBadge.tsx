import { useEffect, useRef, useState } from 'react'
import { FEATURE_ORDER, FEATURES, formatQuestions, PLANS, planLabel, useFeatureAccess, useUsage } from '../demoConfig'
import { LockIcon, useUpgrade } from './UpgradeProvider'

/**
 * The pricing plan, beside the avatar in the top bar: a small tag with a
 * hairline of Shuttle usage along its foot. It opens a compact card with the
 * usage, what the plan leaves locked (each row opens the upgrade flow on that
 * feature) and a way to compare plans. A quiet place for the upsell, instead of
 * a button on every page.
 */
export function PlanBadge() {
  const usage = useUsage()
  const plan = PLANS[usage.plan]
  const has = useFeatureAccess()
  const { open } = useUpgrade()
  const [shown, setShown] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!shown) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setShown(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [shown])

  const locked = FEATURE_ORDER.filter((f) => !has(f))
  const metered = usage.enabled && plan.questions !== null
  const pct = metered ? Math.min(100, (usage.used / Math.max(1, usage.total)) * 100) : 0
  const act = (fn: () => void) => () => {
    setShown(false)
    fn()
  }

  return (
    <div className="plan" ref={ref}>
      <button type="button" className="plan-tag" aria-haspopup="dialog" aria-expanded={shown} onClick={() => setShown((s) => !s)}>
        {locked.length > 0 && <LockIcon />}
        {plan.name}
        {metered && <span className={pct >= 100 ? 'plan-meter is-full' : 'plan-meter'} style={{ width: `${pct}%` }} aria-hidden />}
      </button>

      {shown && (
        <div className="plan-card" role="dialog" aria-label="Your pricing plan">
          <div className="plan-card-head">
            <span className="mono-label">Your pricing plan</span>
            <strong>{planLabel(plan)}</strong>
          </div>

          {metered && (
            <div className="plan-usage">
              <div className="plan-usage-bar" aria-hidden>
                <span className={pct >= 100 ? 'is-full' : ''} style={{ width: `${pct}%` }} />
              </div>
              <span>
                <strong>{usage.used.toLocaleString('en-US')}</strong> of {formatQuestions(plan.questions)} Shuttle questions this month
              </span>
            </div>
          )}

          {locked.length > 0 ? (
            <>
              <span className="mono-label plan-sub">Not in your plan</span>
              <ul className="plan-locked">
                {locked.map((f) => (
                  <li key={f}>
                    <button type="button" onClick={act(() => open(f))}>
                      <LockIcon />
                      <span>{FEATURES[f].name}</span>
                      <em>{PLANS[FEATURES[f].plan].name} +</em>
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="plan-compare" onClick={act(() => open())}>
                Compare pricing plans →
              </button>
            </>
          ) : (
            <p className="plan-all">Everything in Storeloom is included in your pricing plan.</p>
          )}
        </div>
      )}
    </div>
  )
}
