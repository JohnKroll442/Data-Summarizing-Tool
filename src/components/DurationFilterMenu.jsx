import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { DURATION_UNITS, toMs } from '../lib/durationFilter'
import { formatDurationMs } from '../lib/format'
import './MultiFilterMenu.css'
import './DurationFilterMenu.css'

/**
 * DurationFilterMenu — a range filter for a duration column. The user types a
 * minimum and/or a maximum with a shared unit (seconds / minutes); the row's
 * value is kept when it sits strictly between them (min < value < max). Either
 * side may be left blank for an open-ended range. Emits `{ minMs, maxMs }` (with
 * `null` for an open side) while at least one bound is set, or `null` when both
 * are cleared/invalid.
 *
 * This component owns the control state (min / max / unit); the parent owns only
 * the resulting `{ minMs, maxMs }` filter. When the parent clears the filter
 * from outside (e.g. a toolbar "Clear" button), we reset the inputs so the
 * trigger returns to "any".
 *
 * Props:
 *   label:    trigger prefix, e.g. "Total duration"
 *   value:    the active `{ minMs, maxMs }` filter or null
 *   onChange: (nextFilter | null) => void
 */
function DurationFilterMenu({ label = 'Duration', value, onChange }) {
  const [open, setOpen] = useState(false)
  const init = deriveControls(value)
  const [min, setMin] = useState(init.min)
  const [max, setMax] = useState(init.max)
  const [unit, setUnit] = useState(init.unit)
  const rootRef = useRef(null)

  // Sync inputs when the filter is set externally (e.g. a p95 card click sets
  // { minMs: v, maxMs: null } from outside). Also handles clear (value → null).
  useEffect(() => {
    const next = deriveControls(value)
    setMin(next.min)
    setMax(next.max)
    setUnit(next.unit)
  }, [value])

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

  // Any control change rebuilds the range (or clears it when both bounds are
  // blank/invalid) and pushes it up immediately — no separate "Apply" step.
  const apply = (nextMin, nextMax, nextUnit) => {
    setMin(nextMin)
    setMax(nextMax)
    setUnit(nextUnit)
    const minMs = toMs(nextMin, nextUnit)
    const maxMs = toMs(nextMax, nextUnit)
    onChange(minMs === null && maxMs === null ? null : { minMs, maxMs })
  }

  const triggerText = value ? `${label}: ${rangeText(value)}` : `${label}: any`

  return (
    <div className="multi-filter" ref={rootRef}>
      <button
        type="button"
        className={`summary-filter-select multi-filter-trigger${value ? ' has-selection' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="multi-filter-trigger-label">{triggerText}</span>
        <span className="multi-filter-caret" aria-hidden="true"><ChevronDown size={12} /></span>
      </button>

      {open && (
        <div className="multi-filter-panel duration-filter-panel" role="dialog" aria-label={`${label} filter`}>
          <div className="duration-filter-range">
            <input
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              className="duration-filter-amount"
              placeholder="min"
              value={min}
              onChange={(e) => apply(e.target.value, max, unit)}
              aria-label="Minimum duration"
            />
            <span className="duration-filter-sep" aria-hidden="true">&lt; x &lt;</span>
            <input
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              className="duration-filter-amount"
              placeholder="max"
              value={max}
              onChange={(e) => apply(min, e.target.value, unit)}
              aria-label="Maximum duration"
            />
          </div>

          <select
            className="duration-filter-unit"
            value={unit}
            onChange={(e) => apply(min, max, e.target.value)}
            aria-label="Range unit"
          >
            {DURATION_UNITS.map((u) => (
              <option key={u.id} value={u.id}>{u.label}</option>
            ))}
          </select>

          <div className="multi-filter-actions">
            <button
              type="button"
              className="multi-filter-action"
              disabled={!value}
              onClick={() => apply('', '', unit)}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Trigger summary of the active range: "2m – 5m" for a closed range, or the
// one-sided "> 2m" / "< 5m" when only a single bound is set.
function rangeText({ minMs = null, maxMs = null }) {
  if (minMs !== null && maxMs !== null) {
    return `${formatDurationMs(minMs)} – ${formatDurationMs(maxMs)}`
  }
  if (minMs !== null) return `> ${formatDurationMs(minMs)}`
  return `< ${formatDurationMs(maxMs)}`
}

// Seed the input controls from a persisted `{ minMs, maxMs }` filter so the
// panel reflects an active range after the menu remounts (tab switch / drill +
// Back). Picks the coarsest unit that keeps both bounds whole; falls back to
// seconds otherwise. Empty filter → blank inputs, minutes by default.
function deriveControls(value) {
  if (!value) return { min: '', max: '', unit: 'min' }
  const bounds = [value.minMs, value.maxMs].filter((x) => x !== null && x !== undefined)
  const unit = bounds.every((x) => x % 60_000 === 0) ? 'min' : 'sec'
  const div = unit === 'min' ? 60_000 : 1000
  const fmt = (x) => (x === null || x === undefined ? '' : String(x / div))
  return { min: fmt(value.minMs), max: fmt(value.maxMs), unit }
}

export default DurationFilterMenu
