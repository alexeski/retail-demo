import { useEffect, useRef, useState } from 'react'

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3

/**
 * Renders a number that counts from its previous value (0 the first time) to
 * `value`, and flags a refresh-time change so the cell can highlight it.
 */
export function CountUp({
  value,
  format,
  duration = 900,
  delay = 0,
  className,
}: {
  value: number
  format: (n: number) => string
  duration?: number
  delay?: number
  className?: string
}) {
  const [shown, setShown] = useState(reducedMotion() ? value : 0)
  const [changed, setChanged] = useState(false)
  const from = useRef(reducedMotion() ? value : 0)
  /** Set once a value has fully landed, so only later changes count as refreshes. */
  const landed = useRef(reducedMotion())

  useEffect(() => {
    const start = from.current
    const settle = () => {
      from.current = value
      landed.current = true
      setShown(value)
    }
    // Hidden tabs pause animation frames and throttle timers: just show the value.
    if (reducedMotion() || start === value || document.hidden) {
      settle()
      return
    }
    if (landed.current && format(start) !== format(value)) setChanged(true)

    let raf = 0
    let t0: number | undefined
    const tick = (now: number) => {
      t0 ??= now + delay
      const t = Math.min(1, Math.max(0, (now - t0) / duration))
      from.current = start + (value - start) * easeOutCubic(t)
      setShown(from.current)
      if (t < 1) raf = requestAnimationFrame(tick)
      else settle()
    }
    raf = requestAnimationFrame(tick)
    // Animation frames pause in background tabs; make sure the real value lands.
    const fallback = setTimeout(settle, delay + duration + 100)
    const unhighlight = setTimeout(() => setChanged(false), delay + duration + 500)
    const onHide = () => document.hidden && settle()
    document.addEventListener('visibilitychange', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      cancelAnimationFrame(raf)
      clearTimeout(fallback)
      clearTimeout(unhighlight)
    }
  }, [value, duration, delay, format])

  return <span className={[className, changed && 'is-changed'].filter(Boolean).join(' ')}>{format(shown)}</span>
}
