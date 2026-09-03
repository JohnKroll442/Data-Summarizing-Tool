import { sumByColumn } from '../../../lib/chartData'
import { formatDurationMs } from '../../../lib/format'
import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_GOLD,
  chartFontSizes,
} from '../../../lib/chartColors'

/**
 * buildActionParetoOption — bars sorted descending by total action_duration,
 * with a cumulative-% line on a secondary Y-axis.
 *
 * Answers: "Which actions are responsible for the bulk of time?"
 *
 * The bar height is the SUM of all recorded durations for that action (total
 * wall-clock time consumed), not the count of occurrences. The cumulative line
 * reveals the 80/20 point — if 2-3 actions hit 80 %, optimising just those
 * delivers the biggest win.
 *
 * Axis labels and tooltip values are formatted as human-readable durations
 * (ms / s / m) because action_duration is a millisecond column.
 *
 * @param {object[]} rows   aggRows (normalised, one row per action instance)
 * @param {object}   opts
 * @param {number}   opts.topN  Max number of bars to show (default 15)
 */
export function buildActionParetoOption(rows, { topN = 15 } = {}) {
  if (!rows?.length) return { series: [] }

  const sz  = chartFontSizes()
  const fmt = (v) => (Number.isFinite(Number(v)) ? formatDurationMs(v) : '')

  // Sum total action_duration per action_name (not count — we want time, not frequency)
  const raw = sumByColumn(rows, 'action_name', 'action_duration')
  if (!raw.length) return { series: [] }

  const sorted = [...raw]
    .sort((a, b) => b.value - a.value)
    .slice(0, topN)

  const total = sorted.reduce((s, d) => s + d.value, 0) || 1
  let running = 0
  const cumPct = sorted.map((d) => {
    running += d.value
    return Number(((running / total) * 100).toFixed(1))
  })

  return {
    color: [SAP_BLUE, SAP_GOLD],
    textStyle: BASE_TEXT_STYLE,

    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params) => {
        if (!params?.length) return ''
        const bar  = params.find((p) => p.seriesName === 'Total Duration')
        const line = params.find((p) => p.seriesName === 'Cumulative %')
        if (!bar) return ''
        return [
          `<strong style="font-size:13px">${bar.name}</strong>`,
          `Total duration: <strong>${fmt(bar.value)}</strong>`,
          line != null
            ? `Cumulative:&nbsp;&nbsp;&nbsp;<strong>${line.value}%</strong>`
            : '',
        ].filter(Boolean).join('<br/>')
      },
    },

    legend: {
      bottom: 0,
      data: ['Total Duration', 'Cumulative %'],
      // Use BASE_TEXT_STYLE color so legend text is visible on white backgrounds.
      // (The generic buildParetoOption hard-codes '#fff' which is invisible here.)
      textStyle: { ...BASE_TEXT_STYLE, fontSize: sz.legend },
    },

    // Inside dataZoom lets the user pan/scroll through actions without a
    // visible slider. Hold shift+scroll, or use two-finger swipe on a trackpad.
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, zoomOnMouseWheel: 'shift' },
    ],

    grid: {
      ...BASE_GRID,
      bottom: 72,   // rotated x-axis labels + legend
      top:    24,   // no bar-top labels — tooltip handles the values
      containLabel: true,
    },

    xAxis: {
      type: 'category',
      data: sorted.map((d) => d.name),
      axisLabel: {
        fontSize:  sz.axis,
        color:     BASE_TEXT_STYLE.color,
        rotate:    35,
        interval:  0,
        formatter: (v) => (v.length > 22 ? `${v.slice(0, 20)}\u2026` : v),
      },
    },

    yAxis: [
      {
        type: 'value',

        axisLabel: {
          fontSize:  sz.axis,
          color:     BASE_TEXT_STYLE.color,
          formatter: fmt,
        },
        splitLine: { lineStyle: { color: '#eef0f3' } },
      },
      {
        type: 'value',
        max: 100,
        axisLabel: {
          fontSize:  sz.axis,
          color:     BASE_TEXT_STYLE.color,
          formatter: '{value}%',
        },
        splitLine: { show: false },
      },
    ],

    series: [
      {
        name: 'Total Duration',
        type: 'bar',
        data: sorted.map((d) => d.value),
        itemStyle: {
          color:        SAP_BLUE,
          borderRadius: [4, 4, 0, 0],
        },
        emphasis: {
          itemStyle: { color: SAP_BLUE, opacity: 0.85 },
        },
        // No bar-top labels — with 10-15 bars they overlap badly.
        // Hover the bar to see the exact value in the tooltip.
      },
      {
        name: 'Cumulative %',
        type: 'line',
        yAxisIndex: 1,
        data: cumPct,
        smooth: false,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { color: SAP_GOLD, width: 2 },
        itemStyle: { color: SAP_GOLD },
        label: {
          show:      true,
          position:  'top',
          fontSize:  sz.barLabel,
          color:     SAP_GOLD,
          formatter: (p) => `${p.value}%`,
        },
      },
    ],
  }
}

