import { X } from 'lucide-react'
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
        <X size={14} />
      </button>
    </div>
  )
}

/**
 * FilterPills — renders a wrapping bar of FilterPill chips, one per active
 * filter value. Used to show every selected session / action / column value
 * as its own removable pill (e.g. filtering two sessions shows two pills).
 *
 * Props:
 *   items  Array<{ key?, label, value, onClear }> — one entry per pill.
 *          Renders nothing when the list is empty.
 */
export function FilterPills({ items }) {
  if (!items || items.length === 0) return null
  return (
    <div className="filter-pill-bar">
      {items.map((it) => (
        <FilterPill
          key={it.key ?? `${it.label}:${it.value}`}
          label={it.label}
          value={it.value}
          onClear={it.onClear}
        />
      ))}
    </div>
  )
}

export default FilterPill
