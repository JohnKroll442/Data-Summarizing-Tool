/**
 * Session-level aggregation for the Session View summary table.
 *
 * One row per distinct session, with columns:
 *   Session · User · Story · Action count · Max action duration
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

export function aggregateBySession(rows, headers) {
  const mapping = detectMapping(headers, rows)

  const columns = [
    { key: 'session',             label: 'Session' },
    { key: 'user',                label: 'User' },
    { key: 'story',               label: 'Story' },
    { key: 'action_count',        label: 'Action count',        sortType: 'number' },
    { key: 'max_action_duration', label: 'Max action duration', sortType: 'duration' },
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
  for (const [sessionId, groupRows] of groups) {
    outRows.push({
      session: sessionId,
      user: firstNonEmpty(groupRows, mapping.user),
      story: firstNonEmpty(groupRows, mapping.story),
      action_count: groupRows.length,
      max_action_duration: maxNumeric(groupRows, mapping.duration),
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
  }
}
