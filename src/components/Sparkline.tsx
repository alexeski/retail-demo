import { useState, type MouseEvent } from 'react'

const W = 120
const H = 32
const PAD = 4

const dayLabel = (epochSeconds: number) =>
  new Date(epochSeconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/**
 * Daily trend as a line, scaled to its own min–max (each row has a different
 * magnitude, so it reads as shape, not size). Hover shows the day and value.
 */
export function Sparkline({
  values,
  days,
  format,
  label,
  delay = 0,
}: {
  values: number[]
  /** Epoch seconds per value, oldest first. */
  days: number[]
  format: (n: number) => string
  /** What the series is, for the accessible summary. */
  label: string
  delay?: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  if (values.length < 2) return <span className="sparkline is-empty">—</span>

  const min = Math.min(...values)
  const max = Math.max(...values)
  const x = (i: number) => PAD + (i / (values.length - 1)) * (W - 2 * PAD)
  const y = (v: number) => (max === min ? H / 2 : PAD + (1 - (v - min) / (max - min)) * (H - 2 * PAD))
  const path = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
  const last = values.length - 1
  const shown = hover ?? last

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const i = Math.round((((e.clientX - box.left) / box.width) * W - PAD) / ((W - 2 * PAD) / last))
    setHover(Math.max(0, Math.min(last, i)))
  }

  const summary =
    `${label}: daily sales over the last ${values.length} days, ` +
    `from ${format(values[0])} to ${format(values[last])}, peak ${format(max)}`

  return (
    <span className="sparkline">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={summary}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <path className="sparkline-line" d={path} pathLength={1} style={{ animationDelay: `${delay}ms` }} />
        {hover !== null && <line className="sparkline-rule" x1={x(hover)} x2={x(hover)} y1={0} y2={H} />}
        <circle
          className="sparkline-dot"
          cx={x(shown)}
          cy={y(values[shown])}
          r={3}
          style={{ animationDelay: `${delay}ms` }}
        />
      </svg>
      {hover !== null && (
        <span className="sparkline-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          {dayLabel(days[hover])} · <strong>{format(values[hover])}</strong>
        </span>
      )}
    </span>
  )
}
