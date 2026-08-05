/**
 * Session-level aggregation for the Session View summary table.
 *
 * One row per distinct session, with columns:
 *   Session · User · Story · Timestamp · Total action duration ·
 *   Action count · Max action duration
 *
 * "Timestamp" is the session's start → end range: the earliest and latest
 * ACTION_TIMESTAMP seen inside the session, rendered as "start → end".
 * Sorts by the start value so the column is chronologically orderable. A
 * session with only one distinct timestamp (no real span) has its end filled
 * in with the latest timestamp seen anywhere in the file — the assumption being
 * it stayed open until the last recorded activity — so it renders a range and
 * counts as active through then on the Activity Timeline.
 *
 * "Total action duration" sums each action's duration within the session, and
 * "Max action duration" is the largest. An action's duration is the span from
 * its ACTION_TIMESTAMP to the LATEST WIDGET_RENDER_TIMESTAMP among its widgets
 * (matching Action View's `action_duration`); actions are grouped by
 * USER_ACTION + ACTION_TIMESTAMP so two fires of the same action name at
 * different times stay separate. When the CSV has no render-timestamp column,
 * both fall back to the per-action max DURATION.
 *
 * Auto-detects the grouping column + the field columns by name, normalizing
 * case and separators so "SESSION_ID", "session_id", "Session ID" all
 * resolve to the same header. Tuned for this app's CSV shape
 * (BROWSERSESSION_ID, SESSION_ID, USER_NAME, STORY_NAME, DURATION) but
 * tolerant of variants.
 *
 * Returns `{ rows, columns, mapping, sessionKey }` so the table component
 * can render predictable columns and surface what was detected.
 */

import { actionRenderDurations } from './actionAggregate'
import { stripUserPrefix } from './format'
import { memoizeAggregate } from './memoize'
import { parseStrictTimestamp } from './timeBuckets'

export const aggregateBySession = memoizeAggregate(aggregateBySessionImpl)

