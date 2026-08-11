import { useEffect } from 'react'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import { buildWidgetTimingOption } from './charts/options/widgetTiming'
import { useViewportWidth } from '../lib/useViewportWidth'
import './WidgetTimingPanel.css'

/**
 * WidgetTimingPanel — inline timing chart for a single widget. Rendered in the
 * bottom chart region of the Widget view (opened by clicking a widget name) and
 * swapped in-place inside the Action Waterfall panel (opened by clicking a bar).
 * No popup / backdrop — it lives in the normal document flow.
 *
 * Optional navigation: when `items` + `onIndexChange` are supplied, a picker and
 * a ◀ N / total ▶ stepper let the user flip through the widgets in the current
 * context (every table filter + sort applied, or the action's charted widgets).
 * ArrowLeft/ArrowRight step too.
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
 *   onBack?: () => void            — when set, the header shows a "← Back to
 *               action" control (used inside the Action Waterfall panel) and
 *               Esc dismisses via this instead of onClose.
 */
function WidgetTimingPanel({
  open,
  onClose,
  widgetName,
  widgetRows,
  actionRows,
  items,
  index = 0,
  onIndexChange,
  onBack,
}) {
  const total = items?.length ?? 0
  const canNavigate = !!onIndexChange && total > 1

  // Track viewport width so the chart's responsive font sizes rescale live
  // when the window is resized while the panel is open.
  useViewportWidth()

  // Close on Esc; arrow-key stepping when navigable. In the Action Waterfall's
  // widget mode, Esc goes "back to action" rather than closing the whole panel.
  // Don't hijack arrows while a SELECT/INPUT is focused so native option
  // stepping still works.
  useEffect(() => {
    if (!open) return undefined
    const dismiss = onBack ?? onClose
    const onKey = (e) => {
      if (e.key === 'Escape') { dismiss?.(); return }
      if (!canNavigate) return
      if (e.target?.tagName === 'SELECT' || e.target?.tagName === 'INPUT') return
      if (e.key === 'ArrowLeft') { e.preventDefault(); onIndexChange(Math.max(0, index - 1)) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); onIndexChange(Math.min(total - 1, index + 1)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, onBack, canNavigate, index, total, onIndexChange])

  if (!open) return null

  const option = buildWidgetTimingOption(widgetRows, actionRows ?? widgetRows)

  return (
    <section className="widget-timing-panel" aria-labelledby="widget-timing-title">
      <header className="widget-timing-header">
        <div className="widget-timing-header-left">
          {onBack && (
            <button
              type="button"
              className="widget-timing-back"
              onClick={onBack}
              title="Back to the action waterfall"
            >
              <ChevronLeft size={16} />
              Back to action
            </button>
          )}
          <h2 id="widget-timing-title">{widgetName || 'Widget timing'}</h2>
        </div>
        {!onBack && (
          <button
            type="button"
            className="widget-timing-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        )}
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
    </section>
  )
}

export default WidgetTimingPanel
