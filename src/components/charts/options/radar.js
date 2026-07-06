import { groupBy } from '../../../lib/chartData'
import { formatDurationMs, isDurationColumn } from '../../../lib/format'
import {
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_PALETTE,
} from '../../../lib/chartColors'

/**
 * Radar chart. Each `groupKey` value becomes one polygon; `indicatorKeys`
 * are the axis labels (one per column to plot).
 */
export function buildRadarOption(rows, { groupKey, indicatorKeys = [] } = {}) {
  if (!groupKey || indicatorKeys.length === 0) return { series: [] }

  // Find max per indicator to normalize the radar axes
  const maxes = indicatorKeys.map((k) => {
    const nums = rows
      .map((r) => Number(r?.[k]))
      .filter((n) => Number.isFinite(n))
    return nums.length ? Math.max(...nums) : 1
  })

  const indicator = indicatorKeys.map((k, i) => ({
    name: k,
    max: maxes[i] || 1,
  }))

  const grouped = groupBy(rows, groupKey)
  const series = [
    {
      type: 'radar',
      data: Array.from(grouped, ([name, groupRows], i) => ({
        name,
        value: indicatorKeys.map((k) => {
          const nums = groupRows
            .map((r) => Number(r?.[k]))
            .filter((n) => Number.isFinite(n))
          return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
        }),
        itemStyle: { color: SAP_PALETTE[i % SAP_PALETTE.length] },
        areaStyle: { color: SAP_PALETTE[i % SAP_PALETTE.length], opacity: 0.2 },
      })),
    },
  ]

  const durFlags = indicatorKeys.map((k) => isDurationColumn(k))
  const anyDur = durFlags.some(Boolean)

  return {
    color: [SAP_BLUE],
    textStyle: BASE_TEXT_STYLE,
    tooltip: {
      ...BASE_TOOLTIP,
      ...(anyDur
        ? {
            formatter: (p) => {
              const lines = [p.name]
              const values = Array.isArray(p.value) ? p.value : [p.value]
              indicatorKeys.forEach((k, i) => {
                const v = values[i]
                const disp = durFlags[i] ? formatDurationMs(v) : String(v)
                lines.push(`${k}: ${disp}`)
              })
              return lines.join('<br/>')
            },
          }
        : {}),
    },
    legend: { bottom: 0, textStyle: { color: '#fff' } },
    radar: { indicator, axisName: { color: '#1d2d3e', fontSize: 11 } },
    series,
  }
}
