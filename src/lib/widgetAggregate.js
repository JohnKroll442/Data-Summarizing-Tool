/**
 * Widget-level aggregation for the Widget View summary table.
 *
 * One row per distinct WIDGET_ID. Columns:
 *   Session ID · Action · Widget ID · Widget name · Phases (inline bars) ·
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

import { detectSessionKey } from './drillDown'

export function aggregateByWidget(rows, headers) {
  const mapping = detectMapping(headers)
  // Populated-column-aware session detection (SESSION_ID may exist but be
  // empty while BROWSERSESSION_ID carries the real value — pick whichever
  // has data). Attach onto the mapping so callers can see which column won.
  mapping.session = detectSessionKey(headers, rows)

  const columns = [
    { key: 'session_id',    label: 'Session ID' },
    { key: 'action_name',   label: 'Action' },
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
  for (const [widgetId, groupRows] of groups) {
    const renderPick  = pickMaxRow(groupRows, mapping.duration, mapping.measure, ['render', 'frontend'])
    const networkPick = pickMaxRow(groupRows, mapping.duration, mapping.measure, ['network'])
    const backendPick = pickMaxRow(groupRows, mapping.duration, mapping.measure, ['backend'])
    const offsetPick  = pickMaxRow(groupRows, mapping.duration, mapping.measure, ['offset'])

    for (const v of [renderPick.value, networkPick.value, backendPick.value, offsetPick.value]) {
      if (typeof v === 'number' && v > phaseMax) phaseMax = v
    }

    outRows.push({
      widget_id:     widgetId,
      widget_name:   firstNonEmpty(groupRows, mapping.widgetName),
      session_id:    firstNonEmpty(groupRows, mapping.session),
      action_name:   firstNonEmpty(groupRows, mapping.actionName),
      render:        renderPick.value,
      render_start:  phaseStart(renderPick, mapping, 'render'),
      render_end:    phaseEnd(renderPick, mapping, 'render'),
      network:       networkPick.value,
      network_start: phaseStart(networkPick, mapping, 'widget'),
      network_end:   phaseEnd(networkPick, mapping, 'widget'),
      backend:       backendPick.value,
      backend_start: phaseStart(backendPick, mapping, 'widget'),
      backend_end:   phaseEnd(backendPick, mapping, 'widget'),
      offset:        offsetPick.value,
    })
  }

  return { rows: outRows, columns, mapping, phaseMax }
}

/* ——— helpers ——— */

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
  const subWanted = subTargets && subTargets.length
    ? new Set(subTargets.map((t) => t.toLowerCase()))
    : null
  if (subWanted && !subKey) return { row: null, value: '' }
  let max = -Infinity
  let pick = null
  for (const r of rows) {
    const m = r?.[measureKey]
    if (m === undefined || m === null) continue
    if (!measureMatches(String(m).toLowerCase(), wanted)) continue
    if (subWanted) {
      const s = r?.[subKey]
      if (s === undefined || s === null) continue
      if (!subWanted.has(String(s).toLowerCase())) continue
    }
    const n = Number(r?.[durationKey])
    if (Number.isFinite(n) && n > max) {
      max = n
      pick = r
    }
  }
  return pick ? { row: pick, value: max } : { row: null, value: '' }
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

  // Action name — surfaced so the Widget view can offer an Action filter and
  // show which action a widget belongs to. Mirrors actionAggregate's detector:
  // prefer USER_ACTION / ACTION_NAME (rejecting id/timestamp/details/end
  // columns), then fall back to a bare ACTION column.
  const actionName = find(
    ['useraction', 'actionname'],
    ['useraction'],
    (h) => {
      const n = norm(h)
      return n.includes('id') || n.includes('timestamp') ||
             n.includes('details') || n.includes('end')
    },
  ) || find(['action'], ['action'], (h) => {
    const n = norm(h)
    return n.includes('id') || n.includes('timestamp') ||
           n.includes('details') || n.includes('count') || n.includes('end')
  })

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
    actionName,
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
