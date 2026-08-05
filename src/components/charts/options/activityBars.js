import {
  BASE_TEXT_STYLE,
  SAP_BLUE,
  SAP_TEXT,
} from '../../../lib/chartColors'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

/**
 * Overview navigator — a slim range slider, NOT a bar chart. A light track line
 * spans the full context on a continuous TIME axis; two circular handles mark
 * the focused window, with a blue segment filling the range between them. Drag a
 * circle to grow/shrink the window, drag the segment to pan. There are no
 * activity bars — it's purely a navigation control (per design: the bars read as
 * too busy).
 *
 * @param spanMin  epoch ms of the context start (axis min)
 * @param spanMax  epoch ms of the context end (axis max)
 * @param range    { min, max } current window in epoch ms (handle positions)
 */
export function buildOverviewOption(spanMin, spanMax, range) {
  if (spanMin == null || spanMax == null || !range) return { series: [] }

  const dateLabel = (ms) => {
    const d = new Date(ms)
    return `${MONTHS[d.getMonth()]} ${d.getDate()}`
  }

  return {
    textStyle: BASE_TEXT_STYLE,
    grid: { left: 28, right: 28, top: 8, bottom: 6 },
    // No visible axis — the navigator is purely a line + two circles. Two hidden
    // time axes share the same [min,max]; the slider acts on axis 1. The scatter
    // series (below) rides axis 0 to print each dot's date directly beneath it.
    xAxis: [
      { type: 'time', min: spanMin, max: spanMax, show: false },
      { type: 'time', min: spanMin, max: spanMax, show: false },
    ],
    yAxis: { type: 'value', min: 0, max: 1, show: false },
    dataZoom: [
      {
        type: 'slider',
        xAxisIndex: 1,
        // Selection-only: never filter/zoom a series — the window is just a
        // reported range.
        filterMode: 'none',
        startValue: range.min,
        endValue: range.max,
        left: 28,
        right: 28,
        // Sit near the top of the strip so the line hugs the chart above it.
        // Thin band so the track reads as a LINE; the circle handles are larger
        // than the band, so they sit ON the line like beads.
        top: 8,
        height: 6,
        brushSelect: false,
        // Never let the window collapse below 4 min, so it stays grabbable.
        minValueSpan: 4 * 60 * 1000,
        showDataShadow: false,
        // Handle labels are off — they clip at the edges. The scatter labels
        // below show each dot's date and follow it; the rail shows the live
        // window range.
        showDetail: false,
        backgroundColor: '#dce3ee',             // the track line
        borderColor: 'transparent',
        fillerColor: 'rgba(0, 112, 242, 0.22)', // selected segment between circles
        dataBackground: { lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 } },
        selectedDataBackground: { lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 } },
        // Two circular handles at the window edges.
        handleIcon: 'circle',
        handleSize: 18,
        handleStyle: {
          color: SAP_BLUE,
          borderColor: '#fff',
          borderWidth: 2,
          shadowBlur: 3,
          shadowColor: 'rgba(0,0,0,0.25)',
        },
        // No separate move bar — drag the segment between the circles to pan.
        moveHandleSize: 0,
        emphasis: { handleStyle: { color: SAP_BLUE, borderColor: '#fff' } },
      },
    ],
    // Two invisible points at the window edges, on the SAME axis extent as the
    // slider, so each date label sits directly under its dot and follows it as
    // you drag.
    series: [
      {
        type: 'scatter',
        xAxisIndex: 0,
        yAxisIndex: 0,
        silent: true,
        symbolSize: 0,
        data: [[range.min, 1], [range.max, 1]],
        label: {
          show: true,
          position: 'bottom',
          distance: 18,
          formatter: (p) => dateLabel(p.value[0]),
          color: SAP_TEXT,
          fontSize: 11,
        },
      },
    ],
  }
}
