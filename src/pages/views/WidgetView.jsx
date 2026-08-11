import { useEffect, useMemo, useRef, useState } from 'react'
import WidgetSummaryTable from '../../components/WidgetSummaryTable'
import WidgetTimingPanel from '../../components/WidgetTimingPanel'
import ChartGrid from '../../components/charts/ChartGrid'
import { useCsvData } from '../../context/useCsvData'
import { HeaderPortal } from '../../context/HeaderSlot'
import {
  applySessionFilter,
  applySessionMultiFilter,
  applyActionFilter,
  applyActionMultiFilter,
} from '../../lib/drillDown'

/**
 * WidgetView — one row per widget table at the top, followed by user-added
 * charts. Use Raw Data View for the underlying detail rows.
 */
function WidgetView() {
  const {
    rows,
    headers,
    sessionFilter,
    sessionMultiFilter,
    actionFilter,
    actionMultiFilter,
  } = useCsvData()

  // Scope KPIs + charts to match the table. Each multiselect filter, when
  // active, takes over its dimension's row scope; otherwise the single
  // drill-down from the Session/Action views applies.
  const scopedRows = useMemo(() => {
    let out = sessionMultiFilter.length > 0
      ? applySessionMultiFilter(rows, headers, sessionMultiFilter)
      : applySessionFilter(rows, headers, sessionFilter)
    out = actionMultiFilter.length > 0
      ? applyActionMultiFilter(out, headers, actionMultiFilter)
      : applyActionFilter(out, headers, actionFilter)
    return out
  }, [rows, headers, sessionFilter, sessionMultiFilter, actionFilter, actionMultiFilter])

  // The per-widget timing chart renders inline in the chart region (no popup).
  // Its selection state lives in the table (which knows the filtered + sorted
  // widget list); the table publishes it up here via onTimingChange. null =
  // nothing selected → no panel.
  const [timingSel, setTimingSel] = useState(null)
  const panelOpen = timingSel != null

  // Scroll the panel into view when a widget is first selected. Keyed on the
  // open boolean only, NOT the selection identity, so stepping through widgets
  // with the picker/arrows doesn't yank the page each time. Respects
  // reduced-motion.
  const panelRef = useRef(null)
  useEffect(() => {
    if (!panelOpen) return
    const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth'
    panelRef.current?.scrollIntoView({ behavior, block: 'start' })
  }, [panelOpen])

  return (
    <>
      <HeaderPortal>
        <h2 className="view-heading">Widget View</h2>
      </HeaderPortal>
      <WidgetSummaryTable rows={rows} headers={headers} onTimingChange={setTimingSel} />

      {timingSel && (
        <div ref={panelRef}>
          <WidgetTimingPanel
            open
            widgetName={timingSel.widgetName}
            widgetRows={timingSel.widgetRows}
            actionRows={timingSel.actionRows}
            items={timingSel.items}
            index={timingSel.index}
            onIndexChange={timingSel.onIndexChange}
            onClose={timingSel.onClose}
          />
        </div>
      )}
      <h3 className="view-section-heading">Charts</h3>
      <ChartGrid viewId="widget" rows={scopedRows} headers={headers} />
    </>
  )
}

export default WidgetView
