import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_BLUE_LIGHT,
  SAP_GOLD,
  SAP_SUCCESS,
  SAP_TEXT,
} from '../../../lib/chartColors'

/**
 * Detail chart — grouped bars per bucket for the three activity metrics over
 * the currently-selected time window.
 *
 * @param buckets  [{ key, label, sort }] chronological, contiguous
 * @param series   { sessions:number[], actions:number[], widgets:number[] }
 * Returns an empty `series` array when there are no buckets so EChartCard /
 * the panel can show a "no data" state.
 */
export function buildActivityBarsOption(buckets, series) {
  if (!buckets || buckets.length === 0) return { series: [] }

  return {
    color: [SAP_BLUE, SAP_GOLD, SAP_SUCCESS],
    textStyle: BASE_TEXT_STYLE,
    tooltip: { ...BASE_TOOLTIP, trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: {
      data: ['Sessions', 'Actions', 'Widgets active'],
      bottom: 0,
      textStyle: { color: '#fff' },
    },
    grid: { ...BASE_GRID, bottom: 48 },
    xAxis: { type: 'category', data: buckets.map((b) => b.label), axisLabel: { hideOverlap: true } },
    yAxis: { type: 'value', minInterval: 1 },
    // Inside zoom lets the user scroll/pinch within the window too; the main
    // range selection lives on the overview strip's slider.
    dataZoom: [{ type: 'inside', xAxisIndex: 0 }],
    series: [
      { name: 'Sessions',       type: 'bar', data: series.sessions, ...BAR_STYLE },
      { name: 'Actions',        type: 'bar', data: series.actions,  ...BAR_STYLE },
      { name: 'Widgets active', type: 'bar', data: series.widgets,  ...BAR_STYLE },
    ],
  }
}

// Shared grouped-bar styling. Tight intra-group gap so each bucket's three
// bars read as one clustered column, a wider gap between buckets, and min/max
// widths so bars never collapse to slivers or balloon when there are few.
const BAR_STYLE = {
  barGap: '10%',
  barCategoryGap: '30%',
  barMinWidth: 3,
  barMaxWidth: 42,
  itemStyle: { borderRadius: [3, 3, 0, 0] },
}

/**
 * Overview navigator — one discrete bar per day (or per auto bucket) across the
 * full span, on a continuous TIME axis so the drag window can still focus any
 * sub-range (a day, an hour, a 30-minute slice). Taller bars = busier days.
 * The selection box overlays the bars so it's clear which days you're on.
 *
 * @param points   [[epochMs, total]] one per bucket, x centered in the bucket
 * @param spanMin  epoch ms of the data start (axis min)
 * @param spanMax  epoch ms of the data end (axis max)
 * @param range    { min, max } current window in epoch ms (slider position)
 */
export function buildOverviewOption(points, spanMin, spanMax, range) {
  if (!points || points.length === 0) return { series: [] }

  const fmt = (ms) => {
    const d = new Date(ms)
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]
    const p = (n) => String(n).padStart(2, '0')
    return `${mon} ${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  return {
    color: [SAP_BLUE],
    textStyle: BASE_TEXT_STYLE,
    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (v) => `${v} active`,
    },
    // Slider overlays this exact rect (same left/right/top/bottom) so the drag
    // window sits directly ON the day bars rather than in a separate track.
    grid: { left: 10, right: 10, top: 16, bottom: 30 },
    xAxis: {
      type: 'time',
      min: spanMin,
      max: spanMax,
      axisTick: { show: false },
      axisLabel: { hideOverlap: true },
    },
    yAxis: { type: 'value', show: false, minInterval: 1 },
    dataZoom: [
      {
        type: 'slider',
        xAxisIndex: 0,
        startValue: range.min,
        endValue: range.max,
        left: 10,
        right: 10,
        top: 16,
        bottom: 30,
        brushSelect: false,
        // Never let the window collapse below 4 min, so it stays clearly
        // visible and grabbable.
        minValueSpan: 4 * 60 * 1000,
        showDataShadow: false,
        backgroundColor: 'transparent',
        borderColor: 'transparent',
        dataBackground: { lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 } },
        selectedDataBackground: { lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 } },
        fillerColor: 'rgba(0, 112, 242, 0.16)',
        // Big, solid, clearly grabbable edge handles.
        handleSize: 22,
        handleStyle: { color: SAP_BLUE, borderColor: '#fff', borderWidth: 2 },
        moveHandleSize: 8,
        moveHandleStyle: { color: SAP_BLUE, opacity: 0.85 },
        emphasis: { handleStyle: { color: SAP_BLUE, borderColor: '#fff' } },
        labelFormatter: (value) => fmt(value),
        textStyle: { color: SAP_TEXT },
      },
    ],
    series: [
      {
        name: 'Total activity',
        type: 'bar',
        data: points,
        barWidth: '62%',
        itemStyle: { color: SAP_BLUE_LIGHT, borderRadius: [2, 2, 0, 0] },
        emphasis: { itemStyle: { color: SAP_BLUE } },
      },
    ],
  }
}
