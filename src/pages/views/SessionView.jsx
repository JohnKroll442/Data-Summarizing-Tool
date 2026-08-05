import SessionSummaryTable from '../../components/SessionSummaryTable'
import ChartGrid from '../../components/charts/ChartGrid'
import { useCsvData } from '../../context/useCsvData'
import { HeaderPortal } from '../../context/HeaderSlot'

function SessionView() {
  const { rows, headers } = useCsvData()

  return (
    <>
      <HeaderPortal>
        <h2 className="view-heading">Session View</h2>
      </HeaderPortal>
      <SessionSummaryTable rows={rows} headers={headers} />
      <h3 className="view-section-heading">Charts</h3>
      <ChartGrid viewId="session" rows={rows} headers={headers} />
    </>
  )
}

export default SessionView
