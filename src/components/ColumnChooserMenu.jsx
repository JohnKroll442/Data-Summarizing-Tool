import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import './MultiFilterMenu.css'

/**
 * ColumnChooserMenu — a filter-bar dropdown for toggling which columns the
 * table shows. Renders exactly like the other summary-table filter menus
 * (MultiFilterMenu): a `.summary-filter-select` button that opens a checklist.
 * Checked = visible.
 *
 * The table's first ("top") column is always shown and is deliberately NOT
 * passed in here, so it can't be hidden and doesn't clutter the list.
 *
 * Value contract: `hidden` is the array of column keys currently hidden.
 * `onChange(nextHidden)` fires with the new hidden array. Empty = show all.
 *
 * Props:
 *   columns:  Array<{ key, label }> — the toggleable columns (excludes the
 *             always-on first column)
 *   hidden:   string[] — currently-hidden column keys
 *   onChange: (nextHidden: string[]) => void
 */
function ColumnChooserMenu({ columns, hidden, onChange }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  // Close on outside click / Escape so the panel behaves like a proper menu.
  useEffect(() => {
    if (!open) return
    const onDocClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const hiddenSet = useMemo(() => new Set(hidden), [hidden])
  const hiddenCount = columns.reduce((n, c) => (hiddenSet.has(c.key) ? n + 1 : n), 0)

  const toggle = (key) => {
    if (hiddenSet.has(key)) onChange(hidden.filter((k) => k !== key))
    else onChange([...hidden, key])
  }

  const triggerText = hiddenCount === 0 ? 'Columns: all' : `Columns: ${hiddenCount} hidden`

  return (
    <div className="multi-filter" ref={rootRef}>
      <button
        type="button"
        className="summary-filter-select multi-filter-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {triggerText}
        <span className="multi-filter-caret" aria-hidden="true"><ChevronDown size={12} /></span>
      </button>

      {open && (
        <div className="multi-filter-panel" role="listbox">
          <div className="multi-filter-actions">
            <button
              type="button"
              className="multi-filter-action"
              disabled={hiddenCount === 0}
              onClick={() => onChange([])}
            >
              Show all
            </button>
          </div>

          <div className="multi-filter-list">
            {columns.map((col) => (
              <label key={col.key} className="multi-filter-item">
                <input
                  type="checkbox"
                  checked={!hiddenSet.has(col.key)}
                  onChange={() => toggle(col.key)}
                />
                <span>{col.label ?? col.key}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default ColumnChooserMenu
