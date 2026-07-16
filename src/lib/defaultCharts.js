/**
 * Default charts seeded into each view on first data load.
 *
 * Intentionally EMPTY: views now start with no auto-generated charts, showing
 * the ChartGrid's "No charts yet — click Add chart" empty state instead. Users
 * build exactly the charts they want via the picker.
 *
 * To bring specific defaults back, return `{ typeId, config }` entries for a
 * given `viewId` here (matching the chart-type registry) — the seeding effect
 * in CsvDataContext will pick them up unchanged.
 */
export function buildDefaultCharts(/* viewId, rows, headers */) {
  return []
}
