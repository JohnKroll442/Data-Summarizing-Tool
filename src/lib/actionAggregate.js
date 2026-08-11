/**
 * Action-level aggregation for the Action View summary table.
 *
 * One row per distinct action — keyed by USER_ACTION + ACTION_TIMESTAMP so
 * the same action fired twice (e.g. two "Input control state changed"
 * events) stay separate.
 *
 * Columns:
 *   Session ID · User · Story name · Action name · Action duration ·
 *   Max frontend · Max network · Max backend
 *
 * In this CSV shape each row carries a WIDGET_MEASURE flag of
 *   render | backend | network | offset
 * and the timing lives in DURATION. The three main phases NEST
 * (render ⊇ network ⊇ backend), so — exactly like the Widget View table — the
 * per-action maxes are the EXCLUSIVE phase durations:
 *   Max frontend = max over widgets of (render − network)
 *   Max network  = max over widgets of (network − backend)  [ttfb only]
 *   Max backend  = max over widgets of backend              (innermost, as-is)
 * Each action's rows are grouped by WIDGET_ID and reduced with the same
 * exclusive logic the Widget View uses (see widgetAggregate.maxExclusivePhases),
 * so an action's maxes equal the largest widget value the user sees after
 * drilling into that action. Backend is unchanged (it's the innermost phase).
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
import { detectWidgetMapping, maxExclusivePhases } from './widgetAggregate'

export const aggregateByAction = memoizeAggregate(aggregateByActionImpl)

function aggregateByActionImpl(rows, headers) {
  const mapping = detectMapping(headers)
  // Populated-column-aware session detection (SESSION_ID may exist but be
  // empty while BROWSERSESSION_ID carries the real value — pick whichever
  // has data). Attach onto the mapping so callers can see which column won.
  mapping.session = detectSessionKey(headers, rows)

  const columns = [
    { key: 'session_id',      label: 'Session ID' },
    { key: 'user',            label: 'User' },
    { key: 'story_name',      label: 'Story name' },
    { key: 'action_name',     label: 'Action name' },
    { key: 'action_duration', label: 'Action duration', sortType: 'duration' },
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
  // Detect the widget-phase mapping once; each action group reuses it to
  // compute exclusive Max frontend/network/backend the same way Widget View does.
  const widgetMapping = detectWidgetMapping(headers)
  for (const [, groupRows] of groups) {
    const actionTs = mapping.actionTimestamp
      ? firstNonEmpty(groupRows, mapping.actionTimestamp)
      : ''
    const { frontend, network, backend } = maxExclusivePhases(groupRows, widgetMapping)
    outRows.push({
      // Hidden meta — not in the displayed columns, but carried on the
      // row so click handlers can disambiguate two invocations of the
      // same action name fired at different times.
      _action_timestamp: actionTs,
      // Effective action END: the raw ACTION_TIMESTAMP_END cell when the CSV
      // carries one (the real, findable moment the action finished), else the
      // WIDGET_RENDER_TIMESTAMP of the last-rendering widget. Paired with the
      // start (_action_timestamp) it feeds the Action duration cell's hover
      // popover (see ActionSummaryTable / PhaseHoverCell). '' when neither is
      // available.
      _action_end: mapping.actionTimestampEnd
        ? (firstNonEmpty(groupRows, mapping.actionTimestampEnd) ||
           (mapping.renderTimestamp ? actionEndTimestamp(groupRows, mapping.renderTimestamp) : ''))
        : mapping.renderTimestamp
          ? actionEndTimestamp(groupRows, mapping.renderTimestamp)
          : '',
      session_id:   firstNonEmpty(groupRows, mapping.session),
      // Displayed copy of the action timestamp (underscore-prefixed key stays
      // the click-handler meta; this one renders in the table).
      action_timestamp: actionTs,
      user:         stripUserPrefix(firstNonEmpty(groupRows, mapping.user)),
      action_name:  firstNonEmpty(groupRows, mapping.actionName),
      story_name:   firstNonEmpty(groupRows, mapping.storyName),
      // The action's duration. Preferred: ACTION_TIMESTAMP_END − ACTION_TIMESTAMP
      // (both real, findable cells — matches the raw data exactly). Falls back to
      // MAX(WIDGET_RENDER_TIMESTAMP) − ACTION_TIMESTAMP when there's no END
      // column, then to max(DURATION) when there's no render-timestamp column
      // either. Session View sums/maxes this same per-action value.
      action_duration: actionDuration(groupRows, mapping),
      // Exclusive phase maxes, matching the Widget View table (drill into this
      // action to reproduce them). See maxExclusivePhases / the header comment.
      max_frontend: frontend,
      max_network:  network,
      max_backend:  backend,
    })
  }

  return { rows: outRows, columns, mapping }
}

/* ——— helpers ——— */

