import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import { buildActionSequenceOption } from './charts/options/actionSequence'
import { applyActionFilter } from '../lib/drillDown'
import './ActionWaterfallModal.css'

/**
 * ActionWaterfallModal — a bigger, action-scoped version of the widget
 * timing waterfall. Shows one bar per (widget, phase) for every widget in
 * the chosen action, colored blue (Local) / orange (Remote).
 *
 * Props:
 *   open: boolean
 *   onClose(): void
 *   rows: all CSV rows (already session-scoped by caller)
 *   headers: CSV header list
 *   actions: [{ name, timestamp, label }] — options for the picker; the
 *            first entry is used as the initial selection.
 *   initialKey: optional "name::timestamp" string identifying which action
 *            should be pre-selected when the modal opens. Falsy → first
 *            action.
 */
function ActionWaterfallModal({ open, onClose, rows, headers, actions, initialKey }) {
  const [selectedIdx, setSelectedIdx] = useState(0)

  // On open (or when the target action changes), align the dropdown with
  // the requested initialKey — that's how "click the icon on row N" opens
  // the modal already showing action N. Falls back to index 0 when there's
  // no key or no match, so the below-table button still opens on the first
  // action as before.
  //
  // We deliberately depend on `open` and `initialKey` only, not on the
  // `actions` array itself: the parent recreates that array every render,
  // and syncing on it would reset the user's dropdown pick on every parent
  // re-render.
  useEffect(() => {
    if (!open) return
    if (initialKey && actions?.length) {
      const idx = actions.findIndex(
        (a) => `${a.name}::${a.timestamp ?? ''}` === initialKey
      )
      setSelectedIdx(idx >= 0 ? idx : 0)
    } else {
      setSelectedIdx(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialKey])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const selected = actions?.[selectedIdx] ?? null

  const actionRows = useMemo(() => {
    if (!selected) return []
    return applyActionFilter(rows, headers, {
      name: selected.name,
      timestamp: selected.timestamp,
    })
  }, [rows, headers, selected])

  const option = useMemo(
    () => buildActionSequenceOption(actionRows),
    [actionRows]
  )

  if (!open) return null

  // Chart height scales with the number of series so tall actions don't
  // squash their bars unreadably. Roughly 26px per row with sensible bounds.
  const seriesCount =
    (option?.series?.find?.((s) => s?.name === 'duration')?.data?.length) ?? 0
  const chartHeight = Math.max(420, Math.min(1200, 120 + seriesCount * 26))

  return (
    <div className="action-waterfall-backdrop" onClick={onClose}>
      <div
        className="action-waterfall-modal"
        role="dialog"
        aria-labelledby="action-waterfall-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="action-waterfall-header">
          <h2 id="action-waterfall-title">Action Waterfall Chart</h2>
          <button
            type="button"
            className="action-waterfall-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>
        {actions && actions.length > 1 && (
          <div className="action-waterfall-toolbar">
            <label htmlFor="action-waterfall-picker">Action:</label>
            <select
              id="action-waterfall-picker"
              className="action-waterfall-select"
              value={selectedIdx}
              onChange={(e) => setSelectedIdx(Number(e.target.value))}
            >
              {actions.map((a, i) => (
                <option key={`${a.name}::${a.timestamp}::${i}`} value={i}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="action-waterfall-body">
          <ReactECharts
            option={option}
            style={{ height: chartHeight, width: '100%' }}
            notMerge
            lazyUpdate
          />
        </div>
      </div>
    </div>
  )
}

export default ActionWaterfallModal
