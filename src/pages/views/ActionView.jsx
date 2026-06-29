import DataTable from '../../components/DataTable'
import ChartGrid from '../../components/charts/ChartGrid'
import { useCsvData } from '../../context/useCsvData'

/**
 * ActionView — empty by default. Charts are added via the "Add chart"
 * button; the user picks the type and the dimensions/measures.
 */
function ActionView() {
  const { rows } = useCsvData()
  return (
    <>
      <h2 className="view-heading">Action View</h2>
      <p className="view-subheading">Add charts to summarize your action data.</p>
      <ChartGrid viewId="action" />
      <DataTable rows={rows} columns={[]} />
    </>
  )
}

export default ActionView
