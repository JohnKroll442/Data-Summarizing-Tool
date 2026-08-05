/**
 * Widget-level aggregation for the Widget View summary table.
 *
 * One row per distinct WIDGET_ID. Columns:
 *   Session ID · Widget ID · Widget name · Phases (inline bars) ·
 *   Render · Render start · Render end ·
 *   Network · Network start · Network end ·
 *   Backend · Backend start · Backend end · Offset
 *
 * In this CSV shape each row carries a WIDGET_MEASURE flag of
 *   render | backend | network | offset
 * and the timing lives in DURATION. So per-widget timings are computed as
 *   max(DURATION) where WIDGET_MEASURE = 'render'  → Render
 *   max(DURATION) where WIDGET_MEASURE = 'network' → Network (across every
 *                                                    submeasure — full,
 *                                                    waiting, contentDownload,
 *                                                    ttfb, etc.)
 *   max(DURATION) where WIDGET_MEASURE = 'backend' → Backend
 *   max(DURATION) where WIDGET_MEASURE = 'offset'  → Offset
 *
 * The three main phases NEST (render ⊇ network ⊇ backend), so the displayed
 * Render / Network values are made EXCLUSIVE by subtracting the phase they
 * contain: Render = render − network, Network = network − backend, Backend
 * stays as the innermost phase. See `exclusiveDuration`.
 *
 * Start/end times are pulled from the SAME row that won the max for that
 * phase, so the displayed times line up with the displayed duration.
 *   - Render: WIDGET_RENDER_TIMESTAMP_START → WIDGET_RENDER_TIMESTAMP
 *   - Network/Backend: WIDGET_TIMESTAMP_START → WIDGET_TIMESTAMP
 * Values are shown as-is from the CSV (no reformatting).
 *
 * Returns { rows, columns, mapping, phaseMax } — `phaseMax` is the largest
 * duration seen across render/network/backend/offset for ANY widget in the
 * scoped set, so the Phases column can scale all rows to the same axis.
 */

import { detectSessionKey, findActionNameKey, findActionTimestampKey } from './drillDown'
import { memoizeAggregate } from './memoize'
import { parseStrictTimestamp } from './timeBuckets'

export const aggregateByWidget = memoizeAggregate(aggregateByWidgetImpl)

