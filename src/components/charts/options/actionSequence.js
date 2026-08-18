import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_TEXT_MUTED,
  chartFontSizes,
} from '../../../lib/chartColors'

/**
 * Action-level "waterfall" (really a Gantt-style loading sequence, per the
 * SAP Analytics Cloud "Performance Insights → Loading Sequence" reference).
 *
 * Each row on the y-axis is one process step for one widget in the action —
 * e.g. `Query data of Widget_A (Backend)`, `Render Widget_A`. Bars are
 * positioned on an elapsed-time x-axis, colored by their phase group
 * (offset, backend, network, render).
 *
 * Layout is duration-based, not timestamp-based — the CSV's per-row
 * timestamps are unreliable for sub-measure rows (Network Full / Content
 * Download often have zero timestamps even when DURATION is populated), so
 * we cursor forward using DURATION. For each widget we walk its phases in a
 * canonical order (Backend → Network(Full) → Network(waiting) →
 * Network(CDN) → Render), which reads as a sensible "what happened first"
 * sequence in the chart.
 */


// Per-phase colors — the four categories shown in the waterfall header legend.
// The three network sub-phases share the single `network` color.
export const PHASE_COLORS = {
  offset:  '#8396a8', // muted grey-blue
  backend: SAP_BLUE, // SAP blue
  network: '#e35b2a', // orange
  render:  '#0f828f', // teal — distinct from backend blue
}

// Legend categories, in chart order, labeled to match the SAP reference.
export const PHASE_LEGEND = [
  { key: 'offset',  label: 'Offset',       color: PHASE_COLORS.offset },
  { key: 'backend', label: 'Backend',      color: PHASE_COLORS.backend },
  { key: 'network', label: 'Network wait', color: PHASE_COLORS.network },
  { key: 'render',  label: 'Render',       color: PHASE_COLORS.render },
]

// Map any PHASE_ORDER key to its legend group. network-full/wait/cdn → network.
export function phaseGroupOf(phaseKey) {
  return String(phaseKey).startsWith('network') ? 'network' : String(phaseKey)
}

