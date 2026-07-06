import { numericPairs, numericTriples } from '../../../lib/chartData'
import { formatDurationMs, isDurationColumn } from '../../../lib/format'
import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
} from '../../../lib/chartColors'

const fmt = (v) => (Number.isFinite(Number(v)) ? formatDurationMs(v) : '')

/** Standard scatter. */
export function buildScatterOption(rows, { xKey, yKey } = {}) {
  if (!xKey || !yKey) return { series: [] }
  const xIsDur = isDurationColumn(xKey)
  const yIsDur = isDurationColumn(yKey)
  return {
    color: [SAP_BLUE],
    textStyle: BASE_TEXT_STYLE,
    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'item',
      ...(xIsDur || yIsDur
        ? {
            formatter: (p) => {
              const [x, y] = p.value
              const xStr = xIsDur ? fmt(x) : String(x)
              const yStr = yIsDur ? fmt(y) : String(y)
              return `${xKey}: ${xStr}<br/>${yKey}: ${yStr}`
            },
          }
        : {}),
    },
    grid: BASE_GRID,
    xAxis: {
      type: 'value',
      name: xKey,
      ...(xIsDur ? { axisLabel: { formatter: fmt } } : {}),
    },
    yAxis: {
      type: 'value',
      name: yKey,
      ...(yIsDur ? { axisLabel: { formatter: fmt } } : {}),
    },
    series: [{ type: 'scatter', symbolSize: 9, data: numericPairs(rows, xKey, yKey) }],
  }
}

/** Bubble — scatter with a third numeric column driving point size. */
export function buildBubbleOption(rows, { xKey, yKey, sizeKey } = {}) {
  if (!xKey || !yKey) return { series: [] }
  const triples = numericTriples(rows, xKey, yKey, sizeKey)
  if (!triples.length) return { series: [] }
  const maxSize = Math.max(...triples.map((t) => t[2])) || 1
  const xIsDur = isDurationColumn(xKey)
  const yIsDur = isDurationColumn(yKey)
  const sizeIsDur = isDurationColumn(sizeKey)
  return {
    color: [SAP_BLUE],
    textStyle: BASE_TEXT_STYLE,
    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'item',
      ...(xIsDur || yIsDur || sizeIsDur
        ? {
            formatter: (p) => {
              const [x, y, s] = p.value
              const parts = [
                `${xKey}: ${xIsDur ? fmt(x) : String(x)}`,
                `${yKey}: ${yIsDur ? fmt(y) : String(y)}`,
              ]
              if (sizeKey) parts.push(`${sizeKey}: ${sizeIsDur ? fmt(s) : String(s)}`)
              return parts.join('<br/>')
            },
          }
        : {}),
    },
    grid: BASE_GRID,
    xAxis: {
      type: 'value',
      name: xKey,
      ...(xIsDur ? { axisLabel: { formatter: fmt } } : {}),
    },
    yAxis: {
      type: 'value',
      name: yKey,
      ...(yIsDur ? { axisLabel: { formatter: fmt } } : {}),
    },
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
