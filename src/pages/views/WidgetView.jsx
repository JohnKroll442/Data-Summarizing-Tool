import DataTable from '../../components/DataTable'
import ChartGrid from '../../components/charts/ChartGrid'
import { useCsvData } from '../../context/useCsvData'

/**
 * WidgetView — empty by default. Charts are added via the "Add chart"
 * button; the user picks the type and the dimensions/measures.
 */
function WidgetView() {
  const { rows } = useCsvData()
  return (
    <>
      <h2 className="view-heading">Widget View</h2>
      <p className="view-subheading">Add charts to summarize your widget data.</p>
      <ChartGrid viewId="widget" />
      <DataTable rows={rows} columns={[]} />
    </>
  )
}

export default WidgetView
