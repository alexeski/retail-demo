import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

/**
 * ThoughtSpot's charts need about 520px: in a narrower embed (a phone in
 * portrait) they stack in one column but still overflow it, so the dashboard
 * scrolls sideways. Below `min`, lay the content out at `min` wide and zoom it
 * down to fit, the way a browser zoom would.
 *
 * `--embed-zoom` carries the factor for styles inside that size against the
 * window (see StorePerformance.css), and the zoomed layer is `.fit-width` for
 * styles that set its height.
 */
export function FitWidth({
  min = 520,
  className,
  children,
}: {
  min?: number
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  // The width the content is laid out at and the zoom that fits it; null when no zoom is needed.
  const [fit, setFit] = useState<{ width: number; zoom: number } | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const available = el.clientWidth
      setFit(available && available < min ? { width: min, zoom: available / min } : null)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [min])

  const style = fit ? ({ width: fit.width, zoom: fit.zoom, '--embed-zoom': fit.zoom } as CSSProperties) : undefined
  return (
    <div ref={ref} className={className}>
      <div className="fit-width" style={style}>
        {children}
      </div>
    </div>
  )
}
