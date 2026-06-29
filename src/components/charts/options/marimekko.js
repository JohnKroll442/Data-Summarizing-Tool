import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_PALETTE,
} from '../../../lib/chartColors'

/**
 * Marimekko (mosaic) — variable-width stacked column. Column widths reflect
 * each x-category's share of the total; segment heights reflect each
 * `groupKey` value's share within that column.
 *
 * Implemented as ECharts `custom` series so we can size each rectangle
 * independently.
 */
export function buildMarimekkoOption(rows, { xKey, groupKey, valueKey } = {}) {
  if (!xKey || !groupKey || !rows?.length) return { series: [] }

  const xCats = Array.from(new Set(rows.map((r) => String(r?.[xKey] ?? '')))).filter(Boolean)
  const groups = Array.from(new Set(rows.map((r) => String(r?.[groupKey] ?? '')))).filter(Boolean)
  if (!xCats.length || !groups.length) return { series: [] }

  // matrix[i][j] = value for (xCats[i], groups[j])
  const matrix = xCats.map((x) =>
    groups.map((g) => {
      const matching = rows.filter(
        (r) => String(r?.[xKey]) === x && String(r?.[groupKey]) === g
      )
      if (valueKey) {
        return matching.reduce((s, r) => {
          const n = Number(r?.[valueKey])
          return Number.isFinite(n) ? s + n : s
        }, 0)
      }
      return matching.length
    })
  )
  const colTotals = matrix.map((col) => col.reduce((a, b) => a + b, 0))
  const grandTotal = colTotals.reduce((a, b) => a + b, 0)
  if (grandTotal === 0) return { series: [] }

  // Flatten into [{xStart, xWidth, yStart, yHeight, color, label}] tuples
  // expressed as percent (0..1).
  const tiles = []
  let xCursor = 0
  for (let i = 0; i < xCats.length; i++) {
    const w = colTotals[i] / grandTotal
    let yCursor = 0
    for (let j = 0; j < groups.length; j++) {
      const h = colTotals[i] === 0 ? 0 : matrix[i][j] / colTotals[i]
      tiles.push({
        value: [xCursor, yCursor, w, h, i, j],
      })
      yCursor += h
    }
    xCursor += w
  }

  return {
    color: SAP_PALETTE,
    textStyle: BASE_TEXT_STYLE,
    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'item',
      formatter: (p) => {
        const [, , , , i, j] = p.value
        return `${xCats[i]} · ${groups[j]}: ${matrix[i][j]}`
      },
    },
    legend: {
      bottom: 0,
      textStyle: { color: '#fff' },
      data: groups,
    },
    grid: { ...BASE_GRID, bottom: 56 },
    xAxis: { type: 'value', min: 0, max: 1, show: false },
    yAxis: { type: 'value', min: 0, max: 1, show: false },
    series: [
      {
        type: 'custom',
        renderItem: (params, api) => {
          const xStart = api.value(0)
          const yStart = api.value(1)
          const w = api.value(2)
          const h = api.value(3)
          const j = api.value(5)
          const p1 = api.coord([xStart, yStart])
          const p2 = api.coord([xStart + w, yStart + h])
          return {
            type: 'rect',
            shape: {
              x: Math.min(p1[0], p2[0]),
              y: Math.min(p1[1], p2[1]),
              width: Math.abs(p2[0] - p1[0]) - 1,
              height: Math.abs(p2[1] - p1[1]) - 1,
            },
            style: api.style({
              fill: SAP_PALETTE[j % SAP_PALETTE.length],
              stroke: '#fff',
              lineWidth: 1,
            }),
          }
        },
        data: tiles,
        encode: { tooltip: [4, 5] },
      },
    ],
  }
}
