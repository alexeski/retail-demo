import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

/**
 * ThoughtSpot's charts need about 520px: in a narrower embed (a phone in
 * portrait) they stack in one column but still overflow it, so the dashboard
 * scrolls sideways. Below `min`, lay the content out at `min` wide and zoom it
 * down to fit, the way a browser zoom would. `--embed-zoom` carries the factor
 * for styles inside that size against the window (see StorePerformance.css),
 * and the zoomed layer is `.fit-width` for styles that set its height.
 */
export function FitWidth({ min = 520, className, children }: { min?: number; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setZoom(el.clientWidth && el.clientWidth < min ? el.clientWidth / min : 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [min])

  const style = zoom < 1 ? ({ width: min, zoom, '--embed-zoom': zoom } as CSSProperties) : undefined
  return (
    <div ref={ref} className={className}>
      <div className="fit-width" style={style}>
        {children}
      </div>
    </div>
  )
}
