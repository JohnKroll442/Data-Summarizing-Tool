import { countByColumn, sumByColumn } from '../../../lib/chartData'
import { formatDurationMs, isDurationColumn } from '../../../lib/format'
import {
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_PALETTE,
} from '../../../lib/chartColors'

/** Funnel chart — counts by category, sorted descending by default. */
export function buildFunnelOption(rows, { nameKey, valueKey } = {}) {
  if (!nameKey) return { series: [] }
  const data = valueKey ? sumByColumn(rows, nameKey, valueKey) : countByColumn(rows, nameKey)
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
        type: 'funnel',
        left: '10%',
        right: '10%',
        top: 8,
        bottom: 40,
        sort: 'descending',
        gap: 2,
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
