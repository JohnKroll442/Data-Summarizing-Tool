import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_GOLD,
  SAP_BLUE_LIGHT,
  SAP_TEXT,
  SAP_TEXT_MUTED,
  chartFontSizes,
} from '../../../lib/chartColors'
import { formatDurationMs } from '../../../lib/format'

/**
 * Time-Of-Day-Trend line chart — p50 / p90 of action duration per time bucket
 * along the data's REAL timeline (see buildTimeOfDayTrend). Reading, back to
 * front:
 *   - faint action-count bars on a secondary (right) axis, so a spike in the
 *     NUMBER of actions — the "busy times" signal — is visible behind the
 *     latency lines (the panel's stated purpose);
 *   - a shaded spread band between p50 and p90 (drawn as a transparent p50 base
 *     with a light-tinted p90−p50 area stacked on top), so the gap between the
 *     median and the tail reads as an area, not two disconnected lines;
 *   - p50 (blue) and p90 (gold) lines with dots on the duration (left) axis.
 * Empty buckets carry null percentiles, so the lines gap there instead of
 * dipping to zero. The axis-trigger tooltip reports p50, p90, the p90/p50 ratio
 * and the action count for the hovered bucket.
 *
 * Input is a Time-Of-Day-Trend result: { buckets }. The bucket granularity is
 * chosen upstream to fit the span (minute / hour / day / week / month), so each
 * X-axis label is a compact chronological marker (bucket.label, e.g. "7/8" or
 * "7/8 09:00"); tooltips use the verbose bucket.fullLabel.
 */

const fmt = (v) => (Number.isFinite(Number(v)) ? formatDurationMs(v) : '—')

// Compact axis label for a bucket (chronological, granularity-dependent).
function labelOf(bucket) {
  return bucket.label ?? ''
}
// Verbose label for the tooltip header, falling back to the compact one.
function fullLabelOf(bucket) {
  return bucket.fullLabel ?? bucket.label ?? ''
}

export function buildTimeOfDayTrendOption({ buckets } = {}) {
  if (!buckets?.length) return emptyOption('No actions with a duration to plot.')

  const f = chartFontSizes()
  const labels = buckets.map((b) => labelOf(b))

  // Empty hours → null so the lines break there (a gap, not a 0 dip). Counts
  // stay 0 so a missing hour reads as "no actions", not "no data".
  const p50 = buckets.map((b) => (b.p50 == null ? null : b.p50))
  const p90 = buckets.map((b) => (b.p90 == null ? null : b.p90))
  const counts = buckets.map((b) => b.count ?? 0)
  // Band: a transparent base at p50 with the p90−p50 delta stacked on top, so
  // the visible fill spans exactly [p50, p90]. Both drop to null on empty hours.
  const bandBase = buckets.map((b) => (b.p50 == null ? null : b.p50))
  const bandTop = buckets.map((b) =>
    b.p50 == null || b.p90 == null ? null : b.p90 - b.p50,
  )
  // Full-column click targets, one per DRILLABLE hour (count > 0), drawn as a
  // markArea so a click ANYWHERE in an hour's column — over the band, a line, or
  // empty space above the short count bar — drills into that hour, instead of
  // forcing the user to hunt for the thin line or find where the bar is. Each
  // band spans the full plot height (only xAxis coords given) and carries its
  // bucket index in `name`, which the panel reads back on click. markArea lives
  // outside the bar-layout group, so the visible count bars are untouched. Empty
  // hours are omitted (no target), matching the panel's "not drillable" guard.
  const hitAreas = buckets
    .map((b, i) => (b.count ? [{ name: String(i), xAxis: labels[i] }, { xAxis: labels[i] }] : null))
    .filter(Boolean)

  return {
    textStyle: BASE_TEXT_STYLE,
    legend: {
      top: 4,
      textStyle: { color: SAP_TEXT, fontSize: f.legend },
      data: ['Actions', 'p50', 'p90', 'Spread'],
    },
    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'line' },
      // Roomier popup — the hour readout carries four stats, so bump the type
      // size, padding and line-height for at-a-glance readability.
      padding: [12, 16],
      textStyle: { ...BASE_TOOLTIP.textStyle, fontSize: 15, lineHeight: 22 },
      extraCssText: 'min-width: 190px; box-shadow: 0 6px 20px rgba(0,0,0,0.16);',
      formatter: (params) => {
        const idx = Array.isArray(params) ? params[0]?.dataIndex : params?.dataIndex
        const b = buckets[idx]
        if (!b) return ''
        const header = `<strong>${fullLabelOf(b)}</strong>`
        if (b.count === 0 || b.p50 == null) {
          return [header, 'No actions'].join('<br/>')
        }
        const ratio = b.ratio != null ? `${b.ratio.toFixed(1)}×` : '—'
        return [
          header,
          `p50: ${fmt(b.p50)}`,
          `p90: ${fmt(b.p90)}`,
          `p90/p50 ratio: ${ratio}`,
          `Actions: ${b.count}`,
        ].join('<br/>')
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
        name: 'Actions',
        nameLocation: 'middle',
        nameGap: 52,
        min: 0,
        nameTextStyle: { fontSize: f.axisName, color: SAP_TEXT_MUTED },
        axisLabel: { color: SAP_TEXT_MUTED, fontSize: f.axis },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        // Faint count bars, behind everything, on the secondary axis.
        name: 'Actions',
        type: 'bar',
        yAxisIndex: 1,
        z: 1,
        barMaxWidth: 22,
        itemStyle: { color: SAP_BLUE_LIGHT, opacity: 0.55 },
        data: counts,
      },
      {
        // Transparent band base at p50 — offsets the stacked delta, draws nothing
        // itself. Kept out of the legend (name absent from legend.data).
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
        // The visible spread: p90−p50 stacked over the base → fills [p50, p90].
        // Purely decorative: silent so its filled polygon never swallows a click
        // meant for the count bars / p50 / p90 dots beneath it — clicks fall
        // through to a real, drillable data point in every legend state.
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
        // Invisible full-column click targets (see hitAreas above). Hosted on a
        // dataless line series kept OUT of legend.data so it can't be toggled
        // off — the click target stays live no matter which series the user
        // hides. markArea reports the clicked band's `name` (the bucket index)
        // as params.name, which the panel maps back to the hour.
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
