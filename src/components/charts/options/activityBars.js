import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_BLUE_LIGHT,
  SAP_GOLD,
  SAP_GOLD_LIGHT,
  SAP_SUCCESS,
  SAP_TEXT,
} from '../../../lib/chartColors'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

/**
 * Detail chart — grouped bars per bucket for the three activity metrics over
 * the currently-selected time window.
 *
 * @param buckets  [{ key, label, sort }] chronological, contiguous
 * @param series   { sessions:number[], actions:number[], widgets:number[] }
 * @param hidden   { sessions?:bool, actions?:bool, widgets?:bool } — series the
 *                 user has toggled off via the header key; hidden ones drop out
 *                 and the remaining bars re-center, exactly like a legend click.
 * @param logScale when true, plot the count axis logarithmically so small bars
 *                 stay visible next to a dominant spike (zero-count bars simply
 *                 don't render, which is fine — they're empty).
 * Returns an empty `series` array when there are no buckets so EChartCard /
 * the panel can show a "no data" state.
 */
export function buildActivityBarsOption(buckets, series, hidden = {}, logScale = false) {
  if (!buckets || buckets.length === 0) return { series: [] }

  return {
    color: [SAP_BLUE, SAP_GOLD, SAP_SUCCESS],
    textStyle: BASE_TEXT_STYLE,
    tooltip: { ...BASE_TOOLTIP, trigger: 'axis', axisPointer: { type: 'shadow' } },
    // The visible color key lives in the panel header (HTML legend). This
    // legend is kept but hidden (show:false) purely to drive series visibility:
    // the header buttons flip `selected` here, so toggling a series off makes
    // the grouped bars re-center just as clicking the old chart legend did.
    legend: {
      show: false,
      data: ['Sessions', 'Actions', 'Widgets active'],
      selected: {
        Sessions: !hidden.sessions,
        Actions: !hidden.actions,
        'Widgets active': !hidden.widgets,
      },
    },
    grid: { ...BASE_GRID },
    xAxis: { type: 'category', data: buckets.map((b) => b.label), axisLabel: { hideOverlap: true } },
    yAxis: logScale
      ? { type: 'log', minorSplitLine: { show: true } }
      : { type: 'value', minInterval: 1 },
    series: [
      // All three series are clickable — each drills into its view scoped to
      // the clicked bucket — so all get the pointer cursor.
      { name: 'Sessions',       type: 'bar', data: series.sessions, cursor: 'pointer', ...BAR_STYLE },
      { name: 'Actions',        type: 'bar', data: series.actions,  cursor: 'pointer', ...BAR_STYLE },
      { name: 'Widgets active', type: 'bar', data: series.widgets,  cursor: 'pointer', ...BAR_STYLE },
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
    const p = (n) => String(n).padStart(2, '0')
    return `${MONTHS[d.getMonth()]} ${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
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
    // Two identical time axes over the SAME grid rect. Axis 0 draws the bars and
    // the date labels and is NEVER zoomed, so the strip always shows the full
    // context span. Axis 1 is invisible and exists only for the slider to act
    // on. Pointing the slider at axis 0 (the old setup) zoomed the strip itself:
    // the bars/labels stretched to the selected window while the handles stayed
    // mapped to the full extent, so the window you dragged no longer matched the
    // dates printed beneath it. With a dedicated hidden axis sharing the same
    // [min,max] and pixel rect, the handles line up exactly with the bars below.
    xAxis: [
      {
        type: 'time',
        min: spanMin,
        max: spanMax,
        axisTick: { show: false },
        axisLabel: {
          hideOverlap: true,
          // Match the time axis's natural levels but enlarge month boundaries.
          // A tick at midnight is a day/month gridline: the 1st reads as a
          // section header (large, bold month name), other days a small number.
          // Intra-day ticks (when zoomed to hours/minutes) show the time. Keyed
          // off the date itself, so it applies to every month, not just Jul.
          formatter: (value) => {
            const d = new Date(value)
            const p = (n) => String(n).padStart(2, '0')
            if (d.getHours() !== 0 || d.getMinutes() !== 0) {
              return `{day|${p(d.getHours())}:${p(d.getMinutes())}}`
            }
            return d.getDate() === 1
              ? `{month|${MONTHS[d.getMonth()]}}`
              : `{day|${d.getDate()}}`
          },
          rich: {
            month: { fontSize: 15, fontWeight: 'bold', color: SAP_TEXT },
            day: { fontSize: 11, color: SAP_TEXT },
          },
        },
      },
      { type: 'time', min: spanMin, max: spanMax, show: false },
    ],
    yAxis: { type: 'value', show: false, minInterval: 1 },
    dataZoom: [
      {
        type: 'slider',
        xAxisIndex: 1,
        // Selection-only: never filter/zoom any rendered series — the strip is a
        // fixed-extent overview and the window is just a reported range.
        filterMode: 'none',
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
        xAxisIndex: 0,
        data: points,
        barWidth: '62%',
        itemStyle: { color: SAP_BLUE_LIGHT, borderRadius: [2, 2, 0, 0] },
        // Hover pops in the gold accent so it stands out from the pale-blue
        // bars and the blue selection handles/filler in this same strip.
        emphasis: {
          itemStyle: { color: SAP_GOLD, borderColor: SAP_GOLD_LIGHT, borderWidth: 1 },
        },
      },
    ],
  }
}
