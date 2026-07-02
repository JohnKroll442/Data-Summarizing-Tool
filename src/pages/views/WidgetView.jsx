import WidgetSummaryTable from '../../components/WidgetSummaryTable'
import KpiStrip from '../../components/KpiStrip'
import ChartGrid from '../../components/charts/ChartGrid'
import { useCsvData } from '../../context/useCsvData'

/**
 * WidgetView — one row per widget table at the top, followed by user-added
 * charts. Use Raw Data View for the underlying detail rows.
 */
function WidgetView() {
  const { rows, headers } = useCsvData()
  return (
    <>
      <h2 className="view-heading">Widget View</h2>
      <p className="view-subheading">
        One row per widget — search or filter to narrow the list.
      </p>
      <KpiStrip variant="widget" rows={rows} headers={headers} />
      <WidgetSummaryTable rows={rows} headers={headers} />

      <h3 className="view-section-heading">Charts</h3>
      <ChartGrid viewId="widget" />
    </>
  )
}

export default WidgetView
