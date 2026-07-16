import SessionSummaryTable from '../../components/SessionSummaryTable'
import ChartGrid from '../../components/charts/ChartGrid'
import { useCsvData } from '../../context/useCsvData'

function SessionView() {
  const { rows, headers } = useCsvData()

  return (
    <>
      <h2 className="view-heading">Session View</h2>
      <SessionSummaryTable rows={rows} headers={headers} />
      <h3 className="view-section-heading">Charts</h3>
      <ChartGrid viewId="session" rows={rows} headers={headers} />
    </>
  )
}

export default SessionView
