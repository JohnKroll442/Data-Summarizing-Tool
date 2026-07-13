import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_TEXT_MUTED,
} from '../../../lib/chartColors'

/**
 * Action-level "waterfall" (really a Gantt-style loading sequence, per the
 * SAP Analytics Cloud "Performance Insights → Loading Sequence" reference).
 *
 * Each row on the y-axis is one process step for one widget in the action —
 * e.g. `Query data of Widget_A (Backend)`, `Render Widget_A`. Bars are
 * positioned on an elapsed-time x-axis, colored by whether the phase is
 * Local (client-side: render, offset) or Remote (over-the-wire: backend,
 * network).
 *
 * Layout is duration-based, not timestamp-based — the CSV's per-row
 * timestamps are unreliable for sub-measure rows (Network Full / Content
 * Download often have zero timestamps even when DURATION is populated), so
 * we cursor forward using DURATION. For each widget we walk its phases in a
 * canonical order (Backend → Network(Full) → Network(waiting) →
 * Network(CDN) → Render), which reads as a sensible "what happened first"
 * sequence in the chart.
 */

const REMOTE = '#e35b2a' // orange — matches the SAP reference "Remote" swatch
const LOCAL  = SAP_BLUE

// Phase order within a single widget. Backend/network happen server-side
// before the widget can render, so they come first; render finishes the
// widget. Offset (client-side idle before the widget's turn to load) is
// prepended.
const PHASE_ORDER = [
  { key: 'offset',       label: 'Offset',                     kind: 'local',
    measure: 'offset' },
  { key: 'backend',      label: 'Query data',
    measure: 'backend', kind: 'remote' },
  { key: 'network-full', label: 'Network (Full)',
    measure: 'network', sub: { include: ['ttfb'] }, kind: 'remote' },
  { key: 'network-wait', label: 'Network (waiting)',
    measure: 'network', sub: { include: ['waiting', 'wait'] }, kind: 'remote' },
  { key: 'network-cdn',  label: 'Network (Content Download)',
    measure: 'network', sub: { include: ['contentdownload', 'contentdl', 'download'] }, kind: 'remote' },
  { key: 'render',       label: 'Render',
    measure: 'render', kind: 'local' },
]

/**
 * Build the option.
 *
 * Inputs:
 *   actionRows — rows scoped to a single action (via applyActionFilter or
 *                the caller's own filter)
 *   opts.widgetIdKey / opts.widgetNameKey — optional overrides; auto-detected
 *                otherwise
 */
