import { formatDurationMs, isDurationColumn } from '../../../lib/format'
import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE_LIGHT,
  SAP_BLUE_DARKER,
} from '../../../lib/chartColors'

/**
 * Heatmap — crosstab of `xKey` × `yKey` colored by count (or sum(valueKey)).
 */
export function buildHeatmapOption(rows, { xKey, yKey, valueKey } = {}) {
  if (!xKey || !yKey || !rows?.length) return { series: [] }

  const xCats = Array.from(new Set(rows.map((r) => String(r?.[xKey] ?? '')))).filter(Boolean)
  const yCats = Array.from(new Set(rows.map((r) => String(r?.[yKey] ?? '')))).filter(Boolean)
  if (!xCats.length || !yCats.length) return { series: [] }

  const data = []
  let maxValue = 0
  for (let xi = 0; xi < xCats.length; xi++) {
    for (let yi = 0; yi < yCats.length; yi++) {
      const matching = rows.filter(
        (r) => String(r?.[xKey]) === xCats[xi] && String(r?.[yKey]) === yCats[yi]
      )
      const v = valueKey
        ? matching.reduce((s, r) => {
            const n = Number(r?.[valueKey])
            return Number.isFinite(n) ? s + n : s
          }, 0)
        : matching.length
      if (v > maxValue) maxValue = v
      data.push([xi, yi, v])
    }
  }

  const isDur = isDurationColumn(valueKey)
  const fmt = (v) => (Number.isFinite(Number(v)) ? formatDurationMs(v) : '')

  return {
    textStyle: BASE_TEXT_STYLE,
    tooltip: {
      ...BASE_TOOLTIP,
      position: 'top',
      ...(isDur
        ? {
            formatter: (p) => {
              const [xi, yi, v] = p.value
              return `${xCats[xi]} · ${yCats[yi]}: ${fmt(v)}`
            },
          }
        : {}),
    },
    grid: { ...BASE_GRID, top: 16, bottom: 56 },
    xAxis: { type: 'category', data: xCats, splitArea: { show: true } },
    yAxis: { type: 'category', data: yCats, splitArea: { show: true } },
    visualMap: {
      min: 0,
      max: maxValue || 1,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 4,
      inRange: { color: [SAP_BLUE_LIGHT, SAP_BLUE_DARKER] },
      textStyle: { color: '#1d2d3e' },
      ...(isDur ? { formatter: fmt } : {}),
    },
    series: [
      {
        type: 'heatmap',
        data,
        label: { show: false },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.4)' } },
      },
    ],
  }
}
