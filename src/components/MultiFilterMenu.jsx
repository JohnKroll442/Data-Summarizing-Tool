import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import './MultiFilterMenu.css'

/**
 * MultiFilterMenu — a compact popup checklist used in summary-table filter
 * bars for columns with many options (e.g. widget IDs). Renders as a single
 * button matching `.summary-filter-select`; clicking opens a floating panel
 * with a search box and a scrollable checkbox list.
 *
 * Value contract: `selected` is an array of strings. `onChange(next)` fires
 * with the new array. An empty array means "no filter applied" (matches all).
 *
 * Props:
 *   label:    string shown on the trigger button (e.g. "Widget ID")
 *   options:  string[] of choices (already sorted by the caller)
 *   selected: string[] currently-selected values
 *   onChange: (next: string[]) => void
 */
function MultiFilterMenu({ label, options, selected, onChange, showSelectAll = true }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef(null)
  // When "Select all" balloons the selection, the pill bar above the table and
  // the surrounding re-render shift the layout, which makes the browser jump
  // the page (keeping the focused search input in view). Stash the scroll
  // position on that click and restore it after the commit so nothing moves.
  const restoreScrollRef = useRef(null)

  useLayoutEffect(() => {
    if (!restoreScrollRef.current) return
    const { x, y } = restoreScrollRef.current
    restoreScrollRef.current = null
    window.scrollTo(x, y)
  })

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

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return options
    return options.filter((o) => o.toLowerCase().startsWith(needle))
  }, [options, search])

  const selectedSet = useMemo(() => new Set(selected), [selected])

  const toggle = (value) => {
    if (selectedSet.has(value)) onChange(selected.filter((v) => v !== value))
    else onChange([...selected, value])
  }

  const triggerText = selected.length === 0
    ? `${label}: any`
    : `${label}: ${selected.length} selected`

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
          <input
            type="search"
            className="multi-filter-search"
            placeholder={`Search ${label.toLowerCase()}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />

          <div className="multi-filter-actions">
            {showSelectAll && (
              <button
                type="button"
                className="multi-filter-action"
                disabled={filtered.length === 0}
                onClick={() => {
                  restoreScrollRef.current = { x: window.scrollX, y: window.scrollY }
                  const merged = Array.from(new Set([...selected, ...filtered]))
                  onChange(merged)
                }}
              >
                Select {search ? 'matching' : 'all'}
              </button>
            )}
            <button
              type="button"
              className="multi-filter-action"
              disabled={selected.length === 0}
              onClick={() => onChange([])}
            >
              Clear
            </button>
          </div>

          <div className="multi-filter-list">
            {filtered.length === 0 ? (
              <p className="multi-filter-empty">No matches.</p>
            ) : filtered.map((opt) => (
              <label key={opt} className="multi-filter-item">
                <input
                  type="checkbox"
                  checked={selectedSet.has(opt)}
                  onChange={() => toggle(opt)}
                />
                <span>{opt}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default MultiFilterMenu