function aggregateByWidgetImpl(rows, headers) {
  const mapping = detectMapping(headers)
  // Populated-column-aware session detection (SESSION_ID may exist but be
  // empty while BROWSERSESSION_ID carries the real value — pick whichever
  // has data). Attach onto the mapping so callers can see which column won.
  mapping.session = detectSessionKey(headers, rows)

  const columns = [
    { key: 'session_id',    label: 'Session ID' },
    { key: 'widget_id',     label: 'Widget ID' },
    { key: 'widget_name',   label: 'Widget name' },
    { key: 'render',        label: 'Render',        sortType: 'duration' },
    { key: 'render_start',  label: 'Render start' },
    { key: 'render_end',    label: 'Render end' },
    { key: 'network',       label: 'Network',       sortType: 'duration' },
    { key: 'network_start', label: 'Network start' },
    { key: 'network_end',   label: 'Network end' },
    { key: 'backend',       label: 'Backend',       sortType: 'duration' },
    { key: 'backend_start', label: 'Backend start' },
    { key: 'backend_end',   label: 'Backend end' },
    { key: 'offset',        label: 'Offset',        sortType: 'duration' },
    { key: 'total',         label: 'Total',         sortType: 'duration' },
  ]

  if (!mapping.widgetId || !rows?.length) {
    return { rows: [], columns, mapping, phaseMax: 0 }
  }

  const groups = new Map()
  for (const row of rows) {
    const wid = row?.[mapping.widgetId]
    if (wid === undefined || wid === null || wid === '') continue
    const key = String(wid)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  let phaseMax = 0
  const outRows = []
  // Latest timestamp anywhere in the widget data — the assumed end for widgets
  // that "never ended" (see effectiveWidgetEnd).
  const latestStamp = latestWidgetTimestamp(rows, mapping)
  for (const [widgetId, groupRows] of groups) {
    const { renderPick, networkPick, backendPick, offsetPick } = phasePicks(groupRows, mapping)

    // Per the data owner the phases NEST — render contains network contains
    // backend — so each is displayed as its EXCLUSIVE time (the slice NOT spent
    // in the phase it wraps): render − network, network − backend, and backend
    // as-is (the innermost phase). A phase with no measured value passes through
    // untouched (subtract 0); a negative result is shown as-is, flagging data
    // where an inner phase outran the one that should contain it. Timestamps and
    // the offset are untouched — only the three nested durations are adjusted.
    const render  = exclusiveDuration(renderPick.value, networkPick.value)
    const network = exclusiveDuration(networkPick.value, backendPick.value)
    const backend = backendPick.value

    // Total = the three exclusive slices added back together (render + network +
    // backend). Because the phases nest, this equals the OLD inclusive render
    // value — i.e. the widget's full wall-clock time — restoring the number the
    // Render column used to show before it was split into exclusive slices.
    const total = sumDurations([render, network, backend])

    for (const v of [render, network, backend, offsetPick.value]) {
      if (typeof v === 'number' && v > phaseMax) phaseMax = v
    }

    const render_end  = phaseEnd(renderPick, mapping, 'render')
    const network_end = phaseEnd(networkPick, mapping, 'widget')
    const backend_end = phaseEnd(backendPick, mapping, 'widget')

    // A widget "never ended" when its terminal (latest-ending) phase is the
    // network phase — a ttfb/network with no render or backend completing after
    // it — or when it has no parseable end at all. Per the data owner a ttfb is
    // an incomplete load, so (like a single-event session, see sessionAggregate)
    // we assume it stayed active until the last activity recorded anywhere in
    // the file. `_widget_end` is that effective interval end; the Activity
    // Timeline and its summary tables use it to decide the widget is active
    // across a window, even one that opens after the widget's own phases.
    const { end: _widget_end, neverEnded: _widget_never_ended } =
      effectiveWidgetEnd({ render_end, network_end, backend_end }, latestStamp)

    outRows.push({
      widget_id:     widgetId,
      widget_name:   firstNonEmpty(groupRows, mapping.widgetName),
      session_id:    firstNonEmpty(groupRows, mapping.session),
      render,
      render_start:  phaseStart(renderPick, mapping, 'render'),
      render_end,
      network,
      network_start: phaseStart(networkPick, mapping, 'widget'),
      network_end,
      backend,
      backend_start: phaseStart(backendPick, mapping, 'widget'),
      backend_end,
      total,
      offset:        offsetPick.value,
      _widget_end,
      _widget_never_ended,
    })
  }

  return { rows: outRows, columns, mapping, phaseMax }
}

/* ——— helpers ——— */

// Exclusive time for a nested phase: the containing phase's duration minus the
// duration it spends in the phase it wraps (render−network, network−backend).
// `outer`/`inner` are raw per-phase maxes read from the CSV (number, or '' when
// that phase had no rows). A non-numeric outer passes through unchanged; a
// missing inner subtracts nothing. Negatives are returned as-is on purpose.
function exclusiveDuration(outer, inner) {
  if (typeof outer !== 'number') return outer
  return typeof inner === 'number' ? outer - inner : outer
}

// Sum the numeric duration slices, ignoring empty ('') phases. Returns '' only
// when NONE of the values is a finite number, so a widget with at least one
// measured phase still gets a total. Used for the Widget view's Total column.
function sumDurations(values) {
  let sum = 0
  let any = false
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v
      any = true
    }
  }
  return any ? sum : ''
}

