import { groupBy } from '../../../lib/chartData'
import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
} from '../../../lib/chartColors'

/**
 * Box plot — one box per `groupKey`, showing 5-number summary of `valueKey`.
 */
export function buildBoxplotOption(rows, { groupKey, valueKey } = {}) {
  if (!groupKey || !valueKey) return { series: [] }
  const grouped = groupBy(rows, groupKey)
  const categories = []
  const data = []
  for (const [name, groupRows] of grouped) {
    const nums = groupRows
      .map((r) => Number(r?.[valueKey]))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
    if (nums.length < 5) continue
    const q = (p) => {
      const idx = (nums.length - 1) * p
      const lo = Math.floor(idx)
      const hi = Math.ceil(idx)
      return lo === hi ? nums[lo] : nums[lo] + (nums[hi] - nums[lo]) * (idx - lo)
    }
    categories.push(name)
    data.push([q(0), q(0.25), q(0.5), q(0.75), q(1)])
  }
  if (!categories.length) return { series: [] }

  return {
    color: [SAP_BLUE],
    textStyle: BASE_TEXT_STYLE,
    tooltip: BASE_TOOLTIP,
    grid: BASE_GRID,
    xAxis: { type: 'category', data: categories },
    yAxis: { type: 'value' },
    series: [{ type: 'boxplot', data, itemStyle: { borderColor: SAP_BLUE } }],
  }
}
