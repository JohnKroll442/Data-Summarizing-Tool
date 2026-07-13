import { useEffect, useMemo, useState } from 'react'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import { buildActionSequenceOption, detectMapping } from './charts/options/actionSequence'
import WidgetTimingModal from './WidgetTimingModal'
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
  // Which widget (if any) the user drilled into by clicking a bar. Holds the
  // display name + the rows for that widget; null when the drill-down modal
  // is closed.
  const [widgetModal, setWidgetModal] = useState(null)

  const total = actions?.length ?? 0
  // Clamp-step through the action list. Guarded by the caller so it never
  // fires while the widget drill-down is open.
  const step = (delta) => {
    setSelectedIdx((i) => Math.max(0, Math.min(total - 1, i + delta)))
  }

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
      if (e.key === 'Escape') {
        // Esc peels back one layer: close the widget drill-down first, then
        // the waterfall itself.
        if (widgetModal) setWidgetModal(null)
        else onClose()
        return
      }
      // Don't hijack arrows while the drill-down is open, or while the user
      // is interacting with the action <select> (native option stepping).
      if (widgetModal) return
      if (e.target?.tagName === 'SELECT' || e.target?.tagName === 'INPUT') return
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose, widgetModal, total])

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

  // Column keys for this CSV shape. Used to slice the action's rows down to a
  // single widget (on click) and to enumerate every widget in the action.
  const mapping = useMemo(() => detectMapping(headers), [headers])
  const widgetIdKey = mapping.widgetId

  // Widgets that exist in this action but produced no bars — i.e. no phase
  // with a positive DURATION under a recognized measure. We surface them in a
  // note under the chart so nothing is silently hidden. Order = first-seen in
  // the CSV; display name mirrors the chart (first non-empty name, else id).
  const untimedWidgets = useMemo(() => {
    if (!widgetIdKey) return []
    // Ids that DID get charted, read off the built duration series.
    const charted = new Set()
    const durationSeries = option?.series?.find?.((s) => s?.name === 'duration')
    for (const d of durationSeries?.data ?? []) {
      if (d && d.widgetId !== undefined) charted.add(String(d.widgetId))
    }
    // Every widget in the action, in first-seen order, with a display name.
    const order = []
    const names = new Map()
    for (const r of actionRows) {
      const id = r?.[widgetIdKey]
      if (id === undefined || id === null || id === '') continue
      const key = String(id)
      if (!names.has(key)) {
        order.push(key)
        names.set(key, '')
      }
      if (!names.get(key) && mapping.widgetName) {
        const nm = r?.[mapping.widgetName]
        if (nm !== undefined && nm !== null && nm !== '') names.set(key, String(nm))
      }
    }
    return order
      .filter((id) => !charted.has(id))
      .map((id) => names.get(id) || id)
  }, [option, actionRows, widgetIdKey, mapping.widgetName])

  // Click a bar → open the per-widget timing modal for that widget, scoped to
  // the current action (so its Action End markLine is correct).
  const onChartClick = (params) => {
    const d = params?.data
    if (!d || typeof d !== 'object' || d.widgetId === undefined) return
    const widgetRows = widgetIdKey
      ? actionRows.filter((r) => String(r?.[widgetIdKey] ?? '') === String(d.widgetId))
      : []
    if (widgetRows.length === 0) return
    setWidgetModal({
      widgetName: d.widgetName || String(d.widgetId),
      widgetRows,
    })
  }

  if (!open) return null

  // Chart height scales with the number of series so tall actions don't
  // squash their bars unreadably. Roughly 26px per row with sensible bounds.
  const seriesCount =
    (option?.series?.find?.((s) => s?.name === 'duration')?.data?.length) ?? 0
  const chartHeight = Math.max(420, Math.min(1200, 120 + seriesCount * 26))

  return (
    <>
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
            <div className="action-waterfall-stepper">
              <button
                type="button"
                className="action-waterfall-step"
                onClick={() => step(-1)}
                disabled={selectedIdx <= 0}
                aria-label="Previous action"
                title="Previous action (←)"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="action-waterfall-position">
                {selectedIdx + 1} / {total}
              </span>
              <button
                type="button"
                className="action-waterfall-step"
                onClick={() => step(1)}
                disabled={selectedIdx >= total - 1}
                aria-label="Next action"
                title="Next action (→)"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
        <div className="action-waterfall-body">
          <ReactECharts
            option={option}
            style={{ height: chartHeight, width: '100%' }}
            notMerge
            lazyUpdate
            onEvents={{ click: onChartClick }}
          />
        </div>
        {untimedWidgets.length > 0 && (
          <p className="action-waterfall-footnote">
            {untimedWidgets.length} widget{untimedWidgets.length === 1 ? '' : 's'} in
            this action {untimedWidgets.length === 1 ? 'has' : 'have'} no timed
            phases and {untimedWidgets.length === 1 ? "isn't" : "aren't"} charted:{' '}
            <span className="action-waterfall-footnote-list">
              {untimedWidgets.join(', ')}
            </span>
          </p>
        )}
      </div>
    </div>

      <WidgetTimingModal
        open={!!widgetModal}
        onClose={() => setWidgetModal(null)}
        widgetName={widgetModal?.widgetName}
        widgetRows={widgetModal?.widgetRows ?? []}
        actionRows={actionRows}
      />
    </>
  )
}

export default ActionWaterfallModal
