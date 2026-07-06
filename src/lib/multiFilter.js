/**
 * Shared helpers for the summary tables' multi-select filter bars.
 *
 * Each table keeps a `filters` state shaped as `{ [columnKey]: string[] }`,
 * where an empty array (or missing key) means "no constraint on this column".
 * A row passes the filter set when, for every column that has ≥1 selected
 * value, the row's cell value (stringified) is one of the selected values.
 */

/** True if the row satisfies every active multi-select filter. */
export function matchesAllMultiFilters(row, filters) {
  for (const [col, values] of Object.entries(filters)) {
    if (!Array.isArray(values) || values.length === 0) continue
    if (!values.includes(String(row?.[col] ?? ''))) return false
  }
  return true
}

/**
 * Count of filter chips currently constraining the view — one per column
 * with a non-empty selection, plus one for a non-empty free-text search.
 */
export function countActiveMultiFilters(filters, searchTerm) {
  let n = 0
  for (const values of Object.values(filters)) {
    if (Array.isArray(values) && values.length > 0) n++
  }
  if (searchTerm && searchTerm.trim()) n++
  return n
}
