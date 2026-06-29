import './FilterPill.css'

/**
 * FilterPill — a small chip showing the active drill-down filter on
 * ActionView / WidgetView. Click the × to clear and see all rows again.
 *
 * Props:
 *   label   short uppercase label, e.g. "Session" or "Action"
 *   value   the filter value (truncated with ellipsis if long)
 *   onClear callback to remove the filter
 */
function FilterPill({ label, value, onClear }) {
  return (
    <div className="filter-pill" role="status">
      <span className="filter-pill-label">{label}</span>
      <span className="filter-pill-value" title={String(value)}>{value}</span>
      <button
        type="button"
        className="filter-pill-clear"
        onClick={onClear}
        aria-label="Clear filter"
        title="Clear filter"
      >
        ✕
      </button>
    </div>
  )
}

export default FilterPill
