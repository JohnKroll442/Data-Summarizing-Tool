import { countByColumn, sumByColumn } from '../../../lib/chartData'
import { formatDurationMs, isDurationColumn } from '../../../lib/format'
import {
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_PALETTE,
} from '../../../lib/chartColors'

/** Treemap — each row category becomes a tile sized by count or sum(valueKey). */
export function buildTreemapOption(rows, { nameKey, valueKey } = {}) {
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
            formatter: (p) => `${p.name}: ${formatDurationMs(p.value)}`,
          }
        : {}),
    },
    series: [
      {
        type: 'treemap',
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        label: {
          show: true,
          formatter: isDur
            ? (p) => `${p.name}\n${formatDurationMs(p.value)}`
            : '{b}\n{c}',
          color: '#fff',
          fontSize: 12,
        },
        upperLabel: { show: false },
        itemStyle: { borderColor: '#fff', borderWidth: 2, gapWidth: 2 },
        data,
      },
    ],
  }
}
