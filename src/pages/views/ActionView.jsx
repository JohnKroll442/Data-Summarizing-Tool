import ActionSummaryTable from '../../components/ActionSummaryTable'
import KpiStrip from '../../components/KpiStrip'
import ChartGrid from '../../components/charts/ChartGrid'
import { useCsvData } from '../../context/useCsvData'

/**
 * ActionView — one row per action table at the top, followed by user-added
 * charts. Use Raw Data View for the underlying detail rows.
 */
function ActionView() {
  const { rows, headers } = useCsvData()
  return (
    <>
      <h2 className="view-heading">Action View</h2>
      <p className="view-subheading">
        One row per action — search or filter to narrow the list.
      </p>
      <KpiStrip variant="action" rows={rows} headers={headers} />
      <ActionSummaryTable rows={rows} headers={headers} />

      <h3 className="view-section-heading">Charts</h3>
      <ChartGrid viewId="action" />
    </>
  )
}

export default ActionView
