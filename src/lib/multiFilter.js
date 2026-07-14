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
 * Like matchesAllMultiFilters, but ignores one column's own selection. This is
 * the core of the faceted option lists below: a column's available options
 * should reflect the rows that pass every OTHER active filter — but a column
 * must never constrain its own menu, or selecting one value would make all the
 * other choices disappear.
 */
export function matchesMultiFiltersExcept(row, filters, exceptKey) {
  for (const [col, values] of Object.entries(filters)) {
    if (col === exceptKey) continue
    if (!Array.isArray(values) || values.length === 0) continue
    if (!values.includes(String(row?.[col] ?? ''))) return false
  }
  return true
}

/**
 * Build each filterable column's dropdown options so it only offers values that
 * still apply given the OTHER active filters ("faceted" filtering) — e.g. with
 * three sessions selected, the User/Story menus list only the users/stories
 * present in those sessions.
 *
 *   rows:     the row set the menus draw from (already scoped/aggregated)
 *   columns:  [{ key, label }] filterable columns
 *   filters:  the current { [colKey]: string[] } selections
 *   extraMatch: optional predicate for non-column filters (e.g. the time
 *              filter) that should also narrow the options
 *
 * A column's own selected values are always kept, so a selection never vanishes
 * from its menu even if the other filters would exclude it.
 */
export function facetedOptionsByColumn(rows, columns, filters, extraMatch) {
  const out = {}
  for (const col of columns) {
    const set = new Set()
    for (const row of rows) {
      if (!matchesMultiFiltersExcept(row, filters, col.key)) continue
      if (extraMatch && !extraMatch(row)) continue
      const v = row?.[col.key]
      if (v === undefined || v === null || v === '') continue
      set.add(String(v))
    }
    for (const v of filters[col.key] ?? []) set.add(String(v))
    out[col.key] = Array.from(set).sort((a, b) => a.localeCompare(b))
  }
  return out
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
