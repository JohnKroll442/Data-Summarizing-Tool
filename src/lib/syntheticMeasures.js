/**
 * Synthetic per-row "Total" measures for the Widget view's Add Chart dialog.
 *
 * The CSV doesn't carry dedicated render/backend/network duration columns —
 * instead each row has WIDGET_MEASURE ∈ {render, frontend, backend, network,
 * network_ttfb, offset, ...} and the timing lives in the generic DURATION
 * column. To let users plot "backend duration per widget" from the chart
 * picker, we materialize four synthetic columns on each row whose value is
 * DURATION when WIDGET_MEASURE matches that phase, blank otherwise. Group
 * aggregation via sumByColumn then produces the "total per group" the user
 * expects.
 *
 * Total Frontend is an alias for Total Render — widgetAggregate.js already
 * treats those two WIDGET_MEASURE values as the same phase.
 */

import { detectMeasureMapping, measureMatches } from './widgetAggregate'

export const SYNTHETIC_MEASURES = [
  { key: 'Total Render',   targets: ['render', 'frontend'] },
  { key: 'Total Frontend', targets: ['render', 'frontend'] },
  { key: 'Total Backend',  targets: ['backend'] },
  { key: 'Total Network',  targets: ['network'] },
]

/**
 * Return { rows, headers } augmented with synthetic per-row measure columns.
 * If the CSV lacks WIDGET_MEASURE or DURATION, returns the inputs unchanged.
 */
export function augmentRowsWithSyntheticMeasures(rows, headers) {
  const src = { rows: rows ?? [], headers: headers ?? [] }
  if (!src.rows.length || !src.headers.length) return src

  const { measure, duration } = detectMeasureMapping(src.headers)
  if (!measure || !duration) return src

  // Skip if any synthetic name already collides with a real header — leave
  // the real data alone rather than shadow it.
  const headerSet = new Set(src.headers)
  const synthetics = SYNTHETIC_MEASURES.filter((s) => !headerSet.has(s.key))
  if (synthetics.length === 0) return src

  const augmentedRows = src.rows.map((row) => {
    const measureVal = row?.[measure]
    const durationVal = row?.[duration]
    const next = { ...row }
    for (const { key, targets } of synthetics) {
      // Non-matching rows get undefined (not '' or 0) so downstream helpers
      // like sumByColumn skip them via Number()→NaN rather than folding a
      // spurious 0 into every group's total.
      next[key] = measureMatches(measureVal, targets) ? durationVal : undefined
    }
    return next
  })

  return {
    rows: augmentedRows,
    headers: [...src.headers, ...synthetics.map((s) => s.key)],
  }
}
