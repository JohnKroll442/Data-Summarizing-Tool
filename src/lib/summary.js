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

/** Tally actions into buckets at `granularity`; return a Map<key, {label,count,sort}>. */
function bucketCounts(dates, granularity) {
  const map = new Map()
  for (const d of dates) {
    const b = bucketOf(d, granularity)
    const cur = map.get(b.key)
    if (cur) cur.count++
    else map.set(b.key, { label: b.label, count: 1, sort: b.sort })
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

const DAY_MS = 24 * 60 * 60 * 1000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Local midnight (epoch ms) of a Date — the calendar day it falls in.
const dayStartMs = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

// "Jun 15 – Jun 22, 2026" (both years shown only when the range crosses a year).
function rangeLabel(startMs, endMs) {
  const s = new Date(startMs)
  const e = new Date(endMs)
  const day = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return s.getFullYear() === e.getFullYear()
    ? `${day(s)} – ${day(e)}, ${e.getFullYear()}`
    : `${day(s)}, ${s.getFullYear()} – ${day(e)}, ${e.getFullYear()}`
}

/**
 * Busiest rolling `windowDays`-day stretch by action count — a sliding window
 * over the calendar days, so a busy run that straddles a calendar week/month
 * boundary is still found whole (unlike fixed calendar buckets). Returns
 * { label, count, min, max } for the window [start, start+windowDays) with the
 * most actions, or null if undated.
 *
 * `min`/`max` are the nominal window bounds (the timeline clamps them to the
 * data span). The label's end is clamped to the last active day, so a window
 * that overshoots the data reads as its real coverage (e.g. a 30-day window on
 * ~4 weeks of data shows "Jun 15 – Jul 13", not "… – Jul 15").
 */
function busiestWindow(dates, windowDays) {
  if (dates.length === 0) return null
  const counts = new Map()
  for (const d of dates) {
    const k = dayStartMs(d)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const days = [...counts.keys()].sort((a, b) => a - b)
  const lastDay = days[days.length - 1]
  const windowMs = windowDays * DAY_MS

  // Sliding window: keep days[left..right] within a < windowDays span; the best
  // sum is the busiest window, anchored at its first active day.
  let left = 0
  let sum = 0
  let best = null
  for (let right = 0; right < days.length; right++) {
    sum += counts.get(days[right])
    while (days[right] - days[left] >= windowMs) {
      sum -= counts.get(days[left])
      left++
    }
    if (!best || sum > best.count) best = { count: sum, startMs: days[left] }
  }
  const max = best.startMs + windowMs
  return {
    label: rangeLabel(best.startMs, Math.min(max, lastDay)),
    count: best.count,
    min: best.startMs,
    max,
  }
}

/**
 * Busiest periods by ACTION count. Always returns the busiest day (when any
 * action has a parseable timestamp); adds the busiest rolling 7-day stretch
 * only when the data spans more than 7 days, and the busiest month only when
 * it spans more than one month. Returns null when there are no dated actions.
 *
 * Each period carries `{ label, count, min, max }` where min/max are the epoch
 * ms bounds of that window — so a click can focus the Activity Timeline on it.
 */
export function computeBusiest(rows, headers) {
  if (!rows?.length || !headers?.length) return null

  const dates = aggregateByAction(rows, headers).rows.map(actionPoint).filter(Boolean)
  if (dates.length === 0) return null

  const days = bucketCounts(dates, 'day')
  const months = bucketCounts(dates, 'month')

  // Total span in whole days — a 7-day card only makes sense past a week.
  let minDay = Infinity
  let maxDay = -Infinity
  for (const d of dates) {
    const k = dayStartMs(d)
    if (k < minDay) minDay = k
    if (k > maxDay) maxDay = k
  }

  const dayB = busiest(days)
  const out = {
    day: dayB ? { label: dayB.label, count: dayB.count, min: dayB.sort, max: dayB.sort + DAY_MS } : null,
  }
  if (maxDay - minDay >= 7 * DAY_MS) out.week = busiestWindow(dates, 7)
  if (months.size > 1) out.month = busiestWindow(dates, 30)
  return out
}
