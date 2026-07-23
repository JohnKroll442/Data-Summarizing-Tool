import { useEffect } from 'react'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import { buildWidgetTimingOption } from './charts/options/widgetTiming'
import { useViewportWidth } from '../lib/useViewportWidth'
import './WidgetTimingModal.css'

/**
 * WidgetTimingModal — popup chart for a single widget, opened by clicking
 * the widget name in WidgetSummaryTable.
 *
 * Optional navigation (mirrors ActionWaterfallModal): when `items` +
 * `onIndexChange` are supplied, a picker and a ◀ N / total ▶ stepper let the
 * user flip through the widgets currently shown in the table (every filter and
 * sort applied). ArrowLeft/ArrowRight step too. Omit those props — as the
 * nested bar-click drill-down from the Action Waterfall does — for a plain
 * single-widget chart with no navigation.
 *
 * Props:
 *   open, onClose
 *   widgetName: string             — header label
 *   widgetRows: rows for that widget only
 *   actionRows: rows for the parent action (anchors the Action End markLine;
 *               falls back to widgetRows when omitted)
 *   items?: [{ key, label }]       — the navigable widget list (for the picker)
 *   index?: number                 — 0-based selected index into items
 *   onIndexChange?: (nextIndex) => void
 */
function WidgetTimingModal({
  open,
  onClose,
  widgetName,
  widgetRows,
  actionRows,
  items,
  index = 0,
  onIndexChange,
}) {
  const total = items?.length ?? 0
  const canNavigate = !!onIndexChange && total > 1

  // Track viewport width so the chart's responsive font sizes rescale live
  // when the window is resized while the modal is open.
  useViewportWidth()

  // Close on Esc; arrow-key stepping when navigable (mirrors the Action
  // Waterfall modal). Don't hijack arrows while a SELECT/INPUT is focused so
  // native option stepping still works.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return }
      if (!canNavigate) return
      if (e.target?.tagName === 'SELECT' || e.target?.tagName === 'INPUT') return
      if (e.key === 'ArrowLeft') { e.preventDefault(); onIndexChange(Math.max(0, index - 1)) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); onIndexChange(Math.min(total - 1, index + 1)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, canNavigate, index, total, onIndexChange])

  if (!open) return null

  const option = buildWidgetTimingOption(widgetRows, actionRows ?? widgetRows)

  return (
    <div className="widget-timing-backdrop" onClick={onClose}>
      <div
        className="widget-timing-modal"
        role="dialog"
        aria-labelledby="widget-timing-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="widget-timing-header">
          <h2 id="widget-timing-title">{widgetName || 'Widget timing'}</h2>
          <button
            type="button"
            className="widget-timing-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        {canNavigate && (
          <div className="widget-timing-toolbar">
            <label htmlFor="widget-timing-picker">Widget:</label>
            <select
              id="widget-timing-picker"
              className="widget-timing-select"
              value={index}
              onChange={(e) => onIndexChange(Number(e.target.value))}
            >
              {items.map((it, i) => (
                <option key={it.key ?? i} value={i}>{it.label}</option>
              ))}
            </select>
            <div className="widget-timing-stepper">
              <button
                type="button"
                className="widget-timing-step"
                onClick={() => onIndexChange(Math.max(0, index - 1))}
                disabled={index <= 0}
                aria-label="Previous widget"
                title="Previous widget (←)"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="widget-timing-position">
                {index + 1} / {total}
              </span>
              <button
                type="button"
                className="widget-timing-step"
                onClick={() => onIndexChange(Math.min(total - 1, index + 1))}
                disabled={index >= total - 1}
                aria-label="Next widget"
                title="Next widget (→)"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}

        <div className="widget-timing-body">
          <ReactECharts
            option={option}
            style={{ height: 360, width: '100%' }}
            notMerge
            lazyUpdate
          />
        </div>
      </div>
    </div>
  )
}

export default WidgetTimingModal
