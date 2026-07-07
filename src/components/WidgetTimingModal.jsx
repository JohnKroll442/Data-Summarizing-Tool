import { useEffect } from 'react'
import { X } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import { buildWidgetTimingOption } from './charts/options/widgetTiming'
import './WidgetTimingModal.css'

/**
 * WidgetTimingModal — popup chart for a single widget, opened by clicking
 * the widget name in WidgetSummaryTable.
 *
 * Props:
 *   open: boolean
 *   onClose(): void
 *   widgetName: string             — header label
 *   widgetRows: rows for that widget only
 *   actionRows: rows for the parent action (used to anchor the Action End
 *               markLine; falls back to widgetRows when omitted)
 */
function WidgetTimingModal({ open, onClose, widgetName, widgetRows, actionRows }) {
  // Close on Esc — modal backdrops on this app already close on click-outside.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

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
