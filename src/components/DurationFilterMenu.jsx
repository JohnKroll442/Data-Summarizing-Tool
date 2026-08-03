import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { DURATION_UNITS, toMs } from '../lib/durationFilter'
import { formatDurationMs } from '../lib/format'
import './MultiFilterMenu.css'
import './DurationFilterMenu.css'

const OPS = [
  { id: 'below', label: 'Below', sign: '<' },
  { id: 'above', label: 'Above', sign: '>' },
]

/**
 * DurationFilterMenu — a threshold filter for a duration column. The user picks
 * a comparator (Below / Above) and types a boundary with a unit (seconds /
 * minutes); the row's value is compared in milliseconds. Emits `{ op, ms }`
 * while a valid boundary is set, or `null` when the amount is cleared/invalid.
 *
 * This component owns the control state (op / amount / unit); the parent owns
 * only the resulting `{ op, ms }` filter. When the parent clears the filter
 * from outside (e.g. a toolbar "Clear" button), we reset the amount so the
 * trigger returns to "any".
 *
 * Props:
 *   label:    trigger prefix, e.g. "Total duration"
 *   value:    the active `{ op, ms }` filter or null
 *   onChange: (nextFilter | null) => void
 */
function DurationFilterMenu({ label = 'Duration', value, onChange }) {
  const [open, setOpen] = useState(false)
  const [op, setOp] = useState(value?.op ?? 'below')
  const [amount, setAmount] = useState('')
  const [unit, setUnit] = useState('min')
  const rootRef = useRef(null)

  // If the parent clears the filter externally, blank the amount so the trigger
  // shows "any" again. (We're the only writer while active, so we don't try to
  // reverse-engineer amount/unit from ms — just reset on clear.)
  useEffect(() => {
    if (!value) setAmount('')
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

  // Any control change rebuilds the filter (or clears it when the amount is
  // blank/invalid) and pushes it up immediately — no separate "Apply" step.
  const apply = (nextOp, nextAmount, nextUnit) => {
    setOp(nextOp)
    setAmount(nextAmount)
    setUnit(nextUnit)
    const ms = toMs(nextAmount, nextUnit)
    onChange(ms === null ? null : { op: nextOp, ms })
  }

  const triggerText = value
    ? `${label}: ${value.op === 'below' ? '<' : '>'} ${formatDurationMs(value.ms)}`
    : `${label}: any`

  return (
    <div className="multi-filter" ref={rootRef}>
      <button
        type="button"
        className={`summary-filter-select multi-filter-trigger${value ? ' has-selection' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {triggerText}
        <span className="multi-filter-caret" aria-hidden="true"><ChevronDown size={12} /></span>
      </button>

      {open && (
        <div className="multi-filter-panel duration-filter-panel" role="dialog" aria-label={`${label} filter`}>
          <div className="duration-filter-ops" role="group" aria-label="Comparator">
            {OPS.map((o) => (
              <button
                key={o.id}
                type="button"
                className={`duration-filter-op${o.id === op ? ' is-active' : ''}`}
                onClick={() => apply(o.id, amount, unit)}
              >
                {o.label}
              </button>
            ))}
          </div>

          <div className="duration-filter-row">
            <input
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              className="duration-filter-amount"
              placeholder="e.g. 2"
              value={amount}
              onChange={(e) => apply(op, e.target.value, unit)}
              aria-label="Boundary amount"
            />
            <select
              className="duration-filter-unit"
              value={unit}
              onChange={(e) => apply(op, amount, e.target.value)}
              aria-label="Boundary unit"
            >
              {DURATION_UNITS.map((u) => (
                <option key={u.id} value={u.id}>{u.label}</option>
              ))}
            </select>
          </div>

          <div className="multi-filter-actions">
            <button
              type="button"
              className="multi-filter-action"
              disabled={!value}
              onClick={() => apply(op, '', unit)}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default DurationFilterMenu