/**
 * The four phase picks for one widget's rows: the max-DURATION row (and value)
 * for render, network, backend and offset. Shared by aggregateByWidget (which
 * reads the picks' values + timestamps) and widgetPhaseSources (which reads the
 * picks' source rows) so the two never disagree about which row "won" a phase.
 *
 * Network = the TTFB round-trip only. Other network sub-measures ('waiting',
 * contentDownload) can be open/incomplete loads whose DURATION balloons to span
 * the whole session — that one giant value would then repeat identically across
 * every widget in the action. Restricting to ttfb keeps each widget's Network a
 * real, bounded per-request time (and distinct across widgets). When the CSV has
 * no WIDGET_SUBMEASURE column we can't tell sub-measures apart, so fall back to
 * the max across all network rows (preserves behavior for CSV shapes without it).
 */
function phasePicks(groupRows, mapping) {
  const networkPick = mapping.submeasure
    ? pickMaxRow(groupRows, mapping.duration, mapping.measure, ['network'], mapping.submeasure, ['ttfb'])
    : pickMaxRow(groupRows, mapping.duration, mapping.measure, ['network'])
  return {
    renderPick:  pickMaxRow(groupRows, mapping.duration, mapping.measure, ['render', 'frontend']),
    networkPick,
    backendPick: pickMaxRow(groupRows, mapping.duration, mapping.measure, ['backend']),
    offsetPick:  pickMaxRow(groupRows, mapping.duration, mapping.measure, ['offset']),
  }
}

/**
 * Map each widget id → the session + action it ran under FOR EACH PHASE, read
 * from the raw row that produced that phase's max duration (the same row
 * aggregateByWidget bases the phase's value on). Shape:
 *   Map<widgetId, { render, network, backend, offset }>
 * where each phase is `{ session, actionName, actionTimestamp }` or null.
 *
 * The Summary widget rankings use this so clicking "Widgets by render" drills
 * into the action where THAT widget's slowest render actually happened — a
 * widget id can recur across actions, and each phase's max may live in a
 * different one, so a single generic parent would send the user to the wrong
 * action (where the ranked value isn't reproduced). Returns an empty Map when
 * the widget-id column is unknown.
 */
