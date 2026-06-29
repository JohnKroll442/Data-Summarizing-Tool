import DataTable from '../../components/DataTable'
import ChartGrid from '../../components/charts/ChartGrid'
import { useCsvData } from '../../context/useCsvData'

/**
 * SessionView — empty by default. Charts are added via the "Add chart"
 * button; the user picks the type and the dimensions/measures.
 */
function SessionView() {
  const { rows } = useCsvData()
  return (
    <>
      <h2 className="view-heading">Session View</h2>
      <p className="view-subheading">Add charts to summarize your session data.</p>
      <ChartGrid viewId="session" />
      <DataTable rows={rows} columns={[]} />
    </>
  )
}

export default SessionView
