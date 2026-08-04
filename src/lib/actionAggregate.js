/**
 * Action-level aggregation for the Action View summary table.
 *
 * One row per distinct action — keyed by USER_ACTION + ACTION_TIMESTAMP so
 * the same action fired twice (e.g. two "Input control state changed"
 * events) stay separate.
 *
 * Columns:
 *   Session ID · User · Action name · Widget count (distinct WIDGET_IDs) ·
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

import { detectSessionKey } from './drillDown'
import { stripUserPrefix } from './format'
import { memoizeAggregate } from './memoize'
import { parseStrictTimestamp } from './timeBuckets'

export const aggregateByAction = memoizeAggregate(aggregateByActionImpl)

function aggregateByActionImpl(rows, headers) {
  const mapping = detectMapping(headers)
  // Populated-column-aware session detection (SESSION_ID may exist but be
  // empty while BROWSERSESSION_ID carries the real value — pick whichever
  // has data). Attach onto the mapping so callers can see which column won.
  mapping.session = detectSessionKey(headers, rows)

  const columns = [
    { key: 'session_id',      label: 'Session ID' },
    { key: 'action_timestamp', label: 'Action timestamp', sortType: 'timestamp' },
    { key: 'user',            label: 'User' },
    { key: 'action_name',     label: 'Action name' },
    { key: 'story_name',      label: 'Story name' },
    { key: 'action_duration', label: 'Action duration', sortType: 'duration' },
    { key: 'story_page',      label: 'Story page' },
    { key: 'widget_count',    label: 'Widget count', sortType: 'number' },
    { key: 'max_frontend',    label: 'Max frontend', sortType: 'duration' },
    { key: 'max_network',     label: 'Max network',  sortType: 'duration' },
    { key: 'max_backend',     label: 'Max backend',  sortType: 'duration' },
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
    const actionTs = mapping.actionTimestamp
      ? firstNonEmpty(groupRows, mapping.actionTimestamp)
      : ''
    outRows.push({
      // Hidden meta — not in the displayed columns, but carried on the
      // row so click handlers can disambiguate two invocations of the
      // same action name fired at different times.
      _action_timestamp: actionTs,
      session_id:   firstNonEmpty(groupRows, mapping.session),
      // Displayed copy of the action timestamp (underscore-prefixed key stays
      // the click-handler meta; this one renders in the table).
      action_timestamp: actionTs,
      user:         stripUserPrefix(firstNonEmpty(groupRows, mapping.user)),
      action_name:  firstNonEmpty(groupRows, mapping.actionName),
      story_name:   firstNonEmpty(groupRows, mapping.storyName),
      // The action's duration: the span from ACTION_TIMESTAMP to the LATEST
      // WIDGET_RENDER_TIMESTAMP among the action's widgets — i.e. how long
      // until the last widget in this action finished rendering. Per the data
      // owner this is more robust than max(DURATION) (which mixes measures and
      // is prone to the incomplete-load inconsistencies). Falls back to
      // max(DURATION) only when the CSV carries no WIDGET_RENDER_TIMESTAMP
      // column at all. Session View sums/maxes this same per-action value.
      action_duration: mapping.renderTimestamp
        ? actionRenderDuration(groupRows, mapping.renderTimestamp, mapping.actionTimestamp)
        : maxNumeric(groupRows, mapping.duration),
      story_page:   firstNonEmpty(groupRows, mapping.storyPage),
      widget_count: distinctCount(groupRows, mapping.widgetId),
      max_frontend: maxNumericWhere(groupRows, mapping.duration, mapping.measure, ['render', 'frontend']),
      // Network = TTFB round-trip only (see widgetAggregate for the full
      // rationale): other network sub-measures can be open/incomplete loads
      // that span the whole session, showing the same giant value on every
      // widget. Fall back to all-network max when there's no WIDGET_SUBMEASURE
      // column to distinguish them.
      max_network:  mapping.submeasure
        ? maxNumericWhere(groupRows, mapping.duration, mapping.measure, ['network'], mapping.submeasure, ['ttfb'])
        : maxNumericWhere(groupRows, mapping.duration, mapping.measure, ['network']),
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

// Max of `key` (a numeric measure) across rows. Returns '' when no row has a
// finite value — mirrors the helper Session View uses for its per-action max.
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

/**
 * The action's render-based duration:
 *   MAX(WIDGET_RENDER_TIMESTAMP) across the action's widget rows − ACTION_TIMESTAMP.
 * Both sides are parsed strictly to epoch ms (so "ttfb"-style sentinels never
 * masquerade as a real timestamp), and the result is a millisecond span — the
 * same unit as DURATION, so it sorts and filters like the old value did.
 *
 * `groupRows` are the rows for one action (one SESSION/ACTION/ACTION_TIMESTAMP
 * combo — the same grouping the table drills into), so the max render timestamp
 * is exactly "the widget within this action that rendered last". The action
 * timestamp is constant across the group, so any row's copy is fine.
 *
 * Returns '' when the action has no parseable ACTION_TIMESTAMP or no parseable
 * WIDGET_RENDER_TIMESTAMP (the span can't be computed). The raw difference is
 * returned as-is even if negative, so an inconsistent row (a render stamp
 * before the action stamp) is visible rather than silently hidden.
 */
