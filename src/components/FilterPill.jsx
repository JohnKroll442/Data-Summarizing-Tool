import { useState } from 'react'
import { Token, Button } from '@ui5/webcomponents-react'
import './FilterPill.css'

/**
 * FilterPill — a UI5 Token chip showing one active drill-down filter.
 * The Token's built-in × button fires onDelete → calls onClear.
 *
 * Props:
 *   label   short uppercase label, e.g. "Session" or "Action"
 *   value   the filter value
 *   onClear callback to remove the filter
 */
function FilterPill({ label, value, onClear }) {
  return (
    <Token
      text={`${label} · ${value}`}
      title={String(value)}
      onDelete={onClear}
    />
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

        // Under threshold, or explicitly expanded → one Token per value
        if (!overflow || open) {
          const tokens = g.items.map((it) => (
            <Token
              key={it.key ?? `${it.label}:${it.value}`}
              text={`${it.label} · ${it.value}`}
              title={String(it.value)}
              onDelete={it.onClear}
            />
          ))
          if (overflow) {
            tokens.push(
              <Button
                key={`less:${g.label}`}
                design="Transparent"
                onClick={() => toggle(g.label)}
              >
                Show less
              </Button>,
            )
          }
          return tokens
        }

        // Collapsed: one summary Token + a Transparent Button to expand
        const onClearAll = g.items[0]?.onClearAll
        return [
          <Token
            key={`sum:${g.label}`}
            text={`${g.label} · ${g.items.length} selected`}
            title={`${g.items.length} ${g.label} filters active — click × to clear all`}
            onDelete={onClearAll ?? undefined}
          />,
          <Button
            key={`show:${g.label}`}
            design="Transparent"
            onClick={() => toggle(g.label)}
          >
            Show all
          </Button>,
        ]
      })}
    </div>
  )
}

export default FilterPill
