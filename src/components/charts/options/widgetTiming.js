import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_BLUE_DARK,
  SAP_BLUE_LIGHT,
  SAP_GOLD,
  SAP_GOLD_LIGHT,
  SAP_SUCCESS,
  SAP_TEXT_MUTED,
} from '../../../lib/chartColors'

/**
 * Per-widget timing chart — opened from a Widget summary row click. Renders
 * the widget's phases as horizontal bars on an action-time X-axis.
 *
 * Phase order matches the reference design:
 *   widget WITH backend → Offset · Render · Network (Full) · Backend ·
 *                         Network (waiting) · Network (Content Download)
 *   widget WITHOUT backend → Offset · Render
 *
 * Two vertical markLines anchor the chart to the parent action's start and
 * end timestamps. Action start comes from the ACTION_TIMESTAMP column;
 * action end is derived from the max widget end-time observed in the rows
 * passed in (callers should pass action-scoped rows).
 *
 * Inputs:
 *   widgetRows — rows for the chosen widget only (already scoped)
 *   allActionRows — every row in the parent action (used to compute the
 *                   action-end mark; may equal widgetRows when no broader
 *                   context is available)
 *
 * Returns a complete ECharts option, or an option with a "no data" title
 * when the rows are too sparse to plot.
 */
export function buildWidgetTimingOption(widgetRows /* allActionRows kept off — duration-based layout */) {
  if (!widgetRows?.length) return emptyOption('No data for this widget.')

  const headers = Object.keys(widgetRows[0] ?? {})
  const m = detectMapping(headers)
  if (!m.measure || !m.duration) {
    return emptyOption('CSV is missing WIDGET_MEASURE or DURATION columns.')
  }

  const offset  = pickPhase(widgetRows, m, ['offset'])
  const render  = pickPhase(widgetRows, m, ['render', 'frontend'])
  const backend = pickPhase(widgetRows, m, ['backend'])
  const hasBackend = !!backend

  const phases = hasBackend
    ? [
        ['offset',          'Offset',                     offset],
        ['render',          'Render',                     render],
        // This CSV's WIDGET_SUBMEASURE for network rows is one of
        // 'ttfb' / 'waiting' / 'contentDownload' — there is no literal
        // 'Full' value. Per the data owner, the `ttfb` row IS the full
        // network round-trip, so we map it to the "Network (Full)" bar.
        ['network-full',    'Network (Full)',             pickPhase(widgetRows, m, ['network'], { include: ['ttfb'] })],
        ['backend',         'Backend',                    backend],
        ['network-wait',    'Network (waiting)',          pickPhase(widgetRows, m, ['network'], { include: ['waiting', 'wait'] })],
        ['network-cdn',     'Network (Content Download)', pickPhase(widgetRows, m, ['network'], { include: ['contentdownload', 'contentdl', 'download'] })],
      ]
    : [
        ['offset', 'Offset', offset],
        ['render', 'Render', render],
      ]

  if (phases.every(([, , p]) => !p)) {
    return emptyOption('No Offset/Render/Backend rows for this widget.')
  }

  // Layout is duration-based, NOT timestamp-based: each bar's width comes
  // straight from the row's DURATION column, positioned end-to-end starting
  // at x=0. So Offset spans [0, offsetDur], Render spans [offsetDur,
  // offsetDur+renderDur], etc. Using DURATION (rather than end-start)
  // matters because some sub-measure rows (e.g. Network (Full),
  // Network (Content Download)) have missing/zero timestamps in this CSV
  // shape even when DURATION itself is populated.
  const yLabels = phases.map(([, label]) => label)
  const phaseSegments = []
  let cursor = 0
  for (const [key, label, p] of phases) {
    const duration = Number.isFinite(p?.durationMs) && p.durationMs > 0
      ? p.durationMs
      : 0
    phaseSegments.push({
      key, label, p, duration,
      startX: cursor,
      endX: cursor + duration,
    })
    cursor += duration
  }

  const totalDuration = cursor
  if (totalDuration <= 0) {
    return emptyOption('Phase rows are missing or have zero duration.')
  }

  // Per design: Render's bar visually spans from its own start all the way
  // to the Action End line — i.e. its width covers render + network(full)
  // + backend + network(waiting) + network(content download). The same
  // stretch-to-end treatment applies to Network (Full), Backend, and
  // Network (waiting), so every bar from Render onwards reads as
  // "everything from here to the action end." The cursor positions of
  // later phases are NOT changed; the bars just sit visually behind the
  // shorter ones that follow. Tooltips still show each phase's true
  // duration.
  const stretchPhases = new Set(['render', 'network-full', 'backend', 'network-wait'])
  for (const seg of phaseSegments) {
    if (stretchPhases.has(seg.key)) {
      seg.displayDuration = Math.max(seg.duration, totalDuration - seg.startX)
      seg.displayStartX   = seg.startX
    } else {
      seg.displayDuration = seg.duration
      seg.displayStartX   = seg.startX
    }
  }

  // Non-stretched phases that are present but sub-millisecond would render
  // invisibly thin. Pad those bars up to a minimum visible width by moving
  // their LEFT edge earlier (start) — the right edge stays put, so the
  // Action End line and totalDuration are unaffected. Each phase lives on
  // its own y-category, so widening one phase's bar leftwards doesn't
  // overlap any other bar's pixels.
  const minVisibleWidth = Math.max(totalDuration * 0.015, 3)
  for (const seg of phaseSegments) {
    if (stretchPhases.has(seg.key)) continue
    if (seg.duration <= 0) continue
    if (seg.displayDuration < minVisibleWidth) {
      const padded = Math.min(minVisibleWidth, seg.endX) // never extend past x=endX
      seg.displayDuration = padded
      seg.displayStartX   = Math.max(0, seg.endX - padded)
    }
  }

  // Each phase contributes to THREE stacked series:
  //   spacer    — invisible offset so the bar starts at the right x position
  //   duration  — the bar's TRUE measured duration, in its phase color
  //   extension — for stretched phases, the extra width past the true
  //               duration, drawn in a faded version of the same color.
  //               The boundary between the two is naturally visible as a
  //               color change; we also give the duration bar a right
  //               border so the cut-off is crisp.
  const spacerData = []
  const durationData = []
  const extensionData = []
  for (const seg of phaseSegments) {
    const trueDur = seg.duration
    // For stretched phases the duration bar still draws at the true width;
    // for non-stretched padded phases, the duration bar fills the entire
    // (padded) visible width since there's no extension portion to draw.
    const drawDur = stretchPhases.has(seg.key) ? trueDur : seg.displayDuration
    const extDur  = Math.max(0, seg.displayDuration - drawDur)
    if (seg.displayDuration > 0) {
      spacerData.push(seg.displayStartX)
      durationData.push({
        value: drawDur,
        trueDurationMs: trueDur,
        itemStyle: {
          color: PHASE_COLOR[seg.key],
          // A 1px right border draws a clean line where the true duration
          // ends and the extension begins; harmless on non-stretched bars
          // since their extension width is 0 and the border lands at the
          // bar's right edge.
          borderColor: '#1d2d3e',
          borderWidth: extDur > 0 ? 1 : 0,
          borderType: 'solid',
        },
        phaseLabel: seg.label,
        startAbs: seg.p?.start,
        endAbs: seg.p?.end,
      })
      extensionData.push({
        value: extDur,
        trueDurationMs: trueDur,
        itemStyle: {
          color: extDur > 0 ? withAlpha(PHASE_COLOR[seg.key], 0.28) : 'transparent',
        },
        phaseLabel: seg.label,
        isExtension: true,
        startAbs: seg.p?.start,
        endAbs: seg.p?.end,
      })
    } else {
      spacerData.push(0)
      durationData.push({
        value: 0,
        trueDurationMs: 0,
        itemStyle: { color: 'transparent' },
        phaseLabel: seg.label,
        missing: true,
      })
      extensionData.push({ value: 0, itemStyle: { color: 'transparent' } })
    }
  }

  // markLines anchor Action Start at x=0 (left edge of Offset) and Action
  // End at x=totalDuration (right edge of the last phase). Each line gets
  // TWO labels stacked above it: the formatted time on top, then the
  // "Action Start/End Timestamp" tag just below it. Middle x-axis ticks
  // (500 ms, 1.00 s, etc.) stay below the plot as usual.
  const xMax = totalDuration * 1.12
  const markLineData = [
    // Action Start — line + "Action Start Timestamp" tag above
    {
      xAxis: 0,
      label: {
        formatter: 'Action Start Timestamp',
        position: 'end',
        distance: [0, 6],
        color: '#1d2d3e',
        fontSize: 11,
        rotate: 0,
        align: 'center',
        verticalAlign: 'bottom',
      },
      lineStyle: { color: '#1d2d3e', type: 'solid', width: 1 },
    },
    // Action Start — duration readout ABOVE the tag (transparent line so
    // we don't double-draw).
    {
      xAxis: 0,
      label: {
        formatter: fmtMs(0),
        position: 'end',
        distance: [0, 22],
        color: '#1d2d3e',
        fontSize: 11,
        fontWeight: 600,
        rotate: 0,
        align: 'center',
        verticalAlign: 'bottom',
      },
      lineStyle: { color: 'transparent', width: 0 },
    },
    // Action End — line + "Action End Timestamp" tag above
    {
      xAxis: totalDuration,
      label: {
        formatter: 'Action End Timestamp',
        position: 'end',
        distance: [0, 6],
        color: '#1d2d3e',
        fontSize: 11,
        rotate: 0,
        align: 'center',
        verticalAlign: 'bottom',
      },
      lineStyle: { color: '#1d2d3e', type: 'solid', width: 1 },
    },
    // Action End — total duration ABOVE the tag.
    {
      xAxis: totalDuration,
      label: {
        formatter: fmtMs(totalDuration),
        position: 'end',
        distance: [0, 22],
        color: '#1d2d3e',
        fontSize: 11,
        fontWeight: 600,
        rotate: 0,
        align: 'center',
        verticalAlign: 'bottom',
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
        if (!d) return ''
        if (d.missing) return `<strong>${escape(d.phaseLabel)}</strong><br/><em>no data</em>`
        // Tooltip shows the *true* duration so a stretched bar (e.g. the
        // Render bar that spans render+network+backend in display) still
        // reads its real phase duration to the user. Hovering the faded
        // extension segment shows the same duration but flags that this
        // half is the stretched portion.
        const ms = Number(d.trueDurationMs ?? d.value)
        const lines = [
          `<strong>${escape(d.phaseLabel)}</strong>`,
          `Duration: ${fmtMs(ms)}`,
          `Start: ${fmtTs(d.startAbs)}`,
          `End: ${fmtTs(d.endAbs)}`,
        ]
        if (d.isExtension) lines.push('<em>extended for layout</em>')
        return lines.join('<br/>')
      },
    },
    grid: { ...BASE_GRID, left: 180, right: 32, top: 80, bottom: 56 },
    xAxis: {
      type: 'value',
      min: 0,
      max: xMax > 0 ? xMax : undefined,
      // The x-axis is padded slightly past totalDuration so the Action End
      // markLine and its label sit inside the plot area — but we don't want
      // ECharts to auto-generate tick labels (or splitlines) in that
      // trailing empty space, since they read as "there's more time after
      // the action ended." Hide both past totalDuration.
      axisLabel: {
        formatter: (v) => (v > totalDuration + 1e-6 ? '' : fmtMs(v)),
      },
      splitLine: {
        lineStyle: { color: '#e6ecf2' },
        show: true,
        showMinLine: true,
      },
    },
    yAxis: {
      type: 'category',
      data: yLabels.slice().reverse(),
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: '#1d2d3e', fontSize: 12 },
    },
    series: [
      {
        name: 'spacer',
        type: 'bar',
        stack: 'wt',
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
        stack: 'wt',
        data: durationData.slice().reverse(),
        // No rounded corners — borderRadius would round the inner edge
        // where duration meets extension, masking the separator line.
        barCategoryGap: '30%',
        markLine: markLineData.length
          ? {
              symbol: 'none',
              silent: true,
              data: markLineData,
            }
          : undefined,
      },
      {
        name: 'extension',
        type: 'bar',
        stack: 'wt',
        data: extensionData.slice().reverse(),
        barCategoryGap: '30%',
      },
    ],
  }
}

