export type LiveboardFilter = { columnId: string; column: string; label: string }

type Props = {
  filters: LiveboardFilter[]
  /** False while the Liveboard is loading or a placeholder tab is shown. */
  enabled: boolean
  onOpen: (filter: LiveboardFilter) => void
  /** Filters that differ from the Liveboard's saved defaults. */
  changedCount: number
  resetting: boolean
  onReset: () => void
  /** Filters shown but not editable here, with the reason as a tooltip. */
  locked?: { column: string; reason: string }
}

// Captions only: values are picked in ThoughtSpot's native filter modal.
export function FilterBar({ filters, enabled, onOpen, changedCount, resetting, onReset, locked }: Props) {
  return (
    <section className="filterbar">
      <span className="filterbar-label">
        <span>Filters</span>
        <span className="filterbar-scope">All tabs</span>
      </span>
      <div className="filterbar-list">
        {filters.map((f) => {
          const isLocked = locked?.column === f.column
          return (
            <button
              key={f.columnId}
              type="button"
              className="filter-btn"
              disabled={!enabled || isLocked}
              title={isLocked ? locked.reason : undefined}
              onClick={() => onOpen(f)}
            >
              {f.label}
            </button>
          )
        })}
        {filters.length === 0 && <span className="filterbar-empty">Loading filters…</span>}
      </div>
      {(changedCount > 0 || resetting) && (
        <button type="button" className="filterbar-reset" onClick={onReset} disabled={resetting} title="Reset all filters to the dashboard's defaults">
          {resetting ? 'Resetting…' : `Reset · ${changedCount}`}
        </button>
      )}
    </section>
  )
}
