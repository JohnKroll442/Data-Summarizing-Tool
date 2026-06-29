/**
 * Chart-type registry — the single source of truth for the chart picker.
 *
 * Each entry describes one chart the user can add:
 *   - `id`:      stable key (saved in chart-list state)
 *   - `label`:   display name in the picker
 *   - `group`:   category in the picker UI
 *   - `fields`:  declarative list of inputs the picker must collect. Each
 *                field has { key, label, role: 'dimension'|'measure'|'number',
 *                required, multiple? }. The picker renders a dropdown of CSV
 *                column names for dimension/measure fields; a number input
 *                for `number` fields.
 *   - `build(rows, config)`: imports the appropriate builder and returns an
 *                ECharts option. `config` is a `{ [field.key]: value }` map.
 */

import { buildBarOption, buildComboOption } from './options/bar'
import { buildLineOption, buildAreaOption } from './options/line'
import { buildPieOption, buildDonutOption } from './options/pie'
import { buildScatterOption, buildBubbleOption } from './options/scatter'
import { buildRadarOption } from './options/radar'
import { buildFunnelOption } from './options/funnel'
import { buildSankeyOption } from './options/sankey'
import { buildGaugeOption } from './options/gauge'
import { buildTreemapOption } from './options/treemap'
import { buildHeatmapOption } from './options/heatmap'
import { buildBoxplotOption } from './options/boxplot'
import { buildWaterfallOption } from './options/waterfall'
import { buildHistogramOption } from './options/histogram'
import { buildParetoOption } from './options/pareto'
import { buildTimeSeriesOption } from './options/timeSeries'
import { buildMarimekkoOption } from './options/marimekko'
import { buildBulletOption } from './options/bullet'

const dim = (key, label, required = true, extra = {}) => ({
  key, label, role: 'dimension', required, ...extra,
})
const mes = (key, label, required = true, extra = {}) => ({
  key, label, role: 'measure', required, ...extra,
})
const date = (key, label, required = true) => ({
  key, label, role: 'date', required,
})
const num = (key, label, defaultValue) => ({
  key, label, role: 'number', required: false, defaultValue,
})

/*
 * Field metadata understood by the picker:
 *   role            'dimension' | 'measure' | 'date' | 'number'
 *   required        boolean
 *   multiple        true → multi-select checkboxes (radar indicators)
 *   distinctFrom    [otherFieldKey] → option list excludes columns already
 *                   chosen by those fields (prevents X==Y on heatmap etc.)
 *   pairsWith       [otherFieldKey] → for numeric pairs/triples (scatter,
 *                   bubble): if the other field has a value, only show
 *                   columns that have ≥2 rows where BOTH fields are finite.
 *   minDistinct     dimensions need at least this many distinct values
 *                   to bother showing (default 2)
 *   maxDistinct     dimensions with more distinct values than this are
 *                   hidden (default Infinity, set lower for heatmaps where
 *                   a 5000-row id column would just be noise)
 */