export function widgetPhaseSources(rows, headers) {
  const out = new Map()
  const mapping = detectMapping(headers)
  mapping.session = detectSessionKey(headers, rows)
  if (!mapping.widgetId || !rows?.length) return out

  const actionNameKey = findActionNameKey(headers)
  const actionTsKey = findActionTimestampKey(headers)
  const parentOf = (row) => {
    if (!row) return null
    const actionName = actionNameKey ? String(row?.[actionNameKey] ?? '') : ''
    const session = mapping.session ? String(row?.[mapping.session] ?? '') : ''
    if (!actionName && !session) return null
    return {
      session,
      actionName,
      actionTimestamp: actionTsKey ? String(row?.[actionTsKey] ?? '') : '',
    }
  }

  const groups = new Map()
  for (const row of rows) {
    const wid = row?.[mapping.widgetId]
    if (wid === undefined || wid === null || wid === '') continue
    const key = String(wid)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  for (const [widgetId, groupRows] of groups) {
    const { renderPick, networkPick, backendPick, offsetPick } = phasePicks(groupRows, mapping)
    out.set(widgetId, {
      render:  parentOf(renderPick.row),
      network: parentOf(networkPick.row),
      backend: parentOf(backendPick.row),
      offset:  parentOf(offsetPick.row),
    })
  }
  return out
}

/**
 * Full widget-phase column mapping for a header set (widget id, measure,
 * submeasure, duration, timestamp columns). Exported so Action View can build
 * it ONCE and reuse it across every action group when computing exclusive phase
 * maxima — instead of re-detecting per group.
 */
export function detectWidgetMapping(headers) {
  return detectMapping(headers || [])
}

/**
 * Max EXCLUSIVE phase durations across the widgets in a set of rows — the same
 * values the Widget View table shows for each widget id (render − network,
 * network − backend, backend as-is), reduced to the max across widgets. Action
 * View uses this for its Max frontend / Max network / Max backend columns so an
 * action's maxes equal the largest widget value the user sees after drilling
 * into that action (the widget table, filtered to that action, groups by the
 * same widget id).
 *
 * `mapping` is a detectWidgetMapping(headers) result. When there's no widget-id
 * column to group on, the whole set is treated as one group (exclusive is then
 * applied to the action-aggregate maxes). Returns { frontend, network, backend }
 * — each '' when no widget has that phase. Negatives are preserved (an inner
 * phase outran the one that should contain it), consistent with the table.
 */
export function maxExclusivePhases(rows, mapping) {
  const empty = { frontend: '', network: '', backend: '' }
  if (!mapping || !rows?.length) return empty

  const groups = new Map()
  if (mapping.widgetId) {
    for (const row of rows) {
      const wid = row?.[mapping.widgetId]
      if (wid === undefined || wid === null || wid === '') continue
      const key = String(wid)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(row)
    }
  } else {
    // No widget id: can't split by widget, so treat the action's rows as one
    // unit and apply exclusive to its aggregate maxes.
    groups.set('*', rows)
  }

  // Keep the larger of the running max and a candidate; '' means "no value yet".
  // A non-numeric candidate (a phase this widget lacks) leaves the max untouched.
  const higher = (cur, v) => (typeof v === 'number' && (cur === '' || v > cur) ? v : cur)

  let frontend = ''
  let network = ''
  let backend = ''
  for (const [, groupRows] of groups) {
    const { renderPick, networkPick, backendPick } = phasePicks(groupRows, mapping)
    frontend = higher(frontend, exclusiveDuration(renderPick.value, networkPick.value))
    network = higher(network, exclusiveDuration(networkPick.value, backendPick.value))
    backend = higher(backend, backendPick.value)
  }
  return { frontend, network, backend }
}

// The effective interval end for a widget, and whether it "never ended".
// Terminal phase = the phase with the latest parseable end; a real completion
// (render/backend) wins ties over network so a load that finishes exactly when
// its ttfb sample lands still counts as ended. A widget never ended when its
// terminal phase is the network phase, nothing parses, or any phase end carries
// a "never ended" marker (a non-empty value that isn't a real timestamp — the
// app uses the literal token "ttfb"). Such a widget's end is pushed out to
// `latestStamp` (the last activity in the file) when that is later than its own
// last real phase. Returns the raw end value untouched otherwise.
function effectiveWidgetEnd(ends, latestStamp) {
  const ms = (v) => {
    const d = parseStrictTimestamp(v)
    return d ? d.getTime() : null
  }
  const isMarker = (v) => {
    const s = String(v ?? '').trim()
    return s !== '' && parseStrictTimestamp(v) === null
  }
  let terminal = null
  let terminalMs = -Infinity
  const consider = (phase, m, winsTie) => {
    if (m === null) return
    if (m > terminalMs || (winsTie && m === terminalMs)) {
      terminalMs = m
      terminal = phase
    }
  }
  // Order matters for ties: network first, then render/backend override it.
  consider('network', ms(ends.network_end), false)
  consider('render', ms(ends.render_end), true)
  consider('backend', ms(ends.backend_end), true)

  const hasMarker = isMarker(ends.render_end) || isMarker(ends.network_end) || isMarker(ends.backend_end)
  const neverEnded = terminal === null || terminal === 'network' || hasMarker
  const latestMs = ms(latestStamp)
  if (neverEnded && latestMs !== null && (terminal === null || latestMs > terminalMs)) {
    return { end: latestStamp, neverEnded: true }
  }
  const endStr = terminal === 'render' ? ends.render_end
    : terminal === 'backend' ? ends.backend_end
    : terminal === 'network' ? ends.network_end
    : ''
  return { end: endStr, neverEnded }
}

// Latest parseable timestamp across every timestamp column widgets read, over
// ALL rows. Compared numerically (not lexically) because phaseStart can emit an
// ISO "…T…Z" string while phaseEnd returns the CSV's space-separated shape, and
// those don't sort correctly as strings. Strict parsing ignores "ttfb"-style
// sentinels so they can't masquerade as the latest timestamp.
function latestWidgetTimestamp(rows, mapping) {
  const cols = [
    mapping.renderTimestampStart, mapping.renderTimestamp,
    mapping.widgetTimestampStart, mapping.widgetTimestamp,
    mapping.rowTimestamp,
  ].filter(Boolean)
  if (!cols.length || !rows?.length) return null
  let latest = null
  for (const r of rows) {
    for (const c of cols) {
      const d = parseStrictTimestamp(r?.[c])
      if (d && (latest === null || d.getTime() > latest.getTime())) latest = d
    }
  }
  return latest
}

function firstNonEmpty(rows, key) {
  if (!key) return ''
  for (const r of rows) {
    const v = r?.[key]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return ''
}

function cellValue(row, key) {
  if (!row || !key) return ''
  const v = row[key]
  if (v === undefined || v === null) return ''
  return String(v)
}

/**
 * Phase end timestamp. Prefers the dedicated column
 * (WIDGET_RENDER_TIMESTAMP for render, WIDGET_TIMESTAMP for network/backend);
 * falls back to the row's generic TIMESTAMP if the dedicated one is missing.
 */
function phaseEnd(pick, mapping, phase) {
  if (!pick?.row) return ''
  const endKey = phase === 'render' ? mapping.renderTimestamp : mapping.widgetTimestamp
  if (endKey) return cellValue(pick.row, endKey)
  return cellValue(pick.row, mapping.rowTimestamp)
}

/**
 * Phase start timestamp. Prefers the dedicated *_START column; falls back to
 * (row TIMESTAMP − DURATION) when the CSV doesn't carry a start column.
 * Returns '' if the row timestamp isn't a parseable date or duration isn't
 * finite — better to leave the cell blank than show garbage.
 */
function phaseStart(pick, mapping, phase) {
  if (!pick?.row) return ''
  const startKey = phase === 'render' ? mapping.renderTimestampStart : mapping.widgetTimestampStart
  if (startKey) return cellValue(pick.row, startKey)
  const endStr = cellValue(pick.row, mapping.rowTimestamp)
  if (!endStr) return ''
  const endMs = Date.parse(endStr)
  const duration = Number(pick.value)
  if (!Number.isFinite(endMs) || !Number.isFinite(duration)) return ''
  return new Date(endMs - duration).toISOString()
}

/**
 * Pick the row with the maximum `durationKey` value among rows whose
 * measure (and optional sub-measure) match. Returns `{ row, value }` —
 * `row` is the winning source row (so callers can pull timestamps off
 * the same row that contributed the max duration), and `value` is the
 * max DURATION itself. Both are '' when nothing matched.
 */
function pickMaxRow(rows, durationKey, measureKey, targets, subKey, subTargets) {
  if (!durationKey || !measureKey) return { row: null, value: '' }
  const wanted = targets.map((t) => t.toLowerCase())
  const subPatterns = subTargets && subTargets.length
    ? subTargets.map((t) => normSub(t))
    : null
  let max = -Infinity
  let pick = null
  for (const r of rows) {
    const m = r?.[measureKey]
    if (m === undefined || m === null) continue
    const mv = String(m).toLowerCase()
    if (!measureMatches(mv, wanted)) continue
    if (subPatterns && !subMatches(mv, subKey ? r?.[subKey] : '', subPatterns)) continue
    const n = Number(r?.[durationKey])
    if (Number.isFinite(n) && n > max) {
      max = n
      pick = r
    }
  }
  return pick ? { row: pick, value: max } : { row: null, value: '' }
}

// Normalize a sub-measure/measure fragment for matching: lowercase and strip
// spaces/underscores/dashes/dots so 'Content Download', 'content-download' and
// 'contentDownload' all compare equal.
function normSub(s) {
  return String(s ?? '').toLowerCase().replace(/[\s_\-.]+/g, '')
}

// Does a row match one of the wanted sub-measures? True when either the
// dedicated WIDGET_SUBMEASURE value contains the target (real SAP shape, e.g.
// submeasure = 'ttfb'), OR the target is folded into WIDGET_MEASURE as
// `<measure>_<target>` (alternate shape, e.g. measure = 'network_ttfb').
function subMatches(measureVal, subVal, subPatterns) {
  const s = normSub(subVal)
  if (s && subPatterns.some((p) => s.includes(p))) return true
  const idx = measureVal.indexOf('_')
  if (idx >= 0) {
    const folded = normSub(measureVal.slice(idx + 1))
    if (folded && subPatterns.some((p) => folded.includes(p))) return true
  }
  return false
}

// Match measure values against target names, accepting either exact equality
// or a `<target>_<suffix>` form where the suffix names a submeasure folded
// into the measure column (e.g. WIDGET_MEASURE = 'network_ttfb' should match
// target 'network').
export function measureMatches(value, targets) {
  const v = String(value ?? '').toLowerCase()
  for (const t of targets) {
    const tl = String(t).toLowerCase()
    if (v === tl) return true
    if (v.startsWith(`${tl}_`)) return true
  }
  return false
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

  const widgetId = find(
    ['widgetid', 'instanceid'],
    ['widgetid', 'instanceid'],
  )

  // `widgetname` is an unambiguous exact match — no need for substring
  // rejection (and the previous reject('id') accidentally caught
  // "widgetname" because "wIDgetname" literally contains the letters "id").
  // Falls back to WIDGET_TYPE when no dedicated name column exists.
  const widgetName = find(['widgetname'], ['widgetname']) ||
                     find(['widgettype'], ['widgettype'])

  const measure = find(
    ['widgetmeasure', 'measure'],
    ['widgetmeasure'],
    (h) => norm(h).includes('sub'),
  )

  // Per the data owner, network rows only count when WIDGET_SUBMEASURE = 'ttfb'.
  const submeasure = find(
    ['widgetsubmeasure', 'submeasure'],
    ['widgetsubmeasure', 'submeasure'],
  )

  const duration = find(
    ['duration'],
    ['duration'],
    (h) => {
      const n = norm(h)
      return n.startsWith('widget') || n.includes('action') ||
             n.includes('story') || n.includes('session')
    },
  ) || find(['duration'], ['duration'])

  // Render uses its own dedicated start/end columns; backend & network/ttfb
  // share the generic WIDGET_TIMESTAMP_START / WIDGET_TIMESTAMP pair.
  // Exact-match first so we don't pick up timestamp columns that happen to
  // contain the substring "render" inside another name.
  const renderTimestamp = find(
    ['widgetrendertimestamp'],
    ['widgetrendertimestamp'],
    (h) => norm(h).includes('start'),
  )
  const renderTimestampStart = find(
    ['widgetrendertimestampstart'],
    ['widgetrendertimestampstart'],
  )
  const widgetTimestamp = find(
    ['widgettimestamp'],
    ['widgettimestamp'],
    (h) => {
      const n = norm(h)
      return n.includes('render') || n.includes('start')
    },
  )
  const widgetTimestampStart = find(
    ['widgettimestampstart'],
    ['widgettimestampstart'],
    (h) => norm(h).includes('render'),
  )

  // Generic per-row timestamp (e.g. `TIMESTAMP`). Used to synthesize phase
  // start/end when the CSV has no dedicated WIDGET_RENDER_TIMESTAMP* /
  // WIDGET_TIMESTAMP* columns: end = row timestamp, start = end − duration.
  const rowTimestamp = find(
    ['timestamp'],
    ['timestamp'],
    (h) => {
      const n = norm(h)
      return n.includes('render') || n.includes('start') || n.includes('end') ||
             n.includes('widget') || n.includes('action')
    },
  )

  return {
    widgetId,
    widgetName,
    measure,
    submeasure,
    duration,
    renderTimestamp,
    renderTimestampStart,
    widgetTimestamp,
    widgetTimestampStart,
    rowTimestamp,
  }
}

/**
 * Lightweight mapping detector — returns just { measure, duration } for
 * consumers that don't need the full widget-timing mapping (e.g. the
 * synthetic-measure augmenter in src/lib/syntheticMeasures.js).
 */
export function detectMeasureMapping(headers) {
  const m = detectMapping(headers || [])
  return { measure: m.measure, duration: m.duration }
}
