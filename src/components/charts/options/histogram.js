import { bin } from '../../../lib/chartData'
import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
} from '../../../lib/chartColors'

/** Histogram — bins values of `key` into `binCount` equal-width buckets. */
export function buildHistogramOption(rows, { key, binCount = 10 } = {}) {
  if (!key) return { series: [] }
  const bins = bin(rows, key, binCount)
  return {
    color: [SAP_BLUE],
    textStyle: BASE_TEXT_STYLE,
    tooltip: { ...BASE_TOOLTIP, trigger: 'axis' },
    grid: BASE_GRID,
    xAxis: { type: 'category', data: bins.map((b) => b.name), axisLabel: { rotate: 30, fontSize: 10 } },
    yAxis: { type: 'value' },
    series: [
      {
        type: 'bar',
        barCategoryGap: '5%',
        data: bins.map((b) => b.value),
        itemStyle: { borderRadius: [3, 3, 0, 0] },
      },
    ],
  }
}
