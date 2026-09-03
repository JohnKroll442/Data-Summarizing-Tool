import { formatDurationMs } from '../../../lib/format'
import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_DANGER,
  SAP_GOLD,
  SAP_TEXT_MUTED,
  chartFontSizes,
} from '../../../lib/chartColors'

/**
 * buildActionScatterOption — one bubble per action_name per phase.
 *
 * Answers: "Is slowness frontend-, network-, or backend-driven?"
 *
 * Data is aggregated: each bubble represents ONE action_name, not a single
 * raw row.  The X and Y coordinates are the MEDIAN of all instances of that
 * action so outlier instances don't drag a single point far from the pack.
 * Bubble size encodes instance count — larger bubble = more data, more reliable.
 *
 * Three series, one per exclusive phase metric:
 *   Backend  (SAP red)   — max_backend   (high Y = backend-bound)
 *   Frontend (SAP blue)  — max_frontend  (high Y = render-bound)
 *   Network  (SAP gold)  — max_network   (high Y = network-bound)
 *
 * Reading the chart:
 *   Bubble high on Y, far right on X  → action is slow AND phase-heavy
 *   Bubble far right but low on Y     → total duration is high but this
 *                                       specific phase isn't the culprit
 *
 * Click a legend item to toggle a phase series on/off.
 * Scroll / two-finger swipe to zoom/pan either axis.
 *
 * @param {object[]} rows  aggRows (normalised, one row per action instance)
 */
export function buildActionScatterOption(rows) {
  if (!rows?.length) return { series: [] }

  const sz  = chartFontSizes()
  const fmt = (v) => (Number.isFinite(Number(v)) ? formatDurationMs(v) : '')

  /**
   * Aggregate rows by action_name for a single phase column.
   * Returns one point per action: [medianDuration, medianPhase, name, count]
   * Filters out rows where duration ≤ 0 or phase < 0 (invalid / corrupt data).
   */
  const aggregateByAction = (phaseKey) => {
    const byAction = new Map()
    for (const row of rows) {
      const x    = Number(row?.action_duration)
      const y    = Number(row?.[phaseKey])
      const name = row?.action_name
      if (!name) continue
      if (!Number.isFinite(x) || x <= 0)  continue   // no duration
      if (!Number.isFinite(y) || y < 0)   continue   // reject negative phase values
      if (!byAction.has(name)) byAction.set(name, { xs: [], ys: [] })
      byAction.get(name).xs.push(x)
      byAction.get(name).ys.push(y)
    }

    const pts = []
    for (const [name, { xs, ys }] of byAction) {
      if (!xs.length) continue
      xs.sort((a, b) => a - b)
      ys.sort((a, b) => a - b)
      const medX = xs[Math.floor(xs.length / 2)]
      const medY = ys[Math.floor(ys.length / 2)]
      pts.push([medX, medY, name, xs.length])
    }
    return pts
  }

  const backendPts  = aggregateByAction('max_backend')
  const frontendPts = aggregateByAction('max_frontend')
  const networkPts  = aggregateByAction('max_network')

  if (!backendPts.length && !frontendPts.length && !networkPts.length) {
    return { series: [] }
  }

  // Symbol size scales with sqrt(count) so large-sample actions stand out
  // without drowning small-sample ones entirely.
  const symbolSize = (data) => Math.min(22, 7 + Math.sqrt(data[3] ?? 1) * 1.8)

  const tooltipFmt = (p) => {
    if (!Array.isArray(p?.value)) return ''
    const [duration, phaseTime, actionName, count] = p.value
    return [
      `<strong style="font-size:13px">${actionName ?? ''}</strong>`,
      `<span style="color:${SAP_TEXT_MUTED};font-size:11px">${(count ?? 0).toLocaleString()} instance${count !== 1 ? 's' : ''} (median shown)</span>`,
      `Total duration: <strong>${fmt(duration)}</strong>`,
      `${p.seriesName}: <strong>${fmt(phaseTime)}</strong>`,
    ].join('<br/>')
  }

  return {
    color: [SAP_DANGER, SAP_BLUE, SAP_GOLD],
    textStyle: BASE_TEXT_STYLE,

    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'item',
      formatter: tooltipFmt,
    },

    legend: {
      top:  4,
      right: 8,
      data: ['Backend', 'Frontend', 'Network'],
      textStyle: { ...BASE_TEXT_STYLE, fontSize: sz.legend },
    },

    grid: {
      ...BASE_GRID,
      top: 40,
      containLabel: true,
    },

    // Two-axis zoom: scroll horizontally or vertically to focus on a region.
    // No visible sliders — use mouse wheel or two-finger trackpad gestures.
    dataZoom: [
      { type: 'inside', xAxisIndex: 0 },
      { type: 'inside', yAxisIndex: 0, orient: 'vertical' },
    ],

    xAxis: {
      type: 'value',
      name: 'Median Total Duration',
      nameLocation: 'middle',
      nameGap: 36,
      nameTextStyle: { fontSize: sz.axisName, color: BASE_TEXT_STYLE.color },
      axisLabel: { fontSize: sz.axis, color: BASE_TEXT_STYLE.color, formatter: fmt },
      splitLine: { lineStyle: { color: '#eef0f3' } },
    },

    yAxis: {
      type: 'value',
      name: 'Median Phase Time',
      nameLocation: 'middle',
      nameGap: 60,
      nameTextStyle: { fontSize: sz.axisName, color: BASE_TEXT_STYLE.color },
      axisLabel: { fontSize: sz.axis, color: BASE_TEXT_STYLE.color, formatter: fmt },
      splitLine: { lineStyle: { color: '#eef0f3' } },
      // Clamp at zero — negative phase times are invalid
      min: 0,
    },

    series: [
      {
        name:       'Backend',
        type:       'scatter',
        symbolSize,
        data:       backendPts,
        itemStyle:  { color: SAP_DANGER, opacity: 0.75 },
        emphasis:   { scale: 1.4, itemStyle: { opacity: 1 } },
      },
      {
        name:       'Frontend',
        type:       'scatter',
        symbolSize,
        data:       frontendPts,
        itemStyle:  { color: SAP_BLUE, opacity: 0.75 },
        emphasis:   { scale: 1.4, itemStyle: { opacity: 1 } },
      },
      {
        name:       'Network',
        type:       'scatter',
        symbolSize,
        data:       networkPts,
        itemStyle:  { color: SAP_GOLD, opacity: 0.75 },
        emphasis:   { scale: 1.4, itemStyle: { opacity: 1 } },
      },
    ],
  }
}

