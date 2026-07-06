import { sumByColumn } from '../../../lib/chartData'
import { formatDurationMs, isDurationColumn } from '../../../lib/format'
import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_GOLD,
} from '../../../lib/chartColors'

/**
 * Pareto — bars sorted descending by frequency, with a cumulative-percentage
 * line on a secondary y-axis.
 */
export function buildParetoOption(rows, { nameKey, valueKey } = {}) {
  if (!nameKey) return { series: [] }
  const raw = valueKey
    ? sumByColumn(rows, nameKey, valueKey)
    : Array.from(
        rows.reduce((acc, r) => {
          const v = r?.[nameKey]
          if (v === undefined || v === null || v === '') return acc
          const k = String(v)
          acc.set(k, (acc.get(k) ?? 0) + 1)
          return acc
        }, new Map()),
        ([name, value]) => ({ name, value })
      )
  if (!raw.length) return { series: [] }
  const sorted = [...raw].sort((a, b) => b.value - a.value)
  const total = sorted.reduce((s, d) => s + d.value, 0) || 1
  let running = 0
  const cumPct = sorted.map((d) => {
    running += d.value
    return Number(((running / total) * 100).toFixed(1))
  })

  const isDur = isDurationColumn(valueKey)
  const fmt = (v) => (Number.isFinite(Number(v)) ? formatDurationMs(v) : '')

  return {
    color: [SAP_BLUE, SAP_GOLD],
    textStyle: BASE_TEXT_STYLE,
    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'axis',
      ...(isDur
        ? {
            valueFormatter: (v, idx) => (idx === 0 ? fmt(v) : `${v}%`),
          }
        : {}),
    },
    legend: { bottom: 0, data: ['Frequency', 'Cumulative %'], textStyle: { color: '#fff' } },
    grid: { ...BASE_GRID, bottom: 56 },
    xAxis: { type: 'category', data: sorted.map((d) => d.name) },
    yAxis: [
      {
        type: 'value',
        ...(isDur ? { axisLabel: { formatter: fmt } } : {}),
      },
      { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
    ],
    series: [
      {
        name: 'Frequency',
        type: 'bar',
        data: sorted.map((d) => d.value),
        itemStyle: { borderRadius: [4, 4, 0, 0] },
      },
      {
        name: 'Cumulative %',
        type: 'line',
        yAxisIndex: 1,
        data: cumPct,
        smooth: false,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { width: 2 },
      },
    ],
  }
}
