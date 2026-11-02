import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

/** ThoughtSpot puts dashboard tiles two per row (enable2ColumnLayout) only below this width. */
const TWO_COLUMN_BELOW = 1024

/**
 * ThoughtSpot's charts need about 520px: in a narrower embed (a phone in
 * portrait) they stack in one column but still overflow it, so the dashboard
 * scrolls sideways. Below `min`, lay the content out at `min` wide and zoom it
 * down to fit, the way a browser zoom would.
 *
 * Just above 1024px a dashboard keeps all 12 columns, and its KPI tiles cut
 * their titles and comparisons short until about 1700px. With `twoColumnUntil`, an
 * embed from 1024px up to that width is laid out just under 1024px, so it goes
 * two per row, and zoomed up to fill its space. These are the app's px: below a
 * 1600px window the app is zoomed to 0.8 (displayScale.ts), so a 1366px laptop
 * window gives a dashboard about 1600px.
 *
 * `--embed-zoom` carries the factor for styles inside that size against the
 * window (see StorePerformance.css), and the zoomed layer is `.fit-width` for
 * styles that set its height.
 */
export function FitWidth({
  min = 520,
  twoColumnUntil,
  className,
  children,
}: {
  min?: number
  twoColumnUntil?: number
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
      const width =
        available && available < min
          ? min
          : twoColumnUntil && available >= TWO_COLUMN_BELOW && available < twoColumnUntil
            ? TWO_COLUMN_BELOW - 1
            : null
      setFit(width ? { width, zoom: available / width } : null)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [min, twoColumnUntil])

  const style = fit ? ({ width: fit.width, zoom: fit.zoom, '--embed-zoom': fit.zoom } as CSSProperties) : undefined
  return (
    <div ref={ref} className={className}>
      <div className="fit-width" style={style}>
        {children}
      </div>
    </div>
  )
}
