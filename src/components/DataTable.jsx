import './DataTable.css'

/**
 * DataTable — generic table for parsed CSV rows.
 *
 * Props:
 *   rows: Array<Record<string, unknown>>
 *   columns: Array<{ key: string, label?: string, render?: (value, row) => ReactNode }>
 *   emptyMessage?: string
 *
 * If `columns` is omitted or empty, all keys present in the first row are
 * shown as-is — useful while the CSV spec is still being defined.
 */
function DataTable({ rows, columns, emptyMessage = 'No rows to display.' }) {
  const resolvedColumns =
    columns && columns.length > 0
      ? columns
      : rows.length > 0
        ? Object.keys(rows[0]).map((key) => ({ key, label: key }))
        : []

  if (rows.length === 0 || resolvedColumns.length === 0) {
    return <div className="data-table-empty">{emptyMessage}</div>
  }

  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {resolvedColumns.map((col) => (
              <th key={col.key}>{col.label ?? col.key}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {resolvedColumns.map((col) => {
                const value = row[col.key]
                return (
                  <td key={col.key}>
                    {col.render ? col.render(value, row) : formatCell(value)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Render unknown cell values predictably — show an em dash for empty /
// nullish values so blank cells read as "no data" instead of looking
// accidentally truncated; stringify objects; leave primitives as-is.
function formatCell(value) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export default DataTable
