import { formatDurationMs, isDurationColumn } from '../../../lib/format'
import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_GOLD,
  SAP_TEXT_MUTED,
} from '../../../lib/chartColors'

/**
 * Bullet chart — single bar showing actual vs target, with a "good" range
 * highlighted behind it. Implemented as a horizontal bar + markLine/markArea.
 *
 * Expects ONE numeric reading aggregated from `rows[valueKey]` (mean), with
 * literal `target` and `good` values passed in. If you don't know them yet,
 * pass placeholders — the chart still renders.
 */
export function buildBulletOption(rows, { valueKey, target = 100, good = [60, 90], label = '' } = {}) {
  if (!valueKey) return { series: [] }
  const nums = rows.map((r) => Number(r?.[valueKey])).filter((n) => Number.isFinite(n))
  if (!nums.length) return { series: [] }
  const actual = nums.reduce((a, b) => a + b, 0) / nums.length
  const max = Math.max(actual, target, good[1]) * 1.2
  const isDur = isDurationColumn(valueKey)
  const fmt = (v) => (Number.isFinite(Number(v)) ? formatDurationMs(v) : '')

  return {
    textStyle: BASE_TEXT_STYLE,
    tooltip: {
      ...BASE_TOOLTIP,
      ...(isDur ? { valueFormatter: fmt } : {}),
    },
    grid: { ...BASE_GRID, top: 12, bottom: 24 },
    xAxis: {
      type: 'value',
      max,
      ...(isDur ? { axisLabel: { formatter: fmt } } : {}),
    },
    yAxis: { type: 'category', data: [label || valueKey] },
    series: [
      {
        type: 'bar',
        data: [actual],
        barWidth: 14,
        itemStyle: { color: SAP_BLUE, borderRadius: [4, 4, 4, 4] },
        markArea: {
          silent: true,
          itemStyle: { color: 'rgba(0, 112, 242, 0.10)' },
          data: [[{ xAxis: good[0] }, { xAxis: good[1] }]],
        },
        markLine: {
          symbol: 'none',
          lineStyle: { color: SAP_GOLD, width: 3 },
          label: {
            color: SAP_TEXT_MUTED,
            formatter: isDur ? `Target: ${fmt(target)}` : 'Target',
          },
          data: [{ xAxis: target }],
        },
      },
    ],
  }
}
