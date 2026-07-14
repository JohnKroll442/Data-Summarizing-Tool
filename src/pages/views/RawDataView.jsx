import { useMemo, useState } from 'react'
import DataTable from '../../components/DataTable'
import { usePagination, PageSizeSelect, TablePager } from '../../components/Pagination'
import { useCsvData } from '../../context/useCsvData'
import { sortRows } from '../../lib/sortRows'
import { rowsToCsv, downloadCsv, buildExportFilename } from '../../lib/exportCsv'
import '../../components/SessionSummaryTable.css'

/**
 * RawDataView — the full parsed CSV as a table.
 *
 * Columns are derived from the CSV headers (in original order). Each
 * column's sortType is sniffed from the actual data: numeric if every
 * non-empty cell parses as a finite number, else string.
 *
 * Rows are paginated so the DOM never mounts more than one page of <tr>s —
 * a huge file would otherwise render millions of nodes and crash the tab.
 * Sorting and Export CSV operate on the FULL dataset, not just the page.
 */
function RawDataView() {
  const { rows, headers, fileName } = useCsvData()
  const [sort, setSort] = useState(null)

  const columns = useMemo(() => {
    const keys = headers.length > 0 ? headers : rows.length > 0 ? Object.keys(rows[0]) : []
    return keys.map((key) => ({
      key,
      label: key,
      sortType: detectSortType(rows, key),
    }))
  }, [headers, rows])

  // Sort the WHOLE dataset (so paging walks the sorted order), then slice.
  const sortedRows = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    return sortRows(rows, sort.key, sort.dir, col?.sortType)
  }, [rows, sort, columns])

  const {
    pageRows, page, setPage, pageSize, setPageSize, pageCount, total, firstShown, lastShown,
  } = usePagination(sortedRows)

  return (
    <>
      <h2 className="view-heading">Raw Data View</h2>
      <p className="view-subheading">Every row and column from your CSV.</p>
      <div className="summary-filters">
        <span className="summary-filter-count" style={{ marginLeft: 0, marginRight: 'auto' }}>
          {total.toLocaleString()} row{total === 1 ? '' : 's'}
          {total > 0 && (
            <> · showing {firstShown.toLocaleString()}–{lastShown.toLocaleString()}</>
          )}
        </span>
        <PageSizeSelect value={pageSize} onChange={setPageSize} />
        <button
          type="button"
          className="summary-filter-export"
          disabled={sortedRows.length === 0}
          title={sortedRows.length === 0 ? 'No rows to export' : 'Download all rows as CSV'}
          onClick={() => {
            const csv = rowsToCsv(sortedRows, columns)
            downloadCsv(buildExportFilename(fileName, 'raw'), csv)
          }}
        >
          Export CSV
        </button>
      </div>

      <DataTable
        rows={pageRows}
        columns={columns}
        sort={sort}
        onSortChange={setSort}
      />

      <TablePager page={page} pageCount={pageCount} onPage={setPage} />
    </>
  )
}

function detectSortType(rows, key) {
  let sawValue = false
  for (const row of rows) {
    const v = row?.[key]
    if (v === null || v === undefined || v === '') continue
    sawValue = true
    if (!Number.isFinite(Number(v))) return 'string'
  }
  return sawValue ? 'number' : 'string'
}

export default RawDataView
