import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_DANGER,
  SAP_PALETTE,
  SAP_TEXT,
  SAP_TEXT_MUTED,
  chartFontSizes,
} from '../../../lib/chartColors'
import { formatDurationMs } from '../../../lib/format'

/**
 * Time-Of-Day hour drill-down — the click-to-drill companion to the trend line
 * chart. Given one hourly bucket's individual action instances, it scatters them
 * by minute-within-the-hour (X, 0–60) against duration (Y, log — the same wide
 * ms→minutes range the offset scatter faces). This turns a single p50/p90 dot on
 * the trend line into the actual distribution behind it, so a tail-heavy hour
 * (a few slow runs pulling p90 up) is distinguishable from a uniformly-slow one.
 *
 * Non-flagged instances are colored BY ACTION TYPE — one series (and legend
 * entry) per distinct action name, cycling SAP_PALETTE — so a glance shows which
 * kind of action dominates the hour. Flagged instances (any anomaly flag,
 * resolved upstream from byActionKey) override that: they collapse into a single
 * red-triangle "Flagged" series so the outliers driving p90 stand out, and the
 * "Flagged" legend entry only appears when something is actually flagged. The
 * per-dot tooltip names the action, story, user, timestamp and duration.
 *
 * Input: { instances, hourLabel } where each instance is
 *   { actionKey, action, story, user, timestamp, duration, minute, flagged }.
 */

const fmt = (v) => (Number.isFinite(Number(v)) ? formatDurationMs(v) : '—')

export function buildTimeOfDayHourScatterOption({ instances, hourLabel } = {}) {
  if (!instances?.length) {
    return emptyOption(`No actions in ${hourLabel ?? 'this hour'}.`)
  }

  const f = chartFontSizes()
  const toDatum = (i) => ({
    value: [i.minute, Math.max(Number(i.duration) || 0, 1)],
    action: i.action,
    story: i.story,
    user: i.user,
    timestamp: i.timestamp,
    duration: i.duration,
    minute: i.minute,
  })

  // Non-flagged points, one colored series per action type (sorted for a stable
  // legend order + stable color assignment). Flagged points are pulled out.
  const flagged = instances.filter((i) => i.flagged)
  const normal = instances.filter((i) => !i.flagged)
  const actionNames = [...new Set(normal.map((i) => i.action))].sort()

  const actionSeries = actionNames.map((name, idx) => ({
    name,
    type: 'scatter',
    symbol: 'circle',
    symbolSize: 10,
    z: 2,
    itemStyle: {
      color: SAP_PALETTE[idx % SAP_PALETTE.length],
      opacity: 0.85,
      borderColor: '#fff',
      borderWidth: 1,
    },
    data: normal.filter((i) => i.action === name).map(toDatum),
  }))

  const flaggedSeries = flagged.length
    ? [
        {
          name: 'Flagged',
          type: 'scatter',
          symbol: 'triangle',
          symbolSize: 13,
          z: 3,
          itemStyle: { color: SAP_DANGER, opacity: 0.9, borderColor: '#fff', borderWidth: 1 },
          data: flagged.map(toDatum),
        },
      ]
    : []

  const series = [...actionSeries, ...flaggedSeries]

  return {
    textStyle: BASE_TEXT_STYLE,
    legend: {
      top: 4,
      type: 'scroll',
      textStyle: { color: SAP_TEXT, fontSize: f.legend },
      data: series.map((s) => s.name),
    },
    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'item',
      formatter: (p) => {
        const d = p?.data
        if (!d || typeof d !== 'object') return ''
        return [
          `<strong>${escape(d.action)}</strong>`,
          d.story ? `Story: ${escape(d.story)}` : '',
          d.user ? `User: ${escape(d.user)}` : '',
          d.timestamp ? `At: ${escape(d.timestamp)}` : '',
          `Duration: ${fmt(d.duration)}`,
        ].filter(Boolean).join('<br/>')
      },
    },
    grid: { ...BASE_GRID, top: 44, left: 92, right: 32, bottom: 56 },
    xAxis: {
      type: 'value',
      name: 'Minute of hour',
      nameLocation: 'middle',
      nameGap: 34,
      min: 0,
      max: 60,
      interval: 10,
      nameTextStyle: { fontSize: f.axisName, color: SAP_TEXT },
      axisLabel: { color: SAP_TEXT_MUTED, fontSize: f.axis },
      splitLine: { lineStyle: { color: '#cdd6e0' } },
    },
    yAxis: {
      type: 'log',
      name: 'Duration',
      nameLocation: 'middle',
      nameGap: 76,
      nameTextStyle: { fontSize: f.axisName, color: SAP_TEXT },
      axisLabel: { formatter: fmt, color: SAP_TEXT_MUTED, fontSize: f.axis },
      splitLine: { lineStyle: { color: '#cdd6e0' } },
    },
    series,
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
