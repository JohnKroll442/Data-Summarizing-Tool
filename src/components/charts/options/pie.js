import { countByColumn, sumByColumn } from '../../../lib/chartData'
import { formatDurationMs, isDurationColumn } from '../../../lib/format'
import {
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_PALETTE,
} from '../../../lib/chartColors'

/**
 * Pie or donut chart. Pass `donut: true` for a donut hole.
 * Counts rows per `nameKey` unless `valueKey` is supplied (then sums).
 */
export function buildPieOption(rows, { nameKey, valueKey, donut = false } = {}) {
  if (!nameKey) return { series: [] }
  const data = valueKey
    ? sumByColumn(rows, nameKey, valueKey)
    : countByColumn(rows, nameKey)

  const isDur = isDurationColumn(valueKey)

  return {
    color: SAP_PALETTE,
    textStyle: BASE_TEXT_STYLE,
    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'item',
      ...(isDur
        ? {
            formatter: (p) => `${p.name}: ${formatDurationMs(p.value)} (${p.percent}%)`,
          }
        : {}),
    },
    legend: { bottom: 0, textStyle: { color: '#fff' }, type: 'scroll' },
    series: [
      {
        type: 'pie',
        radius: donut ? ['45%', '70%'] : '70%',
        center: ['50%', '46%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: {
          color: '#1d2d3e',
          ...(isDur
            ? { formatter: (p) => `${p.name}: ${formatDurationMs(p.value)}` }
            : {}),
        },
        data,
      },
    ],
  }
}

export function buildDonutOption(rows, opts = {}) {
  return buildPieOption(rows, { ...opts, donut: true })
}
