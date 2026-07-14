import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  TIME_GRANULARITIES,
  listConstrainedBuckets,
  pruneSelections,
  timeSelectionCount,
} from '../lib/timeBuckets'
import './MultiFilterMenu.css'
import './TimeFilterMenu.css'

/**
 * TimeFilterMenu — a hierarchical multi-select filter over timestamp buckets.
 *
 * A granularity switch (Month / Week / Day / Hour / Minute) picks which level
 * you're choosing buckets at, but selections at every level PERSIST and
 * compose: a coarser selection constrains the options shown at finer levels
 * (pick "Week of Jun 15" and the Day tab only offers days inside that week),
 * and a row must match every level that has a selection. Options are only ever
 * the buckets present in the uploaded data.
 *
 * Props:
 *   rows:         the (aggregated) rows to derive buckets from
 *   getTimestamp: (row) => raw timestamp value for that row (stable ref)
 *   value:        { month:[], week:[], day:[], hour:[], minute:[] } selections
 *   onChange:     (nextSelections) => void
 */
function TimeFilterMenu({ rows, getTimestamp, value, onChange }) {
  const [open, setOpen] = useState(false)
  const [granularity, setGranularity] = useState('day')
  const [search, setSearch] = useState('')
  const rootRef = useRef(null)
  // Explicit From → To range pickers (bucket keys) for the current level.
  const [rangeFrom, setRangeFrom] = useState('')
  const [rangeTo, setRangeTo] = useState('')

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

  // Options at the current granularity, constrained by any coarser selections.
  const allBuckets = useMemo(
    () => listConstrainedBuckets(rows, getTimestamp, granularity, value),
    [rows, getTimestamp, granularity, value]
  )

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return allBuckets
    return allBuckets.filter((b) => b.label.toLowerCase().includes(needle))
  }, [allBuckets, search])

  const current = value[granularity] ?? []
  const selectedSet = useMemo(() => new Set(value[granularity] ?? []), [value, granularity])

  // Apply a new selection for the current granularity, then prune finer levels
  // so nothing dangles outside the coarser choices.
  const commit = (nextForGranularity) => {
    const next = pruneSelections(rows, getTimestamp, {
      ...value,
      [granularity]: nextForGranularity,
    })
    onChange(next)
  }

  const toggle = (key) => {
    commit(current.includes(key) ? current.filter((k) => k !== key) : [...current, key])
  }

  // Select every bucket in the inclusive From → To span (chronological order).
  const addRange = () => {
    if (!rangeFrom || !rangeTo) return
    const i1 = allBuckets.findIndex((b) => b.key === rangeFrom)
    const i2 = allBuckets.findIndex((b) => b.key === rangeTo)
    if (i1 === -1 || i2 === -1) return
    const [lo, hi] = i1 <= i2 ? [i1, i2] : [i2, i1]
    const span = allBuckets.slice(lo, hi + 1).map((b) => b.key)
    commit(Array.from(new Set([...current, ...span])))
    setRangeFrom('')
    setRangeTo('')
  }

  const totalSelected = timeSelectionCount(value)
  const triggerText = totalSelected === 0 ? 'Time: any' : `Time: ${totalSelected} selected`

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
        <div className="multi-filter-panel time-filter-panel" role="listbox">
          <div className="time-filter-granularity" role="group" aria-label="Time granularity">
            {TIME_GRANULARITIES.map((g) => {
              const count = value[g.id]?.length ?? 0
              return (
                <button
                  key={g.id}
                  type="button"
                  className={`time-filter-gran-btn${g.id === granularity ? ' is-active' : ''}${count > 0 ? ' has-selection' : ''}`}
                  onClick={() => {
                    setGranularity(g.id)
                    setSearch('')
                    setRangeFrom('')
                    setRangeTo('')
                  }}
                >
                  {g.label}{count > 0 ? ` (${count})` : ''}
                </button>
              )
            })}
          </div>

          <input
            type="search"
            className="multi-filter-search"
            placeholder="Search times…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <div className="time-filter-range">
            <span className="time-filter-range-title">Select a range</span>
            <div className="time-filter-range-row">
              <select
                className="time-filter-range-select"
                value={rangeFrom}
                onChange={(e) => setRangeFrom(e.target.value)}
                aria-label="Range start"
              >
                <option value="">From…</option>
                {allBuckets.map((b) => (
                  <option key={b.key} value={b.key}>{b.label}</option>
                ))}
              </select>
              <span className="time-filter-range-arrow" aria-hidden="true">→</span>
              <select
                className="time-filter-range-select"
                value={rangeTo}
                onChange={(e) => setRangeTo(e.target.value)}
                aria-label="Range end"
              >
                <option value="">To…</option>
                {allBuckets.map((b) => (
                  <option key={b.key} value={b.key}>{b.label}</option>
                ))}
              </select>
              <button
                type="button"
                className="time-filter-range-add"
                disabled={!rangeFrom || !rangeTo}
                onClick={addRange}
              >
                Add
              </button>
            </div>
          </div>

          <div className="multi-filter-actions">
            <button
              type="button"
              className="multi-filter-action"
              disabled={filtered.length === 0}
              onClick={() => {
                const merged = Array.from(new Set([...current, ...filtered.map((b) => b.key)]))
                commit(merged)
              }}
            >
              Select {search ? 'matching' : 'all'}
            </button>
            <button
              type="button"
              className="multi-filter-action"
              disabled={current.length === 0}
              onClick={() => commit([])}
            >
              Clear {TIME_GRANULARITIES.find((g) => g.id === granularity)?.label}
            </button>
          </div>

          <div className="multi-filter-list">
            {filtered.length === 0 ? (
              <p className="multi-filter-empty">No timestamps in range.</p>
            ) : filtered.map((b) => (
              <label key={b.key} className="multi-filter-item">
                <input
                  type="checkbox"
                  checked={selectedSet.has(b.key)}
                  onChange={() => toggle(b.key)}
                />
                <span>{b.label}</span>
                <span className="time-filter-count">{b.count}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default TimeFilterMenu
