import { countByColumn, sumByColumn } from '../../../lib/chartData'
import { formatDurationMs, isDurationColumn } from '../../../lib/format'
import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_BLUE_LIGHT,
} from '../../../lib/chartColors'

/**
 * Line chart. Pass `area: true` to fill below the line; `stacked: true`
 * requires a `groupKey` to produce multiple stacked series.
 */
export function buildLineOption(rows, { xKey, yKey, area = false } = {}) {
  if (!xKey) return { series: [] }
  const data = yKey ? sumByColumn(rows, xKey, yKey) : countByColumn(rows, xKey)
  const isDur = isDurationColumn(yKey)
  const fmt = (v) => (Number.isFinite(Number(v)) ? formatDurationMs(v) : '')
  return {
    color: [SAP_BLUE],
    textStyle: BASE_TEXT_STYLE,
    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'axis',
      ...(isDur ? { valueFormatter: fmt } : {}),
    },
    grid: BASE_GRID,
    xAxis: { type: 'category', data: data.map((d) => d.name), boundaryGap: false },
    yAxis: {
      type: 'value',
      ...(isDur ? { axisLabel: { formatter: fmt } } : {}),
    },
    series: [
      {
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        data: data.map((d) => d.value),
        lineStyle: { width: 3 },
        ...(area ? { areaStyle: { color: SAP_BLUE_LIGHT, opacity: 0.6 } } : {}),
      },
    ],
  }
}

/** Pure area chart — alias for line+area, kept as its own builder for clarity. */
export function buildAreaOption(rows, opts = {}) {
  return buildLineOption(rows, { ...opts, area: true })
}
