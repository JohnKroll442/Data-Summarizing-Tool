import { useState } from 'react'
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

// Past this many values in ONE column, collapse them into a single summary
// chip so a big multi-select (e.g. 76 sessions seeded by a timeline click)
// doesn't flood the bar. A handful of pills — the common case — is unchanged.
const COLLAPSE_AFTER = 6

// Group items by their display label, preserving first-seen order. `label` is
// the column/scope name in every caller, so this yields one group per column.
function groupByLabel(items) {
  const groups = []
  const byLabel = new Map()
  for (const it of items) {
    let g = byLabel.get(it.label)
    if (!g) {
      g = { label: it.label, items: [] }
      byLabel.set(it.label, g)
      groups.push(g)
    }
    g.items.push(it)
  }
  return groups
}

/**
 * FilterPills — renders a wrapping bar of FilterPill chips, one per active
 * filter value. Values from the same column (`label`) are grouped; when a
 * column has more than `collapseAfter` values it collapses into one summary
 * chip ("Session · 76 selected") with a Show all toggle and a clear-all ×,
 * so heavy selections stay compact. Columns at/under the threshold render as
 * individual removable pills exactly as before.
 *
 * Props:
 *   items         Array<{ key?, label, value, onClear, onClearAll? }> — one
 *                 entry per pill. `onClearAll` (optional, same for every item
 *                 in a column) clears that whole column from the summary chip.
 *   collapseAfter number of values in one column before it collapses (6).
 */
export function FilterPills({ items, collapseAfter = COLLAPSE_AFTER }) {
  const [expanded, setExpanded] = useState(() => new Set())
  if (!items || items.length === 0) return null

  const groups = groupByLabel(items)
  const toggle = (label) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })

  return (
    <div className="filter-pill-bar">
      {groups.flatMap((g) => {
        const overflow = g.items.length > collapseAfter
        const open = expanded.has(g.label)

        // Under the threshold, or explicitly expanded → individual pills
        // (with a "Show less" affordance when it was collapsible).
        if (!overflow || open) {
          const pills = g.items.map((it) => (
            <FilterPill
              key={it.key ?? `${it.label}:${it.value}`}
              label={it.label}
              value={it.value}
              onClear={it.onClear}
            />
          ))
          if (overflow) {
            pills.push(
              <button
                key={`less:${g.label}`}
                type="button"
                className="filter-pill-toggle"
                onClick={() => toggle(g.label)}
                aria-expanded
              >
                Show less
              </button>,
            )
          }
          return pills
        }

        // Collapsed summary chip. clear-all comes from the group (never a loop
        // over per-value onClear — those close over the same snapshot and only
        // the last would take effect).
        const onClearAll = g.items[0]?.onClearAll
        return [
          <div className="filter-pill filter-pill-summary" key={`sum:${g.label}`} role="status">
            <span className="filter-pill-label">{g.label}</span>
            <span className="filter-pill-value">{g.items.length} selected</span>
            <button
              type="button"
              className="filter-pill-toggle"
              onClick={() => toggle(g.label)}
              aria-expanded={false}
            >
              Show all
            </button>
            {onClearAll && (
              <button
                type="button"
                className="filter-pill-clear"
                onClick={onClearAll}
                aria-label={`Clear all ${g.label} filters`}
                title={`Clear all ${g.items.length} ${g.label} filters`}
              >
                <X size={14} />
              </button>
            )}
          </div>,
        ]
      })}
    </div>
  )
}

export default FilterPill
