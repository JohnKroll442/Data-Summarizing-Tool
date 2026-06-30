/**
 * Action-level aggregation for the Action View summary table.
 *
 * One row per distinct action — keyed by USER_ACTION + ACTION_TIMESTAMP so
 * the same action fired twice (e.g. two "Input control state changed"
 * events) stay separate.
 *
 * Columns:
 *   User · Action name · Widget count (distinct WIDGET_IDs) ·
 *   Max frontend · Max network · Max backend
 *
 * In this CSV shape each row carries a WIDGET_MEASURE flag of
 *   render | backend | network | offset
 * and the timing lives in DURATION. So per-action timings are computed as
 *   max(DURATION) where WIDGET_MEASURE = 'render'  → Max frontend
 *   max(DURATION) where WIDGET_MEASURE = 'backend' → Max backend
 *   max(DURATION) where WIDGET_MEASURE = 'network' → Max network (across
 *                                                    every submeasure)
 *
 * Returns { rows, columns, mapping } so the table can render predictable
 * columns and we can flag missing fields.
 */

/**
 * Measure values we recognize as phase tags. If a CSV has a WIDGET_MEASURE
 * column but none of its values match these, every phase column will come
 * back empty and the table looks broken — the UI uses this list to surface
 * a warning in that case.
 */
export const RECOGNIZED_MEASURES = ['render', 'frontend', 'network', 'backend', 'offset']

export function aggregateByAction(rows, headers) {
  const mapping = detectMapping(headers)

  const columns = [
    { key: 'user',         label: 'User' },
    { key: 'action_name',  label: 'Action name' },
    { key: 'widget_count', label: 'Widget count', sortType: 'number' },
    { key: 'max_frontend', label: 'Max frontend', sortType: 'duration' },
    { key: 'max_network',  label: 'Max network',  sortType: 'duration' },
    { key: 'max_backend',  label: 'Max backend',  sortType: 'duration' },
  ]

  if (!mapping.actionName || !rows?.length) {
    return { rows: [], columns, mapping }
  }

  // Composite key: action name + action timestamp. Falls back to just the
  // action name if there's no timestamp column.
  const keyOf = (row) => {
    const name = row?.[mapping.actionName] ?? ''
    const ts = mapping.actionTimestamp ? row?.[mapping.actionTimestamp] ?? '' : ''
    return `${name}${ts}`
  }

  const groups = new Map()
  for (const row of rows) {
    const name = row?.[mapping.actionName]
    if (name === undefined || name === null || name === '') continue
    const key = keyOf(row)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  const outRows = []
  for (const [, groupRows] of groups) {
    outRows.push({
      // Hidden meta — not in the displayed columns, but carried on the
      // row so click handlers can disambiguate two invocations of the
      // same action name fired at different times.
      _action_timestamp: mapping.actionTimestamp
        ? firstNonEmpty(groupRows, mapping.actionTimestamp)
        : '',
      user:         firstNonEmpty(groupRows, mapping.user),
      action_name:  firstNonEmpty(groupRows, mapping.actionName),
      widget_count: distinctCount(groupRows, mapping.widgetId),
      max_frontend: maxNumericWhere(groupRows, mapping.duration, mapping.measure, ['render', 'frontend']),
      max_network:  maxNumericWhere(groupRows, mapping.duration, mapping.measure, ['network']),
      max_backend:  maxNumericWhere(groupRows, mapping.duration, mapping.measure, ['backend']),
    })
  }

  return { rows: outRows, columns, mapping }
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

function distinctCount(rows, key) {
  if (!key) return ''
  const seen = new Set()
  for (const r of rows) {
    const v = r?.[key]
    if (v === undefined || v === null || v === '') continue
    seen.add(String(v))
  }
  return seen.size
}

/**
 * Max of `durationKey` across rows whose `measureKey` value (case-insensitive)
 * is one of `targets`. If `subKey`/`subTargets` are provided, also requires
 * the row's sub-measure value to match one of those (e.g. only count
 * network rows whose WIDGET_SUBMEASURE = 'ttfb').
 * Returns '' when no matching row has a finite duration.
 */
function maxNumericWhere(rows, durationKey, measureKey, targets, subKey, subTargets) {
  if (!durationKey || !measureKey) return ''
  const wanted = new Set(targets.map((t) => t.toLowerCase()))
  const subWanted = subTargets && subTargets.length
    ? new Set(subTargets.map((t) => t.toLowerCase()))
    : null
  // If a sub-measure filter was requested but the CSV has no such column,
  // we can't match anything — bail out with no value rather than silently
  // ignoring the filter.
  if (subWanted && !subKey) return ''
  let max = -Infinity
  let found = false
  for (const r of rows) {
    const m = r?.[measureKey]
    if (m === undefined || m === null) continue
    if (!wanted.has(String(m).toLowerCase())) continue
    if (subWanted) {
      const s = r?.[subKey]
      if (s === undefined || s === null) continue
      if (!subWanted.has(String(s).toLowerCase())) continue
    }
    const n = Number(r?.[durationKey])
    if (Number.isFinite(n)) {
      if (n > max) max = n
      found = true
    }
  }
  return found ? max : ''
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

  // Pick the action-name column based on what's populated and what looks
  // categorical (e.g. USER_ACTION holds "Open story", "Not specified", etc).
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

  const actionTimestamp = find(
    ['actiontimestamp'],
    ['actiontimestamp'],
    (h) => norm(h).includes('end'),
  )

  const widgetId = find(['widgetid'], ['widgetid'])

  // WIDGET_MEASURE is the flag that distinguishes render / backend / network.
  const measure = find(
    ['widgetmeasure', 'measure'],
    ['widgetmeasure'],
    (h) => {
      const n = norm(h)
      return n.includes('sub')
    },
  )

  // WIDGET_SUBMEASURE further qualifies a measure (e.g. for network rows:
  // 'ttfb' / 'waiting' / 'contentDownload' / 'Full'). Per the data owner,
  // network timings should only count rows where this column == 'ttfb'.
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

  return {
    user: find(['username', 'user'], ['user']),
    actionName,
    actionTimestamp,
    widgetId,
    measure,
    submeasure,
    duration,
  }
}
