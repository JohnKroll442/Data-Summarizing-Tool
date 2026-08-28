import SessionSummaryTable from '../../components/SessionSummaryTable'
import { useCsvData } from '../../context/useCsvData'
import { HeaderPortal } from '../../context/HeaderSlot'

function SessionView() {
  const { rows, headers } = useCsvData()

  return (
    <>
      <HeaderPortal>
      </HeaderPortal>
      <SessionSummaryTable rows={rows} headers={headers} />
    </>
  )
}

export default SessionView
