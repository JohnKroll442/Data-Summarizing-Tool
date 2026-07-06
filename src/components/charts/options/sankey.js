import { toSankeyShape } from '../../../lib/chartData'
import { formatDurationMs, isDurationColumn } from '../../../lib/format'
import {
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_PALETTE,
} from '../../../lib/chartColors'

/** Sankey diagram. `valueKey` is optional — if omitted, each row counts as 1. */
export function buildSankeyOption(rows, { sourceKey, targetKey, valueKey } = {}) {
  if (!sourceKey || !targetKey) return { series: [] }
  const { nodes, links } = toSankeyShape(rows, sourceKey, targetKey, valueKey)
  if (!nodes.length || !links.length) return { series: [] }

  const isDur = isDurationColumn(valueKey)

  return {
    color: SAP_PALETTE,
    textStyle: BASE_TEXT_STYLE,
    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'item',
      ...(isDur
        ? {
            formatter: (p) => {
              if (p.dataType === 'edge') {
                const d = p.data
                return `${d.source} → ${d.target}: ${formatDurationMs(d.value)}`
              }
              return p.name
            },
          }
        : {}),
    },
    series: [
      {
        type: 'sankey',
        data: nodes,
        links,
        emphasis: { focus: 'adjacency' },
        lineStyle: { color: 'gradient', curveness: 0.5 },
        label: { color: '#1d2d3e', fontSize: 11 },
      },
    ],
  }
}
