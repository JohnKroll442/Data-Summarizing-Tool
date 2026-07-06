import { countByColumn, sumByColumn } from '../../../lib/chartData'
import { formatDurationMs, isDurationColumn } from '../../../lib/format'
import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_GOLD,
  SAP_PALETTE,
} from '../../../lib/chartColors'

/** Format a duration value for axis/tooltip; passes non-finite through as ''. */
function fmtDurTick(v) {
  const n = Number(v)
  return Number.isFinite(n) ? formatDurationMs(n) : ''
}

/**
 * Bar (column) chart. If `valueKey` is provided, sums it grouped by `xKey`;
 * otherwise counts rows per `xKey` value. Pass `stacked: true` for stacked
 * bars (requires a `groupKey` to define the stack series).
 */
export function buildBarOption(rows, { xKey, yKey, groupKey, stacked = false } = {}) {
  if (!xKey) return emptyOption()

  const yIsDuration = isDurationColumn(yKey)

  if (!stacked || !groupKey) {
    const data = yKey ? sumByColumn(rows, xKey, yKey) : countByColumn(rows, xKey)
    return {
      color: [SAP_BLUE],
      textStyle: BASE_TEXT_STYLE,
      tooltip: {
        ...BASE_TOOLTIP,
        trigger: 'axis',
        ...(yIsDuration
          ? { valueFormatter: (v) => fmtDurTick(v) }
          : {}),
      },
      grid: BASE_GRID,
      xAxis: { type: 'category', data: data.map((d) => d.name) },
      yAxis: {
        type: 'value',
        ...(yIsDuration
          ? { axisLabel: { formatter: (v) => fmtDurTick(v) } }
          : {}),
      },
      series: [
        {
          type: 'bar',
          data: data.map((d) => d.value),
          itemStyle: { borderRadius: [4, 4, 0, 0] },
        },
      ],
    }
  }

  // Stacked: pivot rows into series keyed by groupKey value
  const xCats = Array.from(new Set(rows.map((r) => String(r?.[xKey] ?? ''))))
    .filter((v) => v !== '')
  const groups = Array.from(new Set(rows.map((r) => String(r?.[groupKey] ?? ''))))
    .filter((v) => v !== '')

  const series = groups.map((g, i) => ({
    name: g,
    type: 'bar',
    stack: 'total',
    itemStyle: { color: SAP_PALETTE[i % SAP_PALETTE.length] },
    data: xCats.map((cat) => {
      const matching = rows.filter(
        (r) => String(r?.[xKey]) === cat && String(r?.[groupKey]) === g
      )
      if (yKey) {
        return matching.reduce((sum, r) => {
          const n = Number(r?.[yKey])
          return Number.isFinite(n) ? sum + n : sum
        }, 0)
      }
      return matching.length
    }),
  }))

  return {
    color: SAP_PALETTE,
    textStyle: BASE_TEXT_STYLE,
    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...(yIsDuration ? { valueFormatter: (v) => fmtDurTick(v) } : {}),
    },
    legend: { bottom: 0, textStyle: { color: '#fff' } },
    grid: { ...BASE_GRID, bottom: 56 },
    xAxis: { type: 'category', data: xCats },
    yAxis: {
      type: 'value',
      ...(yIsDuration ? { axisLabel: { formatter: (v) => fmtDurTick(v) } } : {}),
    },
    series,
  }
}

/** Combination column + line — useful when one metric is a count, the other a derived value. */
export function buildComboOption(rows, { xKey, barKey, lineKey } = {}) {
  if (!xKey || !barKey || !lineKey) return emptyOption()
  const xCats = Array.from(new Set(rows.map((r) => String(r?.[xKey] ?? ''))))
    .filter((v) => v !== '')
  const bar = xCats.map((cat) =>
    rows
      .filter((r) => String(r?.[xKey]) === cat)
      .reduce((s, r) => {
        const n = Number(r?.[barKey])
        return Number.isFinite(n) ? s + n : s
      }, 0)
  )
  const line = xCats.map((cat) =>
    rows
      .filter((r) => String(r?.[xKey]) === cat)
      .reduce((s, r) => {
        const n = Number(r?.[lineKey])
        return Number.isFinite(n) ? s + n : s
      }, 0)
  )
  const barIsDur = isDurationColumn(barKey)
  const lineIsDur = isDurationColumn(lineKey)
  return {
    color: [SAP_BLUE, SAP_GOLD],
    textStyle: BASE_TEXT_STYLE,
    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'axis',
      ...(barIsDur || lineIsDur
        ? {
            valueFormatter: (v, idx) => {
              const isDur = idx === 0 ? barIsDur : lineIsDur
              return isDur ? fmtDurTick(v) : String(v)
            },
          }
        : {}),
    },
    legend: { bottom: 0, data: [barKey, lineKey], textStyle: { color: '#fff' } },
    grid: { ...BASE_GRID, bottom: 56 },
    xAxis: { type: 'category', data: xCats },
    yAxis: [
      {
        type: 'value',
        ...(barIsDur ? { axisLabel: { formatter: (v) => fmtDurTick(v) } } : {}),
      },
      {
        type: 'value',
        ...(lineIsDur ? { axisLabel: { formatter: (v) => fmtDurTick(v) } } : {}),
      },
    ],
    series: [
      { name: barKey, type: 'bar', data: bar, itemStyle: { borderRadius: [4, 4, 0, 0] } },
      { name: lineKey, type: 'line', yAxisIndex: 1, data: line, smooth: true, lineStyle: { width: 3 } },
    ],
  }
}

function emptyOption() {
  return { series: [] }
}
