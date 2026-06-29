import DataTable from '../../components/DataTable'
import { useCsvData } from '../../context/useCsvData'

/**
 * RawDataView — the full parsed CSV as a table.
 */
function RawDataView() {
  const { rows } = useCsvData()
  return (
    <>
      <h2 className="view-heading">Raw Data View</h2>
      <p className="view-subheading">Every row and column from your CSV.</p>
      <DataTable rows={rows} columns={[]} />
    </>
  )
}

export default RawDataView
