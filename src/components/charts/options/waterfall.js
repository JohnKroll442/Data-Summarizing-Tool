import { cumulativeDeltas } from '../../../lib/chartData'
import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_DANGER,
} from '../../../lib/chartColors'

/**
 * Financial-cumulative waterfall: stacked bar where the first series is a
 * transparent "base" raising each delta to its running total starting point,
 * and the second series is the visible delta (blue for positive, danger for
 * negative).
 */
export function buildWaterfallOption(rows, { labelKey, valueKey } = {}) {
  if (!labelKey || !valueKey) return { series: [] }
  const deltas = cumulativeDeltas(rows, labelKey, valueKey)
  if (!deltas.length) return { series: [] }

  return {
    textStyle: BASE_TEXT_STYLE,
    tooltip: { ...BASE_TOOLTIP, trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: BASE_GRID,
    xAxis: { type: 'category', data: deltas.map((d) => d.label) },
    yAxis: { type: 'value' },
    series: [
      {
        name: 'Base',
        type: 'bar',
        stack: 'wf',
        itemStyle: { color: 'transparent' },
        emphasis: { itemStyle: { color: 'transparent' } },
        data: deltas.map((d) => d.base),
      },
      {
        name: 'Delta',
        type: 'bar',
        stack: 'wf',
        data: deltas.map((d) => ({
          value: Math.abs(d.value),
          itemStyle: { color: d.value >= 0 ? SAP_BLUE : SAP_DANGER },
        })),
        itemStyle: { borderRadius: [4, 4, 0, 0] },
      },
    ],
  }
}