export function actionRenderDuration(groupRows, renderTsKey, actionTsKey) {
  if (!renderTsKey || !actionTsKey || !groupRows?.length) return ''
  let actionMs = null
  let maxRenderMs = -Infinity
  for (const r of groupRows) {
    if (actionMs === null) {
      const a = parseStrictTimestamp(r?.[actionTsKey])
      if (a) actionMs = a.getTime()
    }
    const d = parseStrictTimestamp(r?.[renderTsKey])
    if (d) {
      const t = d.getTime()
      if (t > maxRenderMs) maxRenderMs = t
    }
  }
  if (actionMs === null || maxRenderMs === -Infinity) return ''
  return maxRenderMs - actionMs
}

/**
 * Per-action render-durations for a set of rows, keyed by action name +
 * ACTION_TIMESTAMP (the same composite key Action View groups on, so the two
 * views count actions identically). Returns a Map of key → ms. Actions whose
 * duration can't be computed (no parseable render/action stamp) are omitted.
 * Used by Session View to sum/max per-action durations consistently with
 * Action View's `action_duration` column.
 */
export function actionRenderDurations(rows, renderTsKey, actionTsKey, actionNameKey) {
  const byKey = new Map()
  if (!renderTsKey || !actionNameKey || !rows?.length) return byKey
  const groups = new Map()
  for (const r of rows) {
    const name = r?.[actionNameKey]
    if (name === undefined || name === null || name === '') continue
    const ts = actionTsKey ? (r?.[actionTsKey] ?? '') : ''
    const key = `${name}${ts}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  for (const [key, groupRows] of groups) {
    const d = actionRenderDuration(groupRows, renderTsKey, actionTsKey)
    if (d !== '') byKey.set(key, d)
  }
  return byKey
}

/**
 * Max of `durationKey` across rows whose `measureKey` value (case-insensitive)
 * is one of `targets`. If `subTargets` are provided, also requires the row to
 * match one of those sub-measures — via the WIDGET_SUBMEASURE column (`subKey`)
 * or a folded `<measure>_<sub>` value (e.g. only count network rows that are
 * 'ttfb', whether tagged as WIDGET_SUBMEASURE='ttfb' or WIDGET_MEASURE='network_ttfb').
 * Returns '' when no matching row has a finite duration.
 */
function maxNumericWhere(rows, durationKey, measureKey, targets, subKey, subTargets) {
  if (!durationKey || !measureKey) return ''
  const wanted = targets.map((t) => t.toLowerCase())
  const subPatterns = subTargets && subTargets.length
    ? subTargets.map((t) => normSub(t))
    : null
  let max = -Infinity
  let found = false
  for (const r of rows) {
    const m = r?.[measureKey]
    if (m === undefined || m === null) continue
    const mv = String(m).toLowerCase()
    if (!measureMatches(mv, wanted)) continue
    if (subPatterns && !subMatches(mv, subKey ? r?.[subKey] : '', subPatterns)) continue
    const n = Number(r?.[durationKey])
    if (Number.isFinite(n)) {
      if (n > max) max = n
      found = true
    }
  }
  return found ? max : ''
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
function measureMatches(value, targets) {
  for (const t of targets) {
    if (value === t) return true
    if (value.startsWith(`${t}_`)) return true
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
    ['actiontimestamp', 'timestamp'],
    ['actiontimestamp', 'timestamp'],
    (h) => norm(h).includes('end'),
  )

  const widgetId = find(
    ['widgetid', 'instanceid'],
    ['widgetid', 'instanceid'],
  )

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

  // Story context — surfaces which story/page an action belongs to so users
  // can navigate the summary without cross-referencing the raw CSV.
  const storyName = find(['storyname'], ['storyname'])
  const storyPage = find(['storypage'], ['storypage'])

  // WIDGET_RENDER_TIMESTAMP is when a widget finished rendering. The action's
  // duration is the span from ACTION_TIMESTAMP to the LATEST of these across
  // the action's widgets. Exact-match first, and reject the *_START flavor so
  // we take the render END, not its start.
  const renderTimestamp = find(
    ['widgetrendertimestamp'],
    ['widgetrendertimestamp'],
    (h) => norm(h).includes('start'),
  )

  return {
    user: find(['username', 'user'], ['user']),
    actionName,
    actionTimestamp,
    widgetId,
    measure,
    submeasure,
    duration,
    storyName,
    storyPage,
    renderTimestamp,
  }
}