function aggregateBySessionImpl(rows, headers) {
  const mapping = detectMapping(headers, rows)

  const columns = [
    { key: 'session',               label: 'Session' },
    { key: 'user',                  label: 'User' },
    { key: 'story',                 label: 'Story' },
    { key: 'total_action_duration', label: 'Total action duration', sortType: 'duration' },
    { key: 'action_count',          label: 'Action count',          sortType: 'number' },
    { key: 'max_action_duration',   label: 'Max action duration',   sortType: 'duration' },
  ]

  const sessionKey = mapping.session
  if (!sessionKey || !rows?.length) {
    return { rows: [], columns, mapping, sessionKey }
  }

  // Group by session, preserving first-seen order.
  const groups = new Map()
  for (const row of rows) {
    const sid = row?.[sessionKey]
    if (sid === undefined || sid === null || sid === '') continue
    const key = String(sid)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  const outRows = []
  const latestStamp = latestTimestamp(rows, mapping.actionTimestamp)
  for (const [sessionId, groupRows] of groups) {
    const { start, end: rawEnd, hasMarker } = timestampRange(groupRows, mapping.actionTimestamp)
    // A session "never ended" when it has only one distinct timestamp (no real
    // span) OR one of its rows carries a "never ended" marker instead of a real
    // end timestamp — the app's data uses the literal token "ttfb" for a load
    // that never returned. Either way we assume it stayed open until the last
    // activity recorded anywhere in the file, so it renders a range and counts
    // as active through then on the Activity Timeline.
    const singleTimestamp = start !== '' && cmpStamp(start, rawEnd) === 0
    const neverEnded = hasMarker || singleTimestamp
    const end =
      neverEnded && laterStamp(latestStamp, rawEnd)
        ? latestStamp
        : rawEnd
    // Per-action render-durations (MAX(WIDGET_RENDER_TIMESTAMP) − ACTION_TIMESTAMP
    // per action) when the CSV carries a render-timestamp column, so Session
    // View's total/max match Action View's new `action_duration`. Falls back to
    // the DURATION-based per-action max when there's no render-timestamp column.
    const renderDurations = mapping.renderTimestamp
      ? actionRenderDurations(groupRows, mapping.renderTimestamp, mapping.actionTimestamp, mapping.actionName)
      : null
    outRows.push({
      session: sessionId,
      user: stripUserPrefix(firstNonEmpty(groupRows, mapping.user)),
      story: firstNonEmpty(groupRows, mapping.story),
      // `timestamp_range` is the sortable start value; `_timestamp_end` is
      // carried alongside so the table can render "start → end" without
      // recomputing.
      timestamp_range: start,
      _timestamp_end: end,
      total_action_duration: renderDurations
        ? sumMapValues(renderDurations)
        : sumMaxPerAction(
            groupRows,
            mapping.duration,
            mapping.actionName,
            mapping.actionTimestamp,
          ),
      action_count: groupRows.length,
      max_action_duration: renderDurations
        ? maxMapValues(renderDurations)
        : maxNumeric(groupRows, mapping.duration),
    })
  }

  return { rows: outRows, columns, mapping, sessionKey }
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

function maxNumeric(rows, key) {
  if (!key) return ''
  let max = -Infinity
  let found = false
  for (const r of rows) {
    const n = Number(r?.[key])
    if (Number.isFinite(n)) {
      if (n > max) max = n
      found = true
    }
  }
  return found ? max : ''
}

// Sum / max of a Map's numeric values (the per-action render-durations). Return
// '' for an empty map so an all-unparseable session renders blank, matching the
// DURATION-based helpers' "nothing finite ⇒ ''" convention.
function sumMapValues(map) {
  if (!map || map.size === 0) return ''
  let total = 0
  for (const v of map.values()) total += v
  return total
}

function maxMapValues(map) {
  if (!map || map.size === 0) return ''
  let max = -Infinity
  for (const v of map.values()) if (v > max) max = v
  return max
}

// Earliest / latest REAL timestamp seen in a session group, plus whether the
// group carries a "never ended" marker (a non-empty value that isn't a real
// timestamp — the app uses the literal token "ttfb"). start/end are returned as
// the original cell values (so display keeps the CSV's formatting) but are
// chosen by strict-parsed time, so a "ttfb" sentinel is flagged rather than
// mistaken for the latest timestamp.
function timestampRange(rows, key) {
  if (!key) return { start: '', end: '', hasMarker: false }
  let start = null
  let startMs = Infinity
  let end = null
  let endMs = -Infinity
  let hasMarker = false
  for (const r of rows) {
    const v = r?.[key]
    if (v === undefined || v === null || v === '') continue
    const d = parseStrictTimestamp(v)
    if (!d) { hasMarker = true; continue }
    const t = d.getTime()
    if (t < startMs) { startMs = t; start = v }
    if (t > endMs) { endMs = t; end = v }
  }
  return { start: start ?? '', end: end ?? '', hasMarker }
}

// Compare two timestamp cell values (Date objects or ISO-ish strings). Strings
// compare lexicographically, correct for this app's "YYYY-MM-DD HH:MM:SS.s" /
// "HH:MM:SS.s" shapes.
function cmpStamp(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

// True when `a` is a strictly later REAL timestamp than `b`. Uses strict parsing
// so a "ttfb"-style sentinel on either side never reads as later.
function laterStamp(a, b) {
  const da = parseStrictTimestamp(a)
  const db = parseStrictTimestamp(b)
  if (!da) return false
  if (!db) return true
  return da.getTime() > db.getTime()
}

// The latest REAL timestamp value present in `key` across ALL rows. Used as the
// assumed end for sessions that never ended (single timestamp, or carrying a
// "ttfb" marker), so they render a range and count as active through the last
// activity recorded anywhere in the file. Ignores non-timestamp sentinels.
function latestTimestamp(rows, key) {
  if (!key) return ''
  let latest = null
  let latestMs = -Infinity
  for (const r of rows) {
    const v = r?.[key]
    if (v === undefined || v === null || v === '') continue
    const d = parseStrictTimestamp(v)
    if (!d) continue
    const t = d.getTime()
    if (t > latestMs) { latestMs = t; latest = v }
  }
  return latest ?? ''
}


// name + timestamp so two fires of the same action at different times are
// counted separately (matching Action View grouping). Falls back to a
// straight sum of durations if we have no action-name column to group on.
function sumMaxPerAction(rows, durationKey, actionNameKey, actionTimestampKey) {
  if (!durationKey) return ''
  if (!actionNameKey) {
    let total = 0
    let found = false
    for (const r of rows) {
      const n = Number(r?.[durationKey])
      if (Number.isFinite(n)) { total += n; found = true }
    }
    return found ? total : ''
  }
  const maxByKey = new Map()
  for (const r of rows) {
    const name = r?.[actionNameKey]
    if (name === undefined || name === null || name === '') continue
    const ts = actionTimestampKey ? (r?.[actionTimestampKey] ?? '') : ''
    const key = `${name} ${ts}`
    const n = Number(r?.[durationKey])
    if (!Number.isFinite(n)) continue
    const prev = maxByKey.get(key)
    if (prev === undefined || n > prev) maxByKey.set(key, n)
  }
  if (maxByKey.size === 0) return ''
  let total = 0
  for (const v of maxByKey.values()) total += v
  return total
}

function detectMapping(headers, rows) {
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

  // Helpers: how many rows have a non-empty value in a column?
  const populatedCount = (h) => {
    if (!h || !rows?.length) return 0
    let n = 0
    for (const row of rows) {
      const v = row?.[h]
      if (v !== undefined && v !== null && v !== '') n++
    }
    return n
  }

  // Collect every session-ish header and pick the one with the most data.
  // Some exports leave SESSION_ID blank on every row even though it exists,
  // while BROWSERSESSION_ID is fully populated — we want the populated one.
  const sessionCandidates = headers.filter((h) => {
    const n = norm(h)
    return n === 'session' || n.includes('sessionid') || n === 'browsersessionid'
  })
  let session = ''
  let bestFill = 0
  for (const h of sessionCandidates) {
    const fill = populatedCount(h)
    if (fill > bestFill) {
      bestFill = fill
      session = h
    }
  }

  return {
    session,
    user: find(['username', 'user'], ['user']),
    story: find(
      ['storyname', 'story'],
      ['story'],
      (h) => {
        const n = norm(h)
        return n.includes('id') || n.includes('page') ||
               n.includes('timestamp') || n.includes('type') ||
               n.includes('mode')
      },
    ),
    duration: find(
      ['duration', 'actionduration'],
      ['duration'],
      (h) => norm(h).startsWith('widget'),
    ),
    actionName: find(
      ['useraction', 'actionname'],
      ['useraction'],
      (h) => {
        const n = norm(h)
        return n.includes('id') || n.includes('timestamp') ||
               n.includes('details') || n.includes('end')
      },
    ),
    actionTimestamp: find(
      ['actiontimestamp'],
      ['actiontimestamp'],
      (h) => norm(h).includes('end'),
    ),
    // Render END timestamp — the latest of these across an action's widgets,
    // minus ACTION_TIMESTAMP, is the per-action duration (see actionAggregate).
    renderTimestamp: find(
      ['widgetrendertimestamp'],
      ['widgetrendertimestamp'],
      (h) => norm(h).includes('start'),
    ),
  }
}