export const CHART_TYPES = [
  // — Bar / column family —
  {
    id: 'bar', label: 'Bar / column', group: 'Bar & column',
    fields: [dim('xKey', 'Category (dimension)'), mes('yKey', 'Value (measure)', false)],
    build: (rows, c) => buildBarOption(rows, c),
  },
  {
    id: 'stackedBar', label: 'Stacked bar / column', group: 'Bar & column',
    fields: [
      dim('xKey', 'Category'),
      dim('groupKey', 'Stack by (dimension)', true, { distinctFrom: ['xKey'], maxDistinct: 12 }),
      mes('yKey', 'Value (measure)', false),
    ],
    build: (rows, c) => buildBarOption(rows, { ...c, stacked: true }),
  },
  {
    id: 'combo', label: 'Combo column + line', group: 'Bar & column',
    fields: [
      dim('xKey', 'Category'),
      mes('barKey', 'Bar measure'),
      mes('lineKey', 'Line measure', true, { distinctFrom: ['barKey'] }),
    ],
    build: (rows, c) => buildComboOption(rows, c),
  },
  {
    id: 'pareto', label: 'Pareto', group: 'Bar & column',
    fields: [dim('nameKey', 'Category'), mes('valueKey', 'Value (measure)', false)],
    build: (rows, c) => buildParetoOption(rows, c),
  },
  {
    id: 'histogram', label: 'Histogram', group: 'Bar & column',
    fields: [mes('key', 'Numeric column'), num('binCount', 'Bin count', 10)],
    build: (rows, c) => buildHistogramOption(rows, c),
  },
  {
    id: 'waterfall', label: 'Waterfall', group: 'Bar & column',
    fields: [dim('labelKey', 'Label (dimension)'), mes('valueKey', 'Delta (measure)')],
    build: (rows, c) => buildWaterfallOption(rows, c),
  },
  {
    id: 'marimekko', label: 'Marimekko', group: 'Bar & column',
    fields: [
      dim('xKey', 'Category'),
      dim('groupKey', 'Stack by', true, { distinctFrom: ['xKey'], maxDistinct: 12 }),
      mes('valueKey', 'Value', false),
    ],
    build: (rows, c) => buildMarimekkoOption(rows, c),
  },
  {
    id: 'bullet', label: 'Bullet', group: 'Bar & column',
    fields: [mes('valueKey', 'Measure'), num('target', 'Target', 100)],
    build: (rows, c) => buildBulletOption(rows, c),
  },

  // — Line / area —
  {
    id: 'line', label: 'Line', group: 'Line & area',
    fields: [dim('xKey', 'Category'), mes('yKey', 'Value', false)],
    build: (rows, c) => buildLineOption(rows, c),
  },
  {
    id: 'area', label: 'Area', group: 'Line & area',
    fields: [dim('xKey', 'Category'), mes('yKey', 'Value', false)],
    build: (rows, c) => buildAreaOption(rows, c),
  },
  {
    id: 'timeSeries', label: 'Time series', group: 'Line & area',
    fields: [date('xKey', 'Date / time column'), mes('yKey', 'Value')],
    build: (rows, c) => buildTimeSeriesOption(rows, c),
  },

  // — Part-of-whole —
  {
    id: 'pie', label: 'Pie', group: 'Part of whole',
    fields: [
      dim('nameKey', 'Category', true, { maxDistinct: 25 }),
      mes('valueKey', 'Value', false),
    ],
    build: (rows, c) => buildPieOption(rows, c),
  },
  {
    id: 'donut', label: 'Donut', group: 'Part of whole',
    fields: [
      dim('nameKey', 'Category', true, { maxDistinct: 25 }),
      mes('valueKey', 'Value', false),
    ],
    build: (rows, c) => buildDonutOption(rows, c),
  },
  {
    id: 'treemap', label: 'Treemap', group: 'Part of whole',
    fields: [
      dim('nameKey', 'Category', true, { maxDistinct: 50 }),
      mes('valueKey', 'Value', false),
    ],
    build: (rows, c) => buildTreemapOption(rows, c),
  },
  {
    id: 'funnel', label: 'Funnel', group: 'Part of whole',
    fields: [
      dim('nameKey', 'Stage', true, { maxDistinct: 25 }),
      mes('valueKey', 'Value', false),
    ],
    build: (rows, c) => buildFunnelOption(rows, c),
  },

  // — Distribution / correlation —
  {
    id: 'scatter', label: 'Scatter', group: 'Distribution & correlation',
    fields: [
      mes('xKey', 'X (measure)'),
      mes('yKey', 'Y (measure)', true, { distinctFrom: ['xKey'], pairsWith: ['xKey'] }),
    ],
    build: (rows, c) => buildScatterOption(rows, c),
  },
  {
    id: 'bubble', label: 'Bubble', group: 'Distribution & correlation',
    fields: [
      mes('xKey', 'X (measure)'),
      mes('yKey', 'Y (measure)', true, { distinctFrom: ['xKey'], pairsWith: ['xKey'] }),
      mes('sizeKey', 'Size (measure)', true, { distinctFrom: ['xKey', 'yKey'], pairsWith: ['xKey', 'yKey'] }),
    ],
    build: (rows, c) => buildBubbleOption(rows, c),
  },
  {
    id: 'clusterBubble', label: 'Cluster bubble', group: 'Distribution & correlation',
    fields: [
      mes('xKey', 'X (measure)'),
      mes('yKey', 'Y (measure)', true, { distinctFrom: ['xKey'], pairsWith: ['xKey'] }),
      mes('sizeKey', 'Size (measure)', true, { distinctFrom: ['xKey', 'yKey'], pairsWith: ['xKey', 'yKey'] }),
    ],
    build: (rows, c) => buildBubbleOption(rows, c),
  },
  {
    id: 'boxplot', label: 'Box plot', group: 'Distribution & correlation',
    fields: [
      dim('groupKey', 'Group (dimension)', true, { maxDistinct: 30 }),
      mes('valueKey', 'Numeric column'),
    ],
    build: (rows, c) => buildBoxplotOption(rows, c),
  },
  {
    id: 'heatmap', label: 'Heat map', group: 'Distribution & correlation',
    fields: [
      dim('xKey', 'X (dimension)', true, { maxDistinct: 50 }),
      dim('yKey', 'Y (dimension)', true, { distinctFrom: ['xKey'], maxDistinct: 50 }),
      mes('valueKey', 'Value (measure)', false),
    ],
    build: (rows, c) => buildHeatmapOption(rows, c),
  },
  {
    id: 'radar', label: 'Radar', group: 'Distribution & correlation',
    fields: [
      dim('groupKey', 'Group (dimension)', true, { maxDistinct: 12 }),
      { key: 'indicatorKeys', label: 'Indicators (measures)', role: 'measure', required: true, multiple: true, distinctFrom: ['groupKey'] },
    ],
    build: (rows, c) => buildRadarOption(rows, c),
  },

  // — KPIs & flow —
  {
    id: 'gauge', label: 'Gauge', group: 'KPIs & flow',
    fields: [mes('valueKey', 'Measure'), num('max', 'Max', 100)],
    build: (rows, c) => buildGaugeOption(rows, c),
  },
  {
    id: 'kpi', label: 'Numeric KPI', group: 'KPIs & flow',
    fields: [mes('valueKey', 'Measure')],
    build: (rows, c) => buildGaugeOption(rows, { ...c, numericKpi: true }),
  },
  {
    id: 'sankey', label: 'Sankey', group: 'KPIs & flow',
    fields: [
      dim('sourceKey', 'Source', true, { maxDistinct: 50 }),
      dim('targetKey', 'Target', true, { distinctFrom: ['sourceKey'], maxDistinct: 50 }),
      mes('valueKey', 'Value', false),
    ],
    build: (rows, c) => buildSankeyOption(rows, c),
  },
]

/** Lookup by id — used when rebuilding a saved chart definition. */
export function getChartType(id) {
  return CHART_TYPES.find((t) => t.id === id)
}

/** Group chart types for the picker UI. */
export function groupedChartTypes() {
  const groups = new Map()
  for (const t of CHART_TYPES) {
    if (!groups.has(t.group)) groups.set(t.group, [])
    groups.get(t.group).push(t)
  }
  return Array.from(groups, ([group, types]) => ({ group, types }))
}