/* ——— helpers ——— */

// Turn an SAP palette color (`#RRGGBB`, `rgb(...)`, or named) into an
// rgba() string at the given alpha. Used to draw the "extended" portion
// of a stretched bar in a faded version of its true-portion color.
function withAlpha(color, alpha) {
  const s = String(color ?? '').trim()
  // #RRGGBB or #RGB
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (hex) {
    let r, g, b
    if (hex[1].length === 3) {
      r = parseInt(hex[1][0] + hex[1][0], 16)
      g = parseInt(hex[1][1] + hex[1][1], 16)
      b = parseInt(hex[1][2] + hex[1][2], 16)
    } else {
      r = parseInt(hex[1].slice(0, 2), 16)
      g = parseInt(hex[1].slice(2, 4), 16)
      b = parseInt(hex[1].slice(4, 6), 16)
    }
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  // Already rgb() or rgba() — replace/append alpha.
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(s)
  if (rgb) {
    const parts = rgb[1].split(',').map((p) => p.trim()).slice(0, 3)
    return `rgba(${parts.join(', ')}, ${alpha})`
  }
  return s
}

const PHASE_COLOR = {
  offset:         SAP_BLUE_LIGHT,
  render:         SAP_BLUE,
  'network-full': SAP_GOLD,
  backend:        SAP_BLUE_DARK,
  'network-wait': SAP_GOLD_LIGHT,
  'network-cdn':  SAP_SUCCESS,
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

function fmtTs(ms) {
  if (!Number.isFinite(ms)) return ''
  // Values from parseTs are ms-since-midnight, not ms-since-epoch, so build
  // a time-of-day string directly rather than going through `new Date(ms)`.
  const dayMs = 24 * 60 * 60 * 1000
  let n = ((ms % dayMs) + dayMs) % dayMs
  const hh = Math.floor(n / 3_600_000); n -= hh * 3_600_000
  const mm = Math.floor(n / 60_000);     n -= mm * 60_000
  const ss = Math.floor(n / 1000);       n -= ss * 1000
  const fr = Math.round(n)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(fr).padStart(3, '0')}`
}

/**
 * Pick the row with max DURATION matching `measure` (and optional submeasure
 * patterns), then return `{ start, end }` in ms-of-day. Submeasure matching
 * is substring-based on the normalized (lowercase, punctuation-stripped)
 * value, so 'Content Download' / 'content-download' / 'contentDownload' all
 * match `['contentdownload', 'download']`.
 *
 * Pass `subMatch: { include?, exclude? }` to express "match X but NOT Y" —
 * e.g. Network (Full) wants any non-specific network row, so it matches
 * everything EXCEPT 'waiting' / 'download' / 'contentdownload'.
 */
function pickPhase(rows, m, measureTargets, subMatch = null) {
  if (!m.duration || !m.measure) return null
  const wanted = new Set(measureTargets.map((t) => t.toLowerCase()))
  const include = subMatch?.include?.map(normSub) ?? null
  const exclude = subMatch?.exclude?.map(normSub) ?? null

  let best = null
  let bestDur = -Infinity
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
      best = r
    }
  }
  if (!best) return null

  const isRender = measureTargets.some((t) => t === 'render' || t === 'frontend')
  const startKey = isRender ? m.renderTimestampStart : m.widgetTimestampStart
  const endKey   = isRender ? m.renderTimestamp     : m.widgetTimestamp
  const start = parseTs(best?.[startKey])
  let end     = parseTs(best?.[endKey])
  if (!Number.isFinite(end) && Number.isFinite(start) && Number.isFinite(bestDur)) {
    end = start + bestDur
  }
  return {
    start: Number.isFinite(start) ? start : null,
    end:   Number.isFinite(end)   ? end   : null,
    // Trust the CSV's DURATION column for bar widths — timestamps in this
    // dataset are often missing/zero for sub-measure rows even when DURATION
    // is correct, so deriving width from end-start would lose those bars.
    durationMs: Number.isFinite(bestDur) ? bestDur : null,
  }
}

function normSub(s) {
  return String(s).toLowerCase().replace(/[\s_\-.]+/g, '')
}

/**
 * Best-effort timestamp parser. Returns **time-of-day in milliseconds**
 * (i.e. ms since midnight), so values from different columns are comparable
 * even when papaparse has anchored some on 1899-12-30 and parsed others as
 * raw `mm:ss.s` strings.
 *
 * The CSVs we handle are SAP/Excel exports whose timestamp cells encode
 * elapsed time as `h:mm:ss.s` or `mm:ss.s` — they're a time-of-day, not
 * a calendar moment. By collapsing every input down to "ms since 00:00",
 * the date part stops mattering and subtractions across columns stay sane.
 *
 * Accepts:
 *   - JS Date (papaparse output) — take .getHours/getMinutes/getSeconds/getMilliseconds
 *   - "h:mm:ss[.s]" / "mm:ss[.s]" string — parsed as time-of-day
 *   - finite number — assumed already-in-ms time-of-day
 *   - ISO / RFC string — Date.parse'd, then time-of-day extracted
 */
function parseTs(v) {
  if (v == null || v === '') return NaN

  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return timeOfDayMs(v.getHours(), v.getMinutes(), v.getSeconds(), v.getMilliseconds())
  }

  if (typeof v === 'number' && Number.isFinite(v)) {
    // Already a numeric ms-of-day; clamp into [0, 24h) just in case.
    const day = 24 * 60 * 60 * 1000
    let n = v % day
    if (n < 0) n += day
    return n
  }

  const s = String(v).trim()

  // Strict "[h:]mm:ss[.s]" parse first — covers the SAP/Excel time-only shape.
  const tod = parseTimeOfDayString(s)
  if (Number.isFinite(tod)) return tod

  // Fallback for ISO / RFC strings — pull the time-of-day out of the Date.
  const d = Date.parse(s)
  if (!Number.isNaN(d)) {
    const date = new Date(d)
    return timeOfDayMs(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds())
  }

  return NaN
}

function timeOfDayMs(h, m, s, ms) {
  return ((h * 60 + m) * 60 + s) * 1000 + ms
}

// Parse "[h:]mm:ss[.s]" into ms-since-midnight. Returns NaN on miss.
function parseTimeOfDayString(s) {
  if (!/^\d+:\d/.test(s)) return NaN
  const parts = s.split(':')
  if (parts.length < 2 || parts.length > 3) return NaN
  const seconds = parseFloat(parts[parts.length - 1])
  const minutes = parseInt(parts[parts.length - 2], 10)
  const hours = parts.length === 3 ? parseInt(parts[0], 10) : 0
  if (!Number.isFinite(seconds) || !Number.isFinite(minutes) || !Number.isFinite(hours)) return NaN
  const wholeSec = Math.floor(seconds)
  const fracMs = Math.round((seconds - wholeSec) * 1000)
  return timeOfDayMs(hours, minutes, wholeSec, fracMs)
}

function detectMapping(headers) {
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
    renderTimestamp: find(
      ['widgetrendertimestamp'],
      ['widgetrendertimestamp'],
      (h) => norm(h).includes('start'),
    ),
    renderTimestampStart: find(['widgetrendertimestampstart'], ['widgetrendertimestampstart']),
    widgetTimestamp: find(
      ['widgettimestamp'],
      ['widgettimestamp'],
      (h) => {
        const n = norm(h)
        return n.includes('render') || n.includes('start')
      },
    ),
    widgetTimestampStart: find(
      ['widgettimestampstart'],
      ['widgettimestampstart'],
      (h) => norm(h).includes('render'),
    ),
  }
}
