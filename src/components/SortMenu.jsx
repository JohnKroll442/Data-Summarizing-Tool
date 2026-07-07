import { useEffect, useRef, useState } from 'react'
import './SortMenu.css'

/**
 * SortMenu — gear-triggered popover that mirrors the column-header click
 * sort. Each row lists a column label with two arrow buttons on the right
 * (▲ = ascending, ▼ = descending). The active sort is highlighted, and
 * clicking the active arrow again clears the sort.
 *
 * Props:
 *   columns:      Array<{ key: string, label?: string, sortable?: false }>
 *   sort:         { key: string, dir: 'asc' | 'desc' } | null
 *   onSortChange: (next) => void
 */
function SortMenu({ columns, sort, onSortChange }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

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

  const sortable = columns.filter((c) => c.sortable !== false)

  const pick = (key, dir) => {
    if (sort?.key === key && sort.dir === dir) onSortChange(null)
    else onSortChange({ key, dir })
  }

  return (
    <div className="sort-menu" ref={rootRef}>
      <button
        type="button"
        className="summary-filter-select sort-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Sort table"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sort-menu-gear" aria-hidden="true">⚙</span>
        <span>Sort</span>
        <span className="sort-menu-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="sort-menu-panel" role="menu">
          <div className="sort-menu-header">Sort by</div>
          <div className="sort-menu-list">
            {sortable.map((col) => {
              const label = col.label ?? col.key
              const ascActive = sort?.key === col.key && sort.dir === 'asc'
              const descActive = sort?.key === col.key && sort.dir === 'desc'
              return (
                <div key={col.key} className="sort-menu-row">
                  <span className="sort-menu-label" title={label}>{label}</span>
                  <div className="sort-menu-arrows">
                    <button
                      type="button"
                      className={`sort-menu-arrow${ascActive ? ' is-active' : ''}`}
                      aria-label={`Sort ${label} ascending`}
                      title="Ascending"
                      onClick={() => pick(col.key, 'asc')}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className={`sort-menu-arrow${descActive ? ' is-active' : ''}`}
                      aria-label={`Sort ${label} descending`}
                      title="Descending"
                      onClick={() => pick(col.key, 'desc')}
                    >
                      ▼
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          <button
            type="button"
            className="sort-menu-clear"
            disabled={!sort}
            onClick={() => onSortChange(null)}
          >
            Clear sort
          </button>
        </div>
      )}
    </div>
  )
}

export default SortMenu
