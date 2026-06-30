import './DataTable.css'

/**
 * DataTable — generic table for parsed CSV rows.
 *
 * Props:
 *   rows: Array<Record<string, unknown>>
 *   columns: Array<{
 *     key: string,
 *     label?: string,
 *     render?: (value, row) => ReactNode,
 *     sortType?: 'number' | 'string' | 'duration',
 *     sortable?: boolean,   // explicit opt-in/out (defaults to true)
 *   }>
 *   emptyMessage?: string
 *   sort?: { key: string, dir: 'asc' | 'desc' } | null
 *   onSortChange?: (next) => void   // omit to disable sort UI entirely
 *
 * Sorting is controlled — callers own the state and pass already-sorted
 * rows. DataTable only renders headers as buttons and reports cycles
 * (none → asc → desc → none) through onSortChange.
 *
 * If `columns` is omitted or empty, all keys present in the first row are
 * shown as-is — useful while the CSV spec is still being defined.
 */
function DataTable({ rows, columns, emptyMessage = 'No rows to display.', sort = null, onSortChange }) {
  const resolvedColumns =
    columns && columns.length > 0
      ? columns
      : rows.length > 0
        ? Object.keys(rows[0]).map((key) => ({ key, label: key }))
        : []

  if (rows.length === 0 || resolvedColumns.length === 0) {
    return <div className="data-table-empty">{emptyMessage}</div>
  }

  const sortEnabled = typeof onSortChange === 'function'

  const handleHeaderClick = (col) => {
    if (!sortEnabled) return
    if (col.sortable === false) return
    const isCurrent = sort?.key === col.key
    let next
    if (!isCurrent) next = { key: col.key, dir: 'asc' }
    else if (sort.dir === 'asc') next = { key: col.key, dir: 'desc' }
    else next = null
    onSortChange(next)
  }

  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {resolvedColumns.map((col) => {
              const canSort = sortEnabled && col.sortable !== false
              const active = sort?.key === col.key
              const dir = active ? sort.dir : null
              const ariaSort = !active ? 'none' : dir === 'asc' ? 'ascending' : 'descending'
              return (
                <th key={col.key} aria-sort={canSort ? ariaSort : undefined}>
                  {canSort ? (
                    <button
                      type="button"
                      className={`data-table-sort${active ? ' is-active' : ''}`}
                      onClick={() => handleHeaderClick(col)}
                    >
                      <span>{col.label ?? col.key}</span>
                      <span className="data-table-sort-indicator" aria-hidden="true">
                        {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : ''}
                      </span>
                    </button>
                  ) : (
                    col.label ?? col.key
                  )}
                </th>
              )
            })}
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
