import { numericPairs, numericTriples } from '../../../lib/chartData'
import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
} from '../../../lib/chartColors'

/** Standard scatter. */
export function buildScatterOption(rows, { xKey, yKey } = {}) {
  if (!xKey || !yKey) return { series: [] }
  return {
    color: [SAP_BLUE],
    textStyle: BASE_TEXT_STYLE,
    tooltip: { ...BASE_TOOLTIP, trigger: 'item' },
    grid: BASE_GRID,
    xAxis: { type: 'value', name: xKey },
    yAxis: { type: 'value', name: yKey },
    series: [{ type: 'scatter', symbolSize: 9, data: numericPairs(rows, xKey, yKey) }],
  }
}

/** Bubble — scatter with a third numeric column driving point size. */
export function buildBubbleOption(rows, { xKey, yKey, sizeKey } = {}) {
  if (!xKey || !yKey) return { series: [] }
  const triples = numericTriples(rows, xKey, yKey, sizeKey)
  if (!triples.length) return { series: [] }
  const maxSize = Math.max(...triples.map((t) => t[2])) || 1
  return {
    color: [SAP_BLUE],
    textStyle: BASE_TEXT_STYLE,
    tooltip: { ...BASE_TOOLTIP, trigger: 'item' },
    grid: BASE_GRID,
    xAxis: { type: 'value', name: xKey },
    yAxis: { type: 'value', name: yKey },
    series: [
      {
        type: 'scatter',
        data: triples,
        symbolSize: (val) => 8 + 32 * (val[2] / maxSize),
        itemStyle: { opacity: 0.7 },
      },
    ],
  }
}
