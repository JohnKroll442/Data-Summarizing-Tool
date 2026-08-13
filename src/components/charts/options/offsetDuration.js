import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_GOLD,
  SAP_DANGER,
  SAP_TEXT,
  SAP_TEXT_MUTED,
  chartFontSizes,
} from '../../../lib/chartColors'
import { formatDurationMs } from '../../../lib/format'

/**
 * Offset vs Duration scatter — one dot per action instance:
 *   X = action duration, Y = max widget offset (pre-render wait).
 * Both axes are logarithmic because the values span milliseconds → minutes (the
 * same wide dynamic range that forced the heatmap onto a log scale); a linear
 * scale crushes everything small into the corner.
 *
 * The anomaly rule IS a line: offset = duration. A dashed y = x diagonal is
 * drawn so anything ABOVE it reads instantly as an overrun (offset > duration —
 * impossible timing) without reading a number. Classes match the table's offset
 * flags (see classifyOffsetPoint): healthy (blue), large offset (gold, hugging
 * the diagonal), overrun (red triangle — a distinct SHAPE so it's never
 * color-alone). Data points come from buildOffsetDurationPoints.
 */

// The three classes, loud → quiet, each with its SAP status color + marker.
// `ok` uses SAP blue (the app's primary series color) rather than a status green
// because "healthy" here is the neutral baseline, not a positive signal.
export const OFFSET_CLASS_LEGEND = [
  { klass: 'overrun', name: 'Overrun',      color: SAP_DANGER, symbol: 'triangle' },
  { klass: 'large',   name: 'Large offset', color: SAP_GOLD,   symbol: 'circle' },
  { klass: 'ok',      name: 'Healthy',      color: SAP_BLUE,   symbol: 'circle' },
]

const fmt = (v) => (Number.isFinite(Number(v)) ? formatDurationMs(v) : '')

// Largest power of ten ≤ v (≥ 1) — the log-axis floor. Zero/tiny offsets clamp
// here so every point stays visible on a log scale.
function floorPow10(v) {
  if (!(v > 0)) return 1
  return Math.max(1, Math.pow(10, Math.floor(Math.log10(v))))
}
// Smallest power of ten ≥ v — the log-axis ceiling.
function ceilPow10(v) {
  if (!(v > 0)) return 10
  return Math.pow(10, Math.ceil(Math.log10(v)))
}

export function buildOffsetDurationOption({ points } = {}) {
  if (!points?.length) return emptyOption('No actions with an offset to plot.')

  const f = chartFontSizes()

  // Axis bounds from the data: floor to a decade below the smallest positive
  // value, ceil to a decade above the largest, across BOTH coordinates so the
  // diagonal is a true 45° line.
  let minPos = Infinity
  let max = 0
  for (const p of points) {
    for (const v of [p.duration, p.maxOffset]) {
      if (Number.isFinite(v) && v > 0) {
        if (v < minPos) minPos = v
        if (v > max) max = v
      }
    }
  }
  const axisMin = floorPow10(Number.isFinite(minPos) ? minPos : 1)
  const axisMax = ceilPow10(max || axisMin * 10)

  // Clamp the plotted Y to the floor (a 0-offset "no wait" point sits on the
  // baseline) while the tooltip still shows the true value.
  const toDatum = (p) => ({
    value: [Math.max(p.duration, axisMin), Math.max(p.maxOffset, axisMin)],
    action: p.action,
    story: p.story,
    user: p.user,
    timestamp: p.timestamp,
    duration: p.duration,
    maxOffset: p.maxOffset,
  })

  const scatter = OFFSET_CLASS_LEGEND.map((c) => ({
    name: c.name,
    type: 'scatter',
    symbol: c.symbol,
    symbolSize: c.klass === 'overrun' ? 13 : 10,
    itemStyle: {
      color: c.color,
      opacity: c.klass === 'ok' ? 0.8 : 0.95,
      borderColor: '#fff',
      borderWidth: 1,
    },
    z: c.klass === 'overrun' ? 4 : c.klass === 'large' ? 3 : 2,
    data: points.filter((p) => p.klass === c.klass).map(toDatum),
  }))

  return {
    textStyle: BASE_TEXT_STYLE,
    legend: {
      top: 4,
      textStyle: { color: SAP_TEXT, fontSize: f.legend },
      data: ['offset = duration', ...OFFSET_CLASS_LEGEND.map((c) => c.name)],
    },
    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'item',
      formatter: (p) => {
        const d = p?.data
        if (!d || typeof d !== 'object' || !Array.isArray(d.value)) return ''
        return [
          `<strong>${escape(d.action)}</strong>`,
          d.story ? `Story: ${escape(d.story)}` : '',
          `Duration: ${fmt(d.duration)}`,
          `Max widget offset: ${fmt(d.maxOffset)}`,
        ].filter(Boolean).join('<br/>')
      },
    },
    grid: { ...BASE_GRID, top: 44, left: 76, right: 32, bottom: 56 },
    xAxis: {
      type: 'log',
      name: 'Action duration',
      nameLocation: 'middle',
      nameGap: 36,
      min: axisMin,
      max: axisMax,
      nameTextStyle: { fontSize: f.axisName, color: SAP_TEXT },
      axisLabel: { formatter: fmt, color: SAP_TEXT_MUTED, fontSize: f.axis },
      splitLine: { lineStyle: { color: '#e6ecf2' } },
    },
    yAxis: {
      type: 'log',
      name: 'Max widget offset',
      nameLocation: 'middle',
      nameGap: 68,
      min: axisMin,
      max: axisMax,
      nameTextStyle: { fontSize: f.axisName, color: SAP_TEXT },
      axisLabel: { formatter: fmt, color: SAP_TEXT_MUTED, fontSize: f.axis },
      splitLine: { lineStyle: { color: '#e6ecf2' } },
    },
    series: [
      {
        // The offset = duration diagonal: a non-interactive dashed backdrop.
        // Above it → offset exceeds duration → overrun.
        name: 'offset = duration',
        type: 'line',
        data: [[axisMin, axisMin], [axisMax, axisMax]],
        showSymbol: false,
        silent: true,
        z: 1,
        lineStyle: { type: 'dashed', color: '#9aa8b6', width: 1.5 },
        tooltip: { show: false },
      },
      ...scatter,
    ],
  }
}

/* ——— helpers ——— */

function emptyOption(note) {
  return {
    textStyle: BASE_TEXT_STYLE,
    title: {
      text: note ?? 'Nothing to plot.',
      left: 'center',
      top: 'middle',
      textStyle: { color: SAP_TEXT_MUTED, fontWeight: 400, fontSize: 13 },
    },
    series: [],
  }
}

function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
