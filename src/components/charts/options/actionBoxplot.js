import { formatDurationMs } from '../../../lib/format'
import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_TEXT_MUTED,
  chartFontSizes,
} from '../../../lib/chartColors'

/**
 * buildActionBoxplotOption
 *
 * Answers: "Which actions have the worst and most variable durations?"
 *
 * Every action is normalized to [0 – 100] so each box occupies the SAME
 * visual height regardless of absolute duration.  Actual duration values are
 * shown as bold labels above each box (median) and in the hover tooltip
 * (all five stats), so actions can still be compared directly.
 *
 * Sorting: median descending — slowest action is on the left.
 * Whiskers: Tukey 1.5×IQR rule (not min/max) — outlier count shown in tooltip.
 *
 * @param {object[]} rows   aggRows (one row per action instance)
 * @param {object}   opts
 * @param {number}   opts.topN  Max actions to render (default 20)
 */
export function buildActionBoxplotOption(rows, { topN = 20 } = {}) {
  if (!rows?.length) return { series: [] }

  const sz  = chartFontSizes()
  const fmt = (v) => (Number.isFinite(Number(v)) ? formatDurationMs(v) : '')

  // ── 1. Group durations by action_name ──────────────────────────────────
  const groups = new Map()
  for (const row of rows) {
    const name = row?.action_name
    const val  = Number(row?.action_duration)
    if (!name || !Number.isFinite(val) || val < 0) continue
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(val)
  }

  // ── 2. IQR-based 5-number summary per group ────────────────────────────
  const summaries = []
  for (const [name, vals] of groups) {
    if (vals.length < 3) continue
    vals.sort((a, b) => a - b)

    const q = (p) => {
      const idx = (vals.length - 1) * p
      const lo  = Math.floor(idx)
      const hi  = Math.ceil(idx)
      return lo === hi ? vals[lo] : vals[lo] + (vals[hi] - vals[lo]) * (idx - lo)
    }

    const q1     = q(0.25)
    const median = q(0.5)
    const q3     = q(0.75)
    const iqr    = q3 - q1
    const lFence = q1 - 1.5 * iqr
    const uFence = q3 + 1.5 * iqr

    const lWhisker    = vals.find(v => v >= Math.max(0, lFence)) ?? q1
    const uWhisker    = vals.slice().reverse().find(v => v <= uFence) ?? q3
    const outlierCount = vals.filter(v => v < lFence || v > uFence).length

    summaries.push({ name, count: vals.length, q1, median, q3, lWhisker, uWhisker, outlierCount })
  }

  if (!summaries.length) return { series: [] }

  // ── 3. Sort by median desc, take topN ──────────────────────────────────
  summaries.sort((a, b) => b.median - a.median)
  const top = summaries.slice(0, topN)

  const categories = top.map(s => s.name)

  // ── 4. Normalize each action to [0, 100] ───────────────────────────────
  //
  // lWhisker → 0, uWhisker → 100, Q1/Median/Q3 proportionally between them.
  // This makes every box fill the same vertical space so no action is
  // invisible next to a high-outlier neighbour.
  // Actual ms values are preserved in the `top` array for labels/tooltip.
  const boxData = top.map((s) => {
    const range = (s.uWhisker - s.lWhisker) || 1
    const n     = (v) => ((v - s.lWhisker) / range) * 100
    return [0, n(s.q1), n(s.median), n(s.q3), 100]
  })

  return {
    color: [SAP_BLUE],
    textStyle: BASE_TEXT_STYLE,

    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'item',
      formatter: (p) => {
        const s = top[p.dataIndex]
        if (!s) return ''
        const outlierNote = s.outlierCount > 0
          ? `<br/><span style="color:#888;font-size:11px">+${s.outlierCount} outlier${s.outlierCount !== 1 ? 's' : ''} beyond 1.5×IQR</span>`
          : ''
        return [
          `<strong style="font-size:13px">${s.name}</strong>`,
          `<span style="color:${SAP_TEXT_MUTED};font-size:11px">${s.count.toLocaleString()} instance${s.count !== 1 ? 's' : ''}</span>`,
          `Lower fence: <strong>${fmt(s.lWhisker)}</strong>`,
          `Q1:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<strong>${fmt(s.q1)}</strong>`,
          `Median:&nbsp;&nbsp;&nbsp;&nbsp;<strong>${fmt(s.median)}</strong>`,
          `Q3:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<strong>${fmt(s.q3)}</strong>`,
          `Upper fence: <strong>${fmt(s.uWhisker)}</strong>` + outlierNote,
        ].join('<br/>')
      },
    },

    grid: {
      ...BASE_GRID,
      // Extra top room for the median labels that float above each box
      top:    48,
      bottom: 80,
      right:  32,
      containLabel: true,
    },

    // Shift+scroll or two-finger swipe scrolls through actions
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, zoomOnMouseWheel: 'shift' },
    ],

    xAxis: {
      type: 'category',
      data: categories,
      axisLabel: {
        fontSize:  sz.axis,
        color:     BASE_TEXT_STYLE.color,
        rotate:    35,
        interval:  0,
        formatter: (v) => (v.length > 22 ? `${v.slice(0, 20)}\u2026` : v),
      },
    },

    // Y-axis is the normalized [0–100] space — hidden from the user since the
    // raw values are shown via labels and tooltip.
    yAxis: {
      type:      'value',
      min:       -18,  // headroom below y=0 for the lower-fence label
      max:       120,  // headroom above y=100 for the upper-fence label
      axisLabel: { show: false },
      splitLine: { show: false },
      axisLine:  { show: false },
      axisTick:  { show: false },
    },

    series: [
      {
        type: 'boxplot',
        data: boxData,
        itemStyle: {
          color:       'rgba(0, 112, 242, 0.12)',
          borderColor: SAP_BLUE,
          borderWidth: 1.5,
        },
        emphasis: {
          itemStyle: {
            color:       'rgba(0, 112, 242, 0.22)',
            borderColor: SAP_BLUE,
            borderWidth: 2,
          },
        },
      },
      // ── Stat label anchors (one invisible point per stat per box) ─────────
      // ECharts boxplot doesn't reliably render per-item labels, so we use a
      // separate invisible-symbol scatter series. Each data item carries its
      // own label showing the actual ms value of that statistic.
      //
      // boxData[i] = [0, nQ1, nMedian, nQ3, 100]  (normalized positions)
      // We reuse those coordinates so each label sits exactly on its line.
      {
        type:    'scatter',
        symbol:  'none',
        z:       10,
        tooltip: { show: false },
        data: top.flatMap((s, i) => [
          // Upper fence — above the top whisker
          {
            value: [i, boxData[i][4]],
            label: { show: true, position: 'top',    fontSize: sz.barLabel, color: BASE_TEXT_STYLE.color, formatter: `uF: ${fmt(s.uWhisker)}` },
          },
          // Q3 — top of the IQR box
          {
            value: [i, boxData[i][3]],
            label: { show: true, position: 'right',  fontSize: sz.barLabel, color: BASE_TEXT_STYLE.color, formatter: `Q3: ${fmt(s.q3)}` },
          },
          // Median — middle line (bold to stand out)
          {
            value: [i, boxData[i][2]],
            label: { show: true, position: 'right',  fontSize: sz.barLabel, color: SAP_BLUE, fontWeight: 'bold', formatter: `Med: ${fmt(s.median)}` },
          },
          // Q1 — bottom of the IQR box
          {
            value: [i, boxData[i][1]],
            label: { show: true, position: 'right',  fontSize: sz.barLabel, color: BASE_TEXT_STYLE.color, formatter: `Q1: ${fmt(s.q1)}` },
          },
          // Lower fence — below the bottom whisker
          {
            value: [i, boxData[i][0]],
            label: { show: true, position: 'bottom', fontSize: sz.barLabel, color: BASE_TEXT_STYLE.color, formatter: `lF: ${fmt(s.lWhisker)}` },
          },
        ]),
      },
    ],
  }
}


