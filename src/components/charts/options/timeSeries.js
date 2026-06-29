import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
} from '../../../lib/chartColors'

/**
 * Time series — line over a `time`-typed x-axis. `xKey` should contain
 * parseable date strings; non-parseable rows are dropped.
 */
export function buildTimeSeriesOption(rows, { xKey, yKey } = {}) {
  if (!xKey || !yKey || !rows?.length) return { series: [] }
  const points = []
  for (const row of rows) {
    const t = Date.parse(row?.[xKey])
    const y = Number(row?.[yKey])
    if (!Number.isFinite(t) || !Number.isFinite(y)) continue
    points.push([t, y])
  }
  if (!points.length) return { series: [] }
  points.sort((a, b) => a[0] - b[0])

  return {
    color: [SAP_BLUE],
    textStyle: BASE_TEXT_STYLE,
    tooltip: { ...BASE_TOOLTIP, trigger: 'axis' },
    grid: BASE_GRID,
    xAxis: { type: 'time' },
    yAxis: { type: 'value' },
    series: [
      {
        type: 'line',
        smooth: true,
        symbol: 'none',
        data: points,
        lineStyle: { width: 2 },
      },
    ],
  }
}
