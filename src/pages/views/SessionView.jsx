import { useMemo } from 'react'
import SessionSummaryTable from '../../components/SessionSummaryTable'
import KpiStrip from '../../components/KpiStrip'
import ChartGrid from '../../components/charts/ChartGrid'
import { useCsvData } from '../../context/useCsvData'
import { augmentRowsWithSyntheticMeasures } from '../../lib/syntheticMeasures'

function SessionView() {
  const { rows, headers } = useCsvData()

  const chartData = useMemo(
    () => augmentRowsWithSyntheticMeasures(rows, headers),
    [rows, headers]
  )

  return (
    <>
      <h2 className="view-heading">Session View</h2>
      <p className="view-subheading">
        One row per session — search or filter to narrow the list.
      </p>
      <KpiStrip variant="session" rows={rows} headers={headers} />
      <SessionSummaryTable rows={rows} headers={headers} />

      <h3 className="view-section-heading">Charts</h3>
      <ChartGrid viewId="session" rows={chartData.rows} headers={chartData.headers} />
    </>
  )
}

export default SessionView