export function buildActionSequenceOption(actionRows) {
  if (!actionRows?.length) return emptyOption('No data for this action.')

  const headers = Object.keys(actionRows[0] ?? {})
  const m = detectMapping(headers)
  if (!m.measure || !m.duration || !m.widgetId) {
    return emptyOption('CSV is missing WIDGET_ID, WIDGET_MEASURE, or DURATION columns.')
  }

  // Group rows by widget, preserving first-seen order so widgets appear in
  // the sequence they were loaded (approximated by their appearance in the
  // CSV, which is chronological in this shape).
  const widgetOrder = []
  const widgetRows = new Map()
  for (const r of actionRows) {
    const id = r?.[m.widgetId]
    if (id === undefined || id === null || id === '') continue
    const key = String(id)
    if (!widgetRows.has(key)) {
      widgetOrder.push(key)
      widgetRows.set(key, [])
    }
    widgetRows.get(key).push(r)
  }

  if (widgetOrder.length === 0) {
    return emptyOption('No widgets found in this action.')
  }

  // Walk widgets in order, and for each widget walk its phases in
  // PHASE_ORDER. Each present phase becomes one y-axis row. Cursor advances
  // by that phase's DURATION so the next bar starts where this one ended.
  const yLabels = []
  const spacerData = []
  const durationData = []

  let cursor = 0
  for (const widgetKey of widgetOrder) {
    const rows = widgetRows.get(widgetKey)
    const displayName = pickDisplayName(rows, m) || widgetKey

    for (const phase of PHASE_ORDER) {
      const pick = pickPhase(rows, m, [phase.measure], phase.sub)
      if (!pick || !(pick.durationMs > 0)) continue

      const label = phase.key === 'backend'
        ? `Query data of ${displayName}`
        : phase.key === 'render'
          ? `Render ${displayName}`
          : `${displayName} — ${phase.label}`

      const color = phase.kind === 'local' ? LOCAL : REMOTE

      yLabels.push(label)
      spacerData.push(cursor)
      durationData.push({
        value: pick.durationMs,
        itemStyle: { color, borderRadius: [2, 2, 2, 2] },
        phaseLabel: label,
        kind: phase.kind === 'local' ? 'Local' : 'Remote',
        startMs: cursor,
        endMs: cursor + pick.durationMs,
        durationMs: pick.durationMs,
        // Widget identity so a chart click can drill into that widget's
        // detailed timing (all phase bars for a widget carry the same id).
        widgetId: widgetKey,
        widgetName: displayName,
      })

      cursor += pick.durationMs
    }
  }

  if (durationData.length === 0) {
    return emptyOption('No phase rows with duration found for this action.')
  }

  const totalDuration = cursor

  return {
    textStyle: BASE_TEXT_STYLE,
    legend: {
      top: 8,
      left: 'center',
      data: [
        { name: 'Local',  icon: 'rect', itemStyle: { color: LOCAL } },
        { name: 'Remote', icon: 'rect', itemStyle: { color: REMOTE } },
      ],
      textStyle: { color: '#1d2d3e', fontSize: 12 },
    },
    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'item',
      formatter: (p) => {
        const d = p?.data
        if (!d || typeof d !== 'object') return ''
        return [
          `<strong>${escape(d.phaseLabel)}</strong>`,
          `Type: ${escape(d.kind)}`,
          `Duration: ${fmtMs(d.durationMs)}`,
          `Start: ${fmtMs(d.startMs)}`,
          `End: ${fmtMs(d.endMs)}`,
          `<span style="color:#6b7a8d">Click to view widget timing</span>`,
        ].join('<br/>')
      },
    },
    grid: { ...BASE_GRID, left: 260, right: 80, top: 48, bottom: 56 },
    xAxis: {
      type: 'value',
      min: 0,
      max: totalDuration * 1.05,
      name: 'Elapsed time',
      nameLocation: 'middle',
      nameGap: 32,
      axisLabel: {
        formatter: (v) => (v > totalDuration + 1e-6 ? '' : fmtMs(v)),
      },
      splitLine: { show: true, lineStyle: { color: '#e6ecf2' } },
    },
    yAxis: {
      type: 'category',
      // ECharts stacks categories top-to-bottom in the same order they're
      // given, but we want the first phase at the top — reverse so the
      // "earliest" step (largest cursor value would be last) reads top-down.
      data: yLabels.slice().reverse(),
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: '#1d2d3e', fontSize: 11 },
    },
    series: [
      {
        name: 'spacer',
        type: 'bar',
        stack: 'seq',
        itemStyle: { color: 'transparent' },
        emphasis: { itemStyle: { color: 'transparent' } },
        tooltip: { show: false },
        silent: true,
        data: spacerData.slice().reverse(),
        barCategoryGap: '30%',
      },
      {
        name: 'Local',
        type: 'bar',
        stack: 'seq',
        // Real data lives on the "duration" series below, but ECharts needs
        // a series per legend entry to make the legend toggle-able. We use
        // two invisible marker series just so the legend swatches render;
        // toggling them does nothing on purpose (all bars are on `duration`).
        data: [],
        itemStyle: { color: LOCAL },
      },
      {
        name: 'Remote',
        type: 'bar',
        stack: 'seq',
        data: [],
        itemStyle: { color: REMOTE },
      },
      {
        name: 'duration',
        type: 'bar',
        stack: 'seq',
        data: durationData.slice().reverse(),
        barCategoryGap: '30%',
        label: {
          show: true,
          position: 'right',
          formatter: (p) => fmtMs(p?.data?.durationMs ?? p?.value ?? 0),
          color: '#1d2d3e',
          fontSize: 11,
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

function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function fmtMs(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return ''
  if (v < 1) return `${v.toFixed(2)} ms`
  if (v < 1000) return `${Math.round(v)} ms`
  if (v < 60_000) return `${(v / 1000).toFixed(2)} s`
  const totalSec = Math.round(v / 1000)
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`
}

function normSub(s) {
  return String(s).toLowerCase().replace(/[\s_\-.]+/g, '')
}

function pickDisplayName(rows, m) {
  if (!m.widgetName) return ''
  for (const r of rows) {
    const v = r?.[m.widgetName]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return ''
}

/**
 * Return the row with max DURATION that matches `measure` (and optional
 * submeasure include patterns). Returns { durationMs } or null. Copied in
 * spirit from widgetTiming.js's pickPhase but pared down since we only need
 * the duration here.
 */
function pickPhase(rows, m, measureTargets, subMatch = null) {
  if (!m.duration || !m.measure) return null
  const wanted = new Set(measureTargets.map((t) => t.toLowerCase()))
  const include = subMatch?.include?.map(normSub) ?? null
  const exclude = subMatch?.exclude?.map(normSub) ?? null

  let bestDur = -Infinity
  let found = false
  for (const r of rows) {
    const mv = r?.[m.measure]
    if (mv == null) continue
    if (!wanted.has(String(mv).toLowerCase())) continue

    if (include || exclude) {
      const raw = m.submeasure ? r?.[m.submeasure] : ''
      const sv = raw == null ? '' : normSub(raw)
      if (include && include.length && !include.some((pat) => sv.includes(pat))) continue
      if (exclude && exclude.some((pat) => sv.includes(pat))) continue
    }

    const dur = Number(r?.[m.duration])
    if (Number.isFinite(dur) && dur > bestDur) {
      bestDur = dur
      found = true
    }
  }
  if (!found) return null
  return { durationMs: bestDur }
}

/**
 * Detect the widget/measure/duration column keys. Exported so the modal can
 * find the widget-id column to slice rows when drilling into a widget.
 */
export function detectMapping(headers) {
  const norm = (s) => String(s).trim().toLowerCase().replace(/[\s_\-.]+/g, '')
  const find = (exacts, substrings, reject = () => false) => {
    for (const h of headers) {
      if (reject(h)) continue
      if (exacts.includes(norm(h))) return h
    }
    for (const h of headers) {
      if (reject(h)) continue
      const n = norm(h)
      if (substrings.some((s) => n.includes(s))) return h
    }
    return ''
  }

  return {
    widgetId: find(['widgetid', 'instanceid'], ['widgetid', 'instanceid']),
    widgetName: find(['widgetname', 'widgetlabel', 'widgettitle'], ['widgetname']),
    measure: find(['widgetmeasure', 'measure'], ['widgetmeasure'], (h) => norm(h).includes('sub')),
    submeasure: find(['widgetsubmeasure', 'submeasure'], ['widgetsubmeasure', 'submeasure']),
    duration: find(
      ['duration'],
      ['duration'],
      (h) => {
        const n = norm(h)
        return n.startsWith('widget') || n.includes('action') ||
               n.includes('story') || n.includes('session')
      },
    ) || find(['duration'], ['duration']),
  }
}
