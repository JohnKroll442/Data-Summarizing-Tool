import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_GOLD,
  SAP_BLUE_LIGHT,
  SAP_SUCCESS,
  SAP_TEXT,
  SAP_TEXT_MUTED,
  chartFontSizes,
} from '../../../lib/chartColors'
import { formatDurationMs } from '../../../lib/format'

const fmt = (v) => (Number.isFinite(Number(v)) ? formatDurationMs(v) : '—')

function labelOf(bucket) {
  return bucket.label ?? ''
}

function fullLabelOf(bucket) {
  return bucket.fullLabel ?? bucket.label ?? ''
}

export function buildActivityTimelineOption({ buckets, series, actionDurations, legendSelected } = {}) {
  if (!buckets?.length) return emptyOption('No activity data to plot.')

  const f = chartFontSizes()
  const labels = buckets.map((b) => labelOf(b))
  const n = buckets.length

  // Extract series data
  const sessionCounts = series?.sessions ?? new Array(n).fill(0)
  const actionCounts = series?.actions ?? new Array(n).fill(0)
  const widgetCounts = series?.widgets ?? new Array(n).fill(0)

  // Extract p50/p90 from actionDurations
  const p50 = new Array(n).fill(null)
  const p90 = new Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    const dur = actionDurations?.[i]
    if (dur) {
      p50[i] = dur.p50
      p90[i] = dur.p90
    }
  }

  const bandBase = p50.map((v) => v)
  const bandTop = p50.map((v, i) => {
    if (v == null || p90[i] == null) return null
    return p90[i] - v
  })

  // Click targets for drillable time buckets (where actions exist)
  const hitAreas = buckets
    .map((b, i) => (actionCounts[i] > 0 ? [{ name: String(i), xAxis: labels[i] }, { xAxis: labels[i] }] : null))
    .filter(Boolean)

  return {
    textStyle: BASE_TEXT_STYLE,
    legend: {
      top: 4,
      textStyle: { color: SAP_TEXT, fontSize: f.legend },
      data: ['Sessions', 'Actions', 'Widgets', 'p50', 'p90', 'Spread'],
      ...(legendSelected ? { selected: legendSelected } : {}),
    },
    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'line' },
      padding: [12, 16],
      textStyle: { ...BASE_TOOLTIP.textStyle, fontSize: 15, lineHeight: 22 },
      extraCssText: 'min-width: 190px; box-shadow: 0 6px 20px rgba(0,0,0,0.16);',
      formatter: (params) => {
        const idx = Array.isArray(params) ? params[0]?.dataIndex : params?.dataIndex
        const b = buckets[idx]
        if (!b) return ''
        const header = `<strong>${fullLabelOf(b)}</strong>`
        const lines = [header]
        lines.push(`Sessions: ${sessionCounts[idx] ?? 0}`)
        lines.push(`Actions: ${actionCounts[idx] ?? 0}`)
        lines.push(`Widgets: ${widgetCounts[idx] ?? 0}`)
        if (actionDurations?.[idx]) {
          if (actionDurations[idx].p50 != null) {
            lines.push(`p50: ${fmt(actionDurations[idx].p50)}`)
          }
          if (actionDurations[idx].p90 != null) {
            lines.push(`p90: ${fmt(actionDurations[idx].p90)}`)
          }
        }
        return lines.join('<br/>')
      },
    },
    grid: { ...BASE_GRID, top: 44, left: 92, right: 72, bottom: 56 },
    xAxis: {
      type: 'category',
      data: labels,
      boundaryGap: true,
      axisLabel: { color: SAP_TEXT_MUTED, fontSize: f.axis, hideOverlap: true },
      axisTick: { alignWithLabel: true },
    },
    yAxis: [
      {
        type: 'value',
        name: 'Duration',
        nameLocation: 'middle',
        nameGap: 74,
        nameTextStyle: { fontSize: f.axisName, color: SAP_TEXT },
        axisLabel: { formatter: fmt, color: SAP_TEXT_MUTED, fontSize: f.axis },
        splitLine: { lineStyle: { color: '#e6ecf2' } },
      },
      {
        type: 'value',
        name: 'Count',
        nameLocation: 'middle',
        nameGap: 52,
        min: 0,
        nameTextStyle: { fontSize: f.axisName, color: SAP_TEXT_MUTED },
        axisLabel: { color: SAP_TEXT_MUTED, fontSize: f.axis, showMinLabel: false, showMaxLabel: false },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: 'Sessions',
        type: 'bar',
        yAxisIndex: 1,
        z: 1,
        barMaxWidth: 22,
        itemStyle: { color: SAP_BLUE, opacity: 0.55 },
        data: sessionCounts,
      },
      {
        name: 'Actions',
        type: 'bar',
        yAxisIndex: 1,
        z: 1,
        barMaxWidth: 22,
        itemStyle: { color: SAP_GOLD, opacity: 0.55 },
        data: actionCounts,
      },
      {
        name: 'Widgets',
        type: 'bar',
        yAxisIndex: 1,
        z: 1,
        barMaxWidth: 22,
        itemStyle: { color: SAP_SUCCESS, opacity: 0.55 },
        data: widgetCounts,
      },
      {
        name: 'spread-base',
        type: 'line',
        yAxisIndex: 0,
        stack: 'spread',
        z: 2,
        symbol: 'none',
        silent: true,
        lineStyle: { width: 0, opacity: 0 },
        areaStyle: { color: 'transparent', opacity: 0 },
        tooltip: { show: false },
        data: bandBase,
      },
      {
        name: 'Spread',
        type: 'line',
        yAxisIndex: 0,
        stack: 'spread',
        z: 2,
        symbol: 'none',
        silent: true,
        lineStyle: { width: 0 },
        areaStyle: { color: SAP_BLUE_LIGHT, opacity: 0.45 },
        tooltip: { show: false },
        data: bandTop,
      },
      {
        name: 'p50',
        type: 'line',
        yAxisIndex: 0,
        z: 4,
        symbol: 'circle',
        symbolSize: 7,
        connectNulls: false,
        itemStyle: { color: SAP_BLUE },
        lineStyle: { color: SAP_BLUE, width: 2 },
        data: p50,
      },
      {
        name: 'p90',
        type: 'line',
        yAxisIndex: 0,
        z: 5,
        symbol: 'circle',
        symbolSize: 7,
        connectNulls: false,
        itemStyle: { color: SAP_GOLD },
        lineStyle: { color: SAP_GOLD, width: 2 },
        data: p90,
      },
      {
        name: 'hit-area',
        type: 'line',
        yAxisIndex: 0,
        z: 6,
        data: [],
        showSymbol: false,
        markArea: {
          silent: false,
          itemStyle: { color: 'transparent', opacity: 0 },
          emphasis: { disabled: true },
          data: hitAreas,
        },
      },
    ],
  }
}

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
