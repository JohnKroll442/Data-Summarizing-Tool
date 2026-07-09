/**
 * Shared helpers used by ActionView / WidgetView to figure out the session
 * column without re-running the whole session-aggregation pipeline.
 */

const norm = (s) => String(s).trim().toLowerCase().replace(/[\s_\-.]+/g, '')

/**
 * Pick the CSV column that holds the session id by inspecting the headers
 * AND the data — same logic as sessionAggregate's detector. Some exports
 * have SESSION_ID present but empty while BROWSERSESSION_ID is fully
 * populated; we want whichever has actual values.
 */
export function detectSessionKey(headers, rows) {
  if (!headers?.length) return ''
  const candidates = headers.filter((h) => {
    const n = norm(h)
    return n === 'session' || n.includes('sessionid') || n === 'browsersessionid'
  })
  let best = ''
  let bestFill = 0
  for (const h of candidates) {
    let fill = 0
    if (rows?.length) {
      for (const row of rows) {
        const v = row?.[h]
        if (v !== undefined && v !== null && v !== '') fill++
      }
    }
    if (fill >= bestFill) {
      bestFill = fill
      best = h
    }
  }
  return best
}

/**
 * Filter rows down to a specific session. No-op when sessionFilter is null
 * or the session column can't be detected.
 */
export function applySessionFilter(rows, headers, sessionFilter) {
  if (!sessionFilter) return rows
  const key = detectSessionKey(headers, rows)
  if (!key) return rows
  return rows.filter((r) => String(r?.[key] ?? '') === String(sessionFilter))
}

/**
 * Pick the CSV column that holds the action name. Shared by applyActionFilter
 * and applyActionMultiFilter so both agree on which column is the action name.
 */
export function findActionNameKey(headers) {
  return headers.find((h) => norm(h) === 'useraction') ||
         headers.find((h) => norm(h).includes('useraction')) ||
         headers.find((h) => norm(h) === 'action') ||
         ''
}

/**
 * Filter rows to those belonging to one specific action invocation.
 * actionFilter is { name, timestamp } where timestamp may be '' if the
 * source row lacked one.
 */
export function applyActionFilter(rows, headers, actionFilter) {
  if (!actionFilter) return rows
  const nameKey = findActionNameKey(headers)
  if (!nameKey) return rows
  const tsKey = headers.find((h) => norm(h) === 'actiontimestamp') ||
                headers.find((h) => norm(h).includes('actiontimestamp') && !norm(h).includes('end')) ||
                headers.find((h) => norm(h) === 'timestamp') ||
                headers.find((h) => norm(h).includes('timestamp') && !norm(h).includes('end'))
  return rows.filter((r) => {
    if (String(r?.[nameKey] ?? '') !== String(actionFilter.name)) return false
    if (actionFilter.timestamp && tsKey) {
      if (String(r?.[tsKey] ?? '') !== String(actionFilter.timestamp)) return false
    }
    return true
  })
}

/**
 * Scope rows to a set of session ids. No-op when sessionIds is empty or the
 * session column can't be detected. Complements applySessionFilter (single
 * drill-down) — callers compose them, applying the single filter first.
 */
export function applySessionMultiFilter(rows, headers, sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return rows
  const key = detectSessionKey(headers, rows)
  if (!key) return rows
  const set = new Set(sessionIds.map((s) => String(s)))
  return rows.filter((r) => set.has(String(r?.[key] ?? '')))
}

/**
 * Scope rows to a set of action names. No-op when actionNames is empty or the
 * action-name column can't be detected. Matches on name only (no timestamp),
 * so it selects every invocation of each chosen action.
 */
export function applyActionMultiFilter(rows, headers, actionNames) {
  if (!Array.isArray(actionNames) || actionNames.length === 0) return rows
  const nameKey = findActionNameKey(headers)
  if (!nameKey) return rows
  const set = new Set(actionNames.map((s) => String(s)))
  return rows.filter((r) => set.has(String(r?.[nameKey] ?? '')))
}
