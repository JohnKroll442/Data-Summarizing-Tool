import { useMemo } from 'react'
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

  const numericMeta = useMemo(
    () => computeNumericMeta(rows, resolvedColumns),
    [rows, resolvedColumns],
  )

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
              const isNumeric = !!numericMeta[col.key]?.numeric
              return (
                <th
                  key={col.key}
                  aria-sort={canSort ? ariaSort : undefined}
                  className={isNumeric ? 'is-numeric' : undefined}
                >
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
                const meta = numericMeta[col.key]
                const isNumeric = !!meta?.numeric
                let cellStyle
                if (isNumeric) {
                  const n = toNumber(value)
                  const max = meta.max
                  let pct = 0
                  if (Number.isFinite(n) && Number.isFinite(max) && max > 0) {
                    pct = Math.max(0, Math.min(100, (n / max) * 100))
                  }
                  cellStyle = { '--bar-pct': `${pct}%` }
                }
                return (
                  <td
                    key={col.key}
                    className={isNumeric ? 'is-numeric' : undefined}
                    style={cellStyle}
                  >
                    <span className="data-table-cell-content">
                      {col.render ? col.render(value, row) : formatCell(value)}
                    </span>
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

function toNumber(value) {
  if (typeof value === 'number') return value
  if (value === null || value === undefined || value === '') return NaN
  const n = Number(value)
  return Number.isFinite(n) ? n : NaN
}

// Sample up to 20 non-null values per column to decide if the column is
// numeric, then track the max for bar-width scaling. sortType overrides
// the sampled inference in either direction.
function computeNumericMeta(rows, cols) {
  const meta = {}
  for (const col of cols) {
    if (col.sortType === 'string') {
      meta[col.key] = { numeric: false, max: 0 }
      continue
    }
    const forceNumeric = col.sortType === 'number'
    let sampled = 0
    let numericCount = 0
    let nonNullCount = 0
    let max = -Infinity
    for (let i = 0; i < rows.length; i++) {
      const v = rows[i]?.[col.key]
      if (v === null || v === undefined || v === '') continue
      nonNullCount++
      if (sampled < 20) {
        sampled++
        const n = toNumber(v)
        if (Number.isFinite(n)) numericCount++
      }
      const n = toNumber(v)
      if (Number.isFinite(n) && n > max) max = n
    }
    const inferredNumeric = sampled > 0 && numericCount === sampled
    const numeric = forceNumeric || (nonNullCount > 0 && inferredNumeric)
    meta[col.key] = {
      numeric,
      max: Number.isFinite(max) ? max : 0,
    }
  }
  return meta
}

export default DataTable