// Phase order within a single widget. Backend/network happen server-side
// before the widget can render, so they come first; render finishes the
// widget. Offset (client-side idle before the widget's turn to load) is
// prepended.
const PHASE_ORDER = [
  { key: 'offset',       label: 'Offset',
    measure: 'offset' },
  { key: 'backend',      label: 'Query data',
    measure: 'backend' },
  { key: 'network-full', label: 'Network (Full)',
    measure: 'network', sub: { include: ['ttfb'] } },
  { key: 'network-wait', label: 'Network (waiting)',
    measure: 'network', sub: { include: ['waiting', 'wait'] } },
  { key: 'network-cdn',  label: 'Network (Content Download)',
    measure: 'network', sub: { include: ['contentdownload', 'contentdl', 'download'] } },
  { key: 'render',       label: 'Render',
    measure: 'render' },
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
export function buildActionSequenceOption(actionRows, opts = {}) {
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

  // First pass — reconstruct each widget's OVERLAPPING timeline in natural
  // (pre-clamp) coordinates. Widgets load concurrently within an action (each
  // anchored at its own offset). WITHIN a widget the phases do NOT run
  // end-to-end: backend and network run concurrently from the widget's start,
  // the network sub-phases (waiting/TTFB, content download) nest INSIDE the
  // Network (Full) window rather than stacking after it (they're components of
  // Full, not extra time), and render begins once the data phases finish. Bars
  // keep their true durations — this reconstructs the parallel work, so the
  // picture collapses toward the real action duration instead of a stacked sum.
  const widgetBars = []
  let reconstructedEnd = 0

  for (const widgetKey of widgetOrder) {
    const rows = widgetRows.get(widgetKey)
    const displayName = pickDisplayName(rows, m) || widgetKey

    const offsetPick = pickPhase(rows, m, ['offset'], null)
    const widgetStart = offsetPick && offsetPick.durationMs > 0 ? offsetPick.durationMs : 0

    // Max DURATION per phase row (0 = phase absent for this widget).
    const dur = {}
    for (const phase of PHASE_ORDER) {
      const pick = pickPhase(rows, m, [phase.measure], phase.sub)
      dur[phase.key] = pick && pick.durationMs > 0 ? pick.durationMs : 0
    }

    const natural = {}
    if (dur.offset) natural.offset = { start: 0, dur: widgetStart }
    // Backend query and the network request overlap — both start at the
    // widget's turn to load.
    if (dur.backend) natural.backend = { start: widgetStart, dur: dur.backend }

    if (dur['network-full']) {
      // Network (Full) is the umbrella; waiting sits at its head, content
      // download at its tail, both drawn INSIDE the Full window.
      const fullStart = widgetStart
      const fullEnd = fullStart + dur['network-full']
      natural['network-full'] = { start: fullStart, dur: dur['network-full'] }
      if (dur['network-wait'])
        natural['network-wait'] = { start: fullStart, dur: dur['network-wait'] }
      if (dur['network-cdn'])
        natural['network-cdn'] = {
          start: Math.max(fullStart, fullEnd - dur['network-cdn']),
          dur: dur['network-cdn'],
        }
    } else {
      // No Full container to nest under — lay the present sub-phases
      // end-to-end from the widget start.
      let c = widgetStart
      if (dur['network-wait']) {
        natural['network-wait'] = { start: c, dur: dur['network-wait'] }
        c += dur['network-wait']
      }
      if (dur['network-cdn']) {
        natural['network-cdn'] = { start: c, dur: dur['network-cdn'] }
        c += dur['network-cdn']
      }
    }

    // Render starts once the data is ready — the latest end of the backend +
    // network phases (falling back to the widget start if none are present).
    let dataEnd = widgetStart
    for (const k of ['backend', 'network-full', 'network-wait', 'network-cdn']) {
      if (natural[k]) dataEnd = Math.max(dataEnd, natural[k].start + natural[k].dur)
    }
    if (dur.render) natural.render = { start: dataEnd, dur: dur.render }

    for (const k of Object.keys(natural)) {
      const e = natural[k].start + natural[k].dur
      if (e > reconstructedEnd) reconstructedEnd = e
    }

    widgetBars.push({ widgetKey, displayName, natural })
  }

  // The authoritative action duration is the source of truth for the end
  // marker. action_duration is emitted as '' when it can't be computed;
  // Number('') is a finite 0, so treat '' (and null/undefined) as absent to
  // avoid collapsing the end marker onto x=0 — fall back to the reconstructed
  // end instead.
  const rawDuration = opts.actionDurationMs
  const parsedDuration =
    rawDuration == null || rawDuration === '' ? NaN : Number(rawDuration)
  const actionDurationMs = Number.isFinite(parsedDuration) ? parsedDuration : null
  const endMarker = actionDurationMs != null ? actionDurationMs : reconstructedEnd
  const axisMax = endMarker

  // Second pass — emit one y-axis row per present phase (in PHASE_ORDER),
  // clamping each bar so it never extends past the Action End marker. A bar
  // whose natural end overshoots is shifted LEFT so it ends exactly at the
  // marker (its true width is preserved); a lone phase longer than the whole
  // action is truncated at the marker. The bar label + tooltip always report
  // the TRUE durationMs, so real durations stay visible even when a bar is
  // shifted or truncated to fit.
  const yLabels = []
  const spacerData = []
  const durationData = []

  for (const wb of widgetBars) {
    for (const phase of PHASE_ORDER) {
      if (phase.key === 'offset') continue // offset is implicit from bar position; not drawn
      const nat = wb.natural[phase.key]
      if (!nat) continue

      const { start, end } = clampToEnd(nat.start, nat.dur, endMarker)
      const label = phase.key === 'backend'
        ? `Query data of ${wb.displayName}`
        : phase.key === 'render'
          ? `Render ${wb.displayName}`
          : `${wb.displayName} — ${phase.label}`

      const group = phaseGroupOf(phase.key)
      const color = PHASE_COLORS[group]
      const legendLabel = phase.key.startsWith('network')
        ? 'Network wait'
        : phase.label

      yLabels.push(label)
      spacerData.push(start)
      durationData.push({
        value: end - start, // drawn width (kept inside the axis)
        itemStyle: { color, borderRadius: [2, 2, 2, 2] },
        phaseLabel: label,
        phaseGroup: group,
        legendLabel,
        startMs: start,
        endMs: end,
        durationMs: nat.dur, // TRUE duration — survives clamping
        widgetId: wb.widgetKey,
        widgetName: wb.displayName,
      })
    }
  }

  if (durationData.length === 0) {
    return emptyOption('No phase rows with duration found for this action.')
  }

  // Responsive type sizes, derived from the current root font-size.
  const f = chartFontSizes()


  // Two vertical markLines anchor the sequence to the action's start (x=0) and
  // its real end. The end marker is pinned to the authoritative action_duration
  // passed in as opts.actionDurationMs (falling back to the reconstructed end of
  // the offset-anchored timeline when that isn't provided) — NOT the sum of every
  // phase bar, which overcounts because widgets load concurrently. Elapsed time,
  // not wall-clock: the layout is offset-anchored and duration-based.
  const markLineData = [
    {
      xAxis: 0,
      label: {
        formatter: 'Action Start Timestamp',
        position: 'end', distance: [0, 6], color: '#1d2d3e',
        fontSize: f.markLine, align: 'center', verticalAlign: 'bottom',
      },
      lineStyle: { color: '#1d2d3e', type: 'solid', width: 1 },
    },
    {
      xAxis: 0,
      label: {
        formatter: fmtMs(0),
        position: 'end', distance: [0, f.markLine + 10], color: '#1d2d3e',
        fontSize: f.markLine, fontWeight: 600, align: 'center', verticalAlign: 'bottom',
      },
      lineStyle: { color: 'transparent', width: 0 },
    },
    {
      // Pinned to the authoritative action duration (or the reconstructed end
      // when that's unavailable) — this is the action's real end, not the sum
      // of every phase stacked end-to-end.
      xAxis: endMarker,
      label: {
        formatter: 'Action End Timestamp',
        position: 'end', distance: [0, 6], color: '#1d2d3e',
        fontSize: f.markLine, align: 'center', verticalAlign: 'bottom',
      },
      lineStyle: { color: '#1d2d3e', type: 'solid', width: 1 },
    },
    {
      xAxis: endMarker,
      label: {
        formatter: fmtMs(endMarker),
        position: 'end', distance: [0, f.markLine + 10], color: '#1d2d3e',
        fontSize: f.markLine, fontWeight: 600, align: 'center', verticalAlign: 'bottom',
      },
      lineStyle: { color: 'transparent', width: 0 },
    },
  ]

  return {
    textStyle: BASE_TEXT_STYLE,
    tooltip: {
      ...BASE_TOOLTIP,
      trigger: 'item',
      formatter: (p) => {
        const d = p?.data
        if (!d || typeof d !== 'object') return ''
        return [
          `<strong>${escape(d.phaseLabel)}</strong>`,
          `Type: ${escape(d.legendLabel)}`,
          `Duration: ${fmtMs(d.durationMs)}`,
          `Start: ${fmtMs(d.startMs)}`,
          `End: ${fmtMs(d.endMs)}`,
          `<span style="color:#6b7a8d">Click to view widget timing</span>`,
        ].join('<br/>')
      },
    },
    grid: { ...BASE_GRID, left: 288, right: 96, top: 44, bottom: 56 },
    xAxis: {
      type: 'value',
      min: 0,
      max: axisMax * 1.15,
      name: 'Elapsed time',
      nameLocation: 'middle',
      nameGap: 36,
      nameTextStyle: { fontSize: f.axisName, color: '#1d2d3e' },
      axisLabel: {
        fontSize: f.axis,
        formatter: (v) => (v > axisMax + 1e-6 ? '' : fmtMs(v)),
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
      axisLabel: { color: '#1d2d3e', fontSize: f.axis },
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
        name: 'duration',
        type: 'bar',
        stack: 'seq',
        data: durationData.slice().reverse(),
        barCategoryGap: '47%',
        markLine: {
          symbol: 'none',
          silent: true,
          data: markLineData,
        },
        label: {
          show: true,
          position: 'right',
          formatter: (p) => fmtMs(p?.data?.durationMs ?? p?.value ?? 0),
          color: '#1d2d3e',
          fontSize: f.barLabel,
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

/**
 * Keep a bar inside [0, endMarker] on the elapsed-time axis. A bar whose
 * natural end overshoots the marker is shifted LEFT so it ends exactly at the
 * marker, preserving its true width (this is how a long phase reads as
 * overlapping the ones before it). A bar longer than the whole window is
 * truncated at the marker. With no valid endMarker, positions pass through
 * unchanged. Returns the DRAWN {start, end}; the caller keeps the true
 * duration separately.
 */
function clampToEnd(start, dur, endMarker) {
  if (!(endMarker > 0)) return { start, end: start + dur }
  let s = start
  if (s + dur > endMarker) s = Math.max(0, endMarker - dur)
  return { start: s, end: Math.min(s + dur, endMarker) }
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
