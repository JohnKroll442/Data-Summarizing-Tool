import { countRowsWithFiniteAll } from '../../lib/chartData'

/**
 * Given a field, the chart's full field list, the current config, the CSV
 * headers, and the column profile — return the subset of headers that are
 * valid choices for this field RIGHT NOW. Used by ChartPicker to filter
 * dropdowns so the user can't pick combinations that would render nothing.
 *
 *   field         the field whose options we're computing
 *   allFields     full list of fields on the active chart type
 *   config        current { [fieldKey]: value } map
 *   headers       CSV column names
 *   profile       output of profileColumns()
 *   rows          parsed CSV rows (needed for pair-coverage checks)
 */
export function validOptionsFor(field, allFields, config, headers, profile, rows) {
  if (!headers?.length || !profile) return []

  return headers.filter((h) => {
    const prof = profile[h]
    if (!prof) return false

    // —— Role compatibility ——
    if (field.role === 'measure' && prof.type !== 'numeric') return false
    if (field.role === 'measure' && prof.finiteCount < 2) return false

    if (field.role === 'date' && prof.type !== 'date') return false

    if (field.role === 'dimension') {
      // Must vary at all to be useful as a category
      const min = field.minDistinct ?? 2
      const max = field.maxDistinct ?? Infinity
      if (prof.distinctCount < min) return false
      if (prof.distinctCount > max) return false
    }

    // —— distinctFrom: hide columns already taken by sibling fields ——
    if (Array.isArray(field.distinctFrom)) {
      for (const otherKey of field.distinctFrom) {
        const other = config?.[otherKey]
        if (Array.isArray(other)) {
          if (other.includes(h)) return false
        } else if (other && other === h) {
          return false
        }
      }
    }

    // —— pairsWith: for numeric pairs/triples, require ≥2 rows where this
    //    column AND all referenced columns are simultaneously finite ——
    if (Array.isArray(field.pairsWith) && field.pairsWith.length > 0) {
      const pairKeys = field.pairsWith
        .map((k) => config?.[k])
        .filter((v) => v && typeof v === 'string')
      if (pairKeys.length > 0) {
        const coverage = countRowsWithFiniteAll(rows, [h, ...pairKeys])
        if (coverage < 2) return false
      }
    }

    return true
  })
}