/**
 * The action's duration for one group of rows, using the best source available:
 *   1. ACTION_TIMESTAMP_END − ACTION_TIMESTAMP  (real, findable end cell)
 *   2. MAX(WIDGET_RENDER_TIMESTAMP) − ACTION_TIMESTAMP  (last render completion)
 *   3. max(DURATION)  (no timestamp columns at all)
 * Steps 1→2 fall through only when the earlier source can't produce a value, so a
 * row missing the END cell still gets a render-based duration. But once a render
 * column EXISTS its span is authoritative even when unparseable (returns '') — we
 * don't mask a bad render stamp with the raw DURATION max; the DURATION fallback
 * is only for CSV shapes with no render-timestamp column at all.
 */
function actionDuration(groupRows, mapping) {
  if (mapping.actionTimestampEnd) {
    const d = actionEndDuration(groupRows, mapping.actionTimestampEnd, mapping.actionTimestamp)
    if (d !== '') return d
  }
  if (mapping.renderTimestamp) {
    return actionRenderDuration(groupRows, mapping.renderTimestamp, mapping.actionTimestamp)
  }
  return maxNumeric(groupRows, mapping.duration)
}

function firstNonEmpty(rows, key) {
  if (!key) return ''
  for (const r of rows) {
    const v = r?.[key]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return ''
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
 * The action's duration measured from the raw ACTION_TIMESTAMP_END column:
 *   parse(ACTION_TIMESTAMP_END) − parse(ACTION_TIMESTAMP), in ms.
 * This is the most direct, findable duration — both endpoints are real cells on
 * the action's rows (constant across the group). Preferred over the render-based
 * span when the CSV carries an ACTION_TIMESTAMP_END column. Both sides are
 * strict-parsed so a sentinel ("ttfb"-style) value never masquerades as a
 * timestamp; the raw difference is returned even if negative so an inconsistent
 * row stays visible. Returns '' when either endpoint can't be parsed.
 */
export function actionEndDuration(groupRows, endTsKey, actionTsKey) {
  if (!endTsKey || !actionTsKey || !groupRows?.length) return ''
  let actionMs = null
  let endMs = null
  for (const r of groupRows) {
    if (actionMs === null) {
      const a = parseStrictTimestamp(r?.[actionTsKey])
      if (a) actionMs = a.getTime()
    }
    if (endMs === null) {
      const e = parseStrictTimestamp(r?.[endTsKey])
      if (e) endMs = e.getTime()
    }
    if (actionMs !== null && endMs !== null) break
  }
  if (actionMs === null || endMs === null) return ''
  return endMs - actionMs
}

/**
 * The raw WIDGET_RENDER_TIMESTAMP of the last-rendering widget in the action —
 * i.e. the action's effective END timestamp. Returns the original CSV value
 * (string or Date) so formatCsvTime can render it exactly like every other
 * timestamp; '' when no row carries a parseable render stamp.
 */
export function actionEndTimestamp(groupRows, renderTsKey) {
  if (!renderTsKey || !groupRows?.length) return ''
  let best = ''
  let bestMs = -Infinity
  for (const r of groupRows) {
    const raw = r?.[renderTsKey]
    const d = parseStrictTimestamp(raw)
    if (d) {
      const t = d.getTime()
      if (t > bestMs) {
        bestMs = t
        best = raw
      }
    }
  }
  return best
}

/**
 * Per-action render-durations for a set of rows, keyed by action name +
 * ACTION_TIMESTAMP (the same composite key Action View groups on, so the two
 * views count actions identically). Returns a Map of key → ms. Actions whose
 * duration can't be computed (no parseable render/action stamp) are omitted.
 * Used by Session View to sum/max per-action durations consistently with
 * Action View's `action_duration` column.
 *
 * When `endTsKey` (ACTION_TIMESTAMP_END) is supplied, each action's duration is
 * measured END − START from that real column (matching Action View's preferred
 * `action_duration`); otherwise it falls back to the render-based span. An
 * action that has no parseable END but does have a render stamp still gets a
 * duration via the render fallback, so mixing shapes never drops an action.
 */
export function actionRenderDurations(rows, renderTsKey, actionTsKey, actionNameKey, endTsKey = '') {
  const byKey = new Map()
  if ((!renderTsKey && !endTsKey) || !actionNameKey || !rows?.length) return byKey
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
    let d = endTsKey ? actionEndDuration(groupRows, endTsKey, actionTsKey) : ''
    if (d === '' && renderTsKey) d = actionRenderDuration(groupRows, renderTsKey, actionTsKey)
    if (d !== '') byKey.set(key, d)
  }
  return byKey
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

  // ACTION_TIMESTAMP_END — the real, findable moment the action finished.
  // When present it's the preferred source for the action's END and duration
  // (see aggregateByActionImpl), pairing with ACTION_TIMESTAMP so both
  // endpoints are locatable in the raw data. Matched precisely so it's never
  // confused with the start (ACTION_TIMESTAMP) or a widget timestamp.
  const actionTimestampEnd = find(
    ['actiontimestampend'],
    ['actiontimestampend'],
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
    actionTimestampEnd,
    widgetId,
    measure,
    submeasure,
    duration,
    storyName,
    storyPage,
    renderTimestamp,
  }
}
