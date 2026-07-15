/**
 * Summary view data layer.
 *
 * Two independent computations, both derived from the same aggregators the
 * Session / Action / Widget views use (so the numbers match those views):
 *
 *   computeRankings — for six categories (widget render / network / backend /
 *                     offset, action duration, session total duration), the
 *                     SLOWEST 10 and the FASTEST 10.
 *   computeBusiest  — the day (and week / month, when the data spans more than
 *                     one) with the MOST actions.
 */

import { aggregateBySession } from './sessionAggregate'
import { aggregateByAction } from './actionAggregate'
import { aggregateByWidget } from './widgetAggregate'
import { actionPoint } from './activityTimeline'
import { bucketOf } from './timeBuckets'

const TOP_N = 10

const num = (v) => {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Score `items`, drop those with no value, sort by `direction` ('desc' =
 * slowest first, 'asc' = fastest first) and keep the top N as display rows.
 * Each row carries a `nav` payload describing how to open it in its view.
 */
function rankBy(items, valueOf, labelOf, sublabelOf, navOf, direction) {
  const scored = []
  for (const it of items) {
    const value = valueOf(it)
    if (value == null) continue
    scored.push({
      value,
      label: labelOf(it),
      sublabel: sublabelOf ? sublabelOf(it) : '',
      nav: navOf(it),
    })
  }
  scored.sort((a, b) => (direction === 'asc' ? a.value - b.value : b.value - a.value))
  return scored.slice(0, TOP_N)
}

/** The six category specs (shared by both the slowest and fastest rankings). */
function categorySpecs(rows, headers) {
  const widgets = aggregateByWidget(rows, headers).rows
  const actions = aggregateByAction(rows, headers).rows
  const sessions = aggregateBySession(rows, headers).rows

  const widgetLabel = (w) => String(w.widget_name || w.widget_id || '—')
  const widgetSub = (w) =>
    w.widget_name ? String(w.widget_id) : w.session_id ? `Session ${w.session_id}` : ''
  // Open the Widget view filtered to just this widget (by its id).
  const widgetNav = (w) => ({ view: 'widget', columns: { widget_id: [String(w.widget_id)] } })
  const widgetSpec = (id, title, key) => ({
    id, title, view: 'widget', items: widgets,
    valueOf: (w) => num(w[key]), labelOf: widgetLabel, sublabelOf: widgetSub, navOf: widgetNav,
  })

  return [
    widgetSpec('render', 'Widgets by render', 'render'),
    widgetSpec('network', 'Widgets by network', 'network'),
    widgetSpec('backend', 'Widgets by backend', 'backend'),
    widgetSpec('offset', 'Widgets by offset', 'offset'),
    {
      id: 'action', title: 'Actions by duration', view: 'action', items: actions,
      valueOf: (a) => {
        const vals = [num(a.max_frontend), num(a.max_network), num(a.max_backend)].filter(
          (v) => v != null,
        )
        return vals.length ? Math.max(...vals) : null
      },
      labelOf: (a) => String(a.action_name || '—'),
      sublabelOf: (a) => (a.user ? String(a.user) : a.session_id ? `Session ${a.session_id}` : ''),
      // Open the Action view filtered to exactly THIS action invocation: the
      // action name pins the name, `_action_timestamp` pins the specific fire
      // (so only the clicked/slowest row shows, not every same-named action),
      // and the story is pinned for context.
      navOf: (a) => ({
        view: 'action',
        columns: {
          action_name: [String(a.action_name ?? '')],
          _action_timestamp: [String(a._action_timestamp ?? '')],
          ...(a.story_name ? { story_name: [String(a.story_name)] } : {}),
        },
      }),
    },
    {
      id: 'session', title: 'Sessions by total duration', view: 'session', items: sessions,
      valueOf: (s) => num(s.total_action_duration),
      labelOf: (s) => String(s.session || '—'),
      sublabelOf: (s) => (s.user ? String(s.user) : ''),
      navOf: (s) => ({ view: 'session', columns: { session: [String(s.session ?? '')] } }),
    },
  ]
}

/**
 * Slowest and fastest rankings for the six categories. Returns
 * `{ slowest, fastest }` where each is an array of
 * `{ id, title, view, items:[{label, sublabel, value, nav}] }` (value in ms).
 * Categories whose metric column is absent come back with empty `items`.
 */
export function computeRankings(rows, headers) {
  if (!rows?.length || !headers?.length) return { slowest: [], fastest: [] }
  const specs = categorySpecs(rows, headers)
  const build = (direction) =>
    specs.map((s) => ({
      id: s.id,
      title: s.title,
      view: s.view,
      items: rankBy(s.items, s.valueOf, s.labelOf, s.sublabelOf, s.navOf, direction),
    }))
  return { slowest: build('desc'), fastest: build('asc') }
}

/** Tally actions into buckets at `granularity`; return a Map<key, {label,count}>. */
function bucketCounts(dates, granularity) {
  const map = new Map()
  for (const d of dates) {
    const b = bucketOf(d, granularity)
    const cur = map.get(b.key)
    if (cur) cur.count++
    else map.set(b.key, { label: b.label, count: 1 })
  }
  return map
}

/** The single busiest bucket in a count map, or null if empty. */
function busiest(map) {
  let best = null
  for (const v of map.values()) {
    if (!best || v.count > best.count) best = v
  }
  return best
}

/**
 * Busiest periods by ACTION count. Always returns the busiest day (when any
 * action has a parseable timestamp); adds week / month only when the data
 * actually spans more than one of that period (so a single-week file shows no
 * week card). Returns null when there are no dated actions at all.
 *
 * @returns { day, week?, month? } where each is { label, count } | null
 */
export function computeBusiest(rows, headers) {
  if (!rows?.length || !headers?.length) return null

  const dates = aggregateByAction(rows, headers).rows.map(actionPoint).filter(Boolean)
  if (dates.length === 0) return null

  const days = bucketCounts(dates, 'day')
  const weeks = bucketCounts(dates, 'week')
  const months = bucketCounts(dates, 'month')

  const out = { day: busiest(days) }
  if (weeks.size > 1) out.week = busiest(weeks)
  if (months.size > 1) out.month = busiest(months)
  return out
}
