import { useMemo } from 'react'
import WidgetSummaryTable from '../../components/WidgetSummaryTable'
import KpiStrip from '../../components/KpiStrip'
import ChartGrid from '../../components/charts/ChartGrid'
import { useCsvData } from '../../context/useCsvData'
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

  return (
    <>
      <h2 className="view-heading">Widget View</h2>
      <p className="view-subheading">
        One row per widget — search or filter to narrow the list.
      </p>
      <KpiStrip variant="widget" rows={scopedRows} headers={headers} />
      <WidgetSummaryTable rows={rows} headers={headers} />

      <h3 className="view-section-heading">Charts</h3>
      <ChartGrid viewId="widget" rows={scopedRows} headers={headers} />
    </>
  )
}

export default WidgetView
