/**
 * Activity Timeline data layer.
 *
 * Powers the shared timeline panel: given the parsed CSV, it buckets a time
 * window and counts, per bucket, how many SESSIONS, ACTIONS and WIDGETS are
 * ACTIVE — so busy periods stand out as tall grouped bars.
 *
 * "Active" semantics:
 *   - sessions & widgets are INTERVALS (start → end); they count in every
 *     bucket their interval overlaps.
 *   - actions are POINTS (a single timestamp); they count in the one bucket
 *     the timestamp falls into.
 *
 * The window is data-driven: buckets only ever span the timestamps actually
 * present (never padded out to empty months). A caller can pass an explicit
 * `range` to bucket a sub-window at a finer interval — that's how the panel
 * drills from a month down to a 5-minute view.
 *
 * All counts derive from the same raw rows, so the Primary/Secondary dimension
 * filters simply narrow the raw rows before aggregation — filtering by
 * User=Alice scopes sessions, actions and widgets together and consistently.
 */

import { parseTimestamp, bucketOf } from './timeBuckets'
import { aggregateBySession } from './sessionAggregate'
import { aggregateByAction } from './actionAggregate'
import { aggregateByWidget } from './widgetAggregate'
import { detectSessionKey } from './drillDown'
import { memoizeFilter } from './memoize'

// Strict timestamp parse for span/bucketing. Unlike timeBuckets.parseTimestamp
// (which falls back to `new Date(s)` and so turns junk like a bare "2029" or
// "ttfb" into a real date), this only accepts a Date or a full
// "YYYY-MM-DD[ T]HH:MM:SS" shape. That keeps a single malformed cell from
// blowing the timeline's span out to a distant year.
const FULL_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/
function parseStamp(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v).trim()
  if (!FULL_DATETIME.test(s)) return null
  return parseTimestamp(s)
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]
const pad = (n) => String(n).padStart(2, '0')

// Sub-hour interval ids and their minute step. Named ids (hour/day/week/month)
// delegate to timeBuckets' bucketOf; 'minute' = 1 min.
const STEP_MIN = { minute: 1, '5min': 5, '15min': 15, '30min': 30 }

// Rough span of one bucket per interval — auto-selection + overflow guard.
const APPROX_MS = {
  minute: 60_000,
  '5min': 300_000,
  '15min': 900_000,
  '30min': 1_800_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_629_800_000,
}

// Fine → coarse, for auto-granularity and coarsen-to-fit.
const FINE_TO_COARSE = ['minute', '5min', '15min', '30min', 'hour', 'day', 'week', 'month']

// Intervals offered in the panel dropdown (coarse → fine reads naturally).
export const INTERVAL_OPTIONS = [
  { id: 'month',  label: 'Month' },
  { id: 'week',   label: 'Week' },
  { id: 'day',    label: 'Day' },
  { id: 'hour',   label: 'Hour' },
  { id: '30min',  label: '30 min' },
  { id: '15min',  label: '15 min' },
  { id: '5min',   label: '5 min' },
  { id: 'minute', label: '1 min' },
]

// Hard ceiling on how many bars we'll render — keeps the DOM bounded. High
// enough that hour-over-a-month (~700) renders without truncation; finer
// intervals are handled by auto-fitting the window instead of clamping.
export const MAX_BUCKETS = 800

// Target bucket count for a *readable* chart — grouped bars (×3 series) get
// thin past this, so auto-granularity and the window auto-fit both aim here.
// The user pans across the span with the navigator rather than cramming every
// bucket on screen at once.
export const READABLE_TARGET = 40

/** Approximate span (ms) of a single bucket at `interval`. */
export function bucketSpanMs(interval) {
  return APPROX_MS[interval] ?? APPROX_MS.day
}

/* ——— interval math (named + sub-hour steps) ——— */

// Start of the bucket that `date` falls into, at `interval`.
function startOfBucket(date, interval) {
  const step = STEP_MIN[interval]
  if (step && step > 1) {
    return new Date(
      date.getFullYear(), date.getMonth(), date.getDate(),
      date.getHours(), Math.floor(date.getMinutes() / step) * step,
    )
  }
  return new Date(bucketOf(date, interval).sort)
}

// Start of the bucket AFTER one that starts at `start`.
function nextBucket(start, interval) {
  const y = start.getFullYear()
  const mo = start.getMonth()
  const d = start.getDate()
  const hh = start.getHours()
  const mi = start.getMinutes()
  const step = STEP_MIN[interval]
  if (step) return new Date(y, mo, d, hh, mi + step)
  switch (interval) {
    case 'month': return new Date(y, mo + 1, 1)
    case 'week':  return new Date(y, mo, d + 7)
    case 'hour':  return new Date(y, mo, d, hh + 1)
    case 'day':
    default:      return new Date(y, mo, d + 1)
  }
}

// { key, label } for a bucket whose start Date is `start`.
function bucketKeyLabel(start, interval) {
  if (STEP_MIN[interval] && STEP_MIN[interval] > 1) {
    const y = start.getFullYear()
    const mo = start.getMonth()
    const d = start.getDate()
    return {
      key: `${y}-${pad(mo + 1)}-${pad(d)} ${pad(start.getHours())}:${pad(start.getMinutes())}`,
      label: `${MONTHS[mo]} ${d} · ${pad(start.getHours())}:${pad(start.getMinutes())}`,
    }
  }
  const b = bucketOf(start, interval)
  return { key: b.key, label: b.label }
}

// The bucket key `date` maps to at `interval`.
function keyOf(date, interval) {
  return bucketKeyLabel(startOfBucket(date, interval), interval).key
}

/** Rough number of buckets a span would produce at an interval. */
export function estimateBucketCount(minDate, maxDate, interval) {
  const span = maxDate.getTime() - minDate.getTime()
  if (span <= 0) return 1
  return Math.floor(span / APPROX_MS[interval]) + 1
}

/**
 * Finest interval whose estimated bucket count is ≤ `target` (and ≤
 * MAX_BUCKETS), so the axis stays readable. As the window shrinks this
 * naturally refines month → day → hour → 5-min → 1-min.
 */
export function chooseGranularity(minDate, maxDate, { target = READABLE_TARGET } = {}) {
  for (const id of FINE_TO_COARSE) {
    const n = estimateBucketCount(minDate, maxDate, id)
    if (n <= target && n <= MAX_BUCKETS) return id
  }
  return 'month'
}

/**
 * The effective interval for a requested one over a window: never finer than
 * requested, but coarsened if the requested size would pack too many
 * (unreadable) bars in — so bars stay chunky while the window stays exactly
 * where the user put it (we never shrink their window to fit an interval).
 */
export function coarsenToFit(requested, minDate, maxDate, { target = READABLE_TARGET } = {}) {
  const start = Math.max(0, FINE_TO_COARSE.indexOf(requested))
  for (let i = start; i < FINE_TO_COARSE.length; i++) {
    const id = FINE_TO_COARSE[i]
    if (estimateBucketCount(minDate, maxDate, id) <= target) return id
  }
  return 'month'
}

/**
 * Contiguous buckets from `minDate`'s bucket through `maxDate`'s bucket.
 * Includes empty periods so idle stretches read as zero bars, but never spans
 * beyond the given range (so no empty leading/trailing months).
 * Returns { buckets: [{key,label,sort}], indexByKey: Map<key, index> }.
 */
export function enumerateBuckets(minDate, maxDate, interval) {
  const buckets = []
  const indexByKey = new Map()
  let cursor = startOfBucket(minDate, interval)
  const end = maxDate.getTime()
  while (cursor.getTime() <= end && buckets.length < MAX_BUCKETS) {
    const { key, label } = bucketKeyLabel(cursor, interval)
    indexByKey.set(key, buckets.length)
    buckets.push({ key, label, sort: cursor.getTime() })
    cursor = nextBucket(cursor, interval)
  }
  return { buckets, indexByKey }
}

/* ——— entity interval / point extraction ——— */

export function sessionInterval(row) {
  const start = parseStamp(row.timestamp_range)
  if (!start) return null
  const end = parseStamp(row._timestamp_end) ?? start
  return start <= end ? { start, end } : { start: end, end: start }
}

export function widgetInterval(row) {
  const stamps = [
    row.render_start, row.render_end,
    row.network_start, row.network_end,
    row.backend_start, row.backend_end,
  ]
    .map(parseStamp)
    .filter(Boolean)
  if (stamps.length === 0) return null
  let start = stamps[0]
  let end = stamps[0]
  for (const s of stamps) {
    if (s < start) start = s
    if (s > end) end = s
  }
  return { start, end }
}

export function actionPoint(row) {
  return parseStamp(row._action_timestamp)
}

/* ——— dimension fields (scoping filters) ——— */

export function listDimensionFields(rows, headers) {
  if (!rows?.length || !headers?.length) return []
  const s = aggregateBySession(rows, headers).mapping
  const a = aggregateByAction(rows, headers).mapping
  const w = aggregateByWidget(rows, headers).mapping
  const candidates = [
    { id: 'user',    label: 'User',    header: s.user || a.user },
    { id: 'story',   label: 'Story',   header: s.story || a.storyName },
    { id: 'action',  label: 'Action',  header: a.actionName },
    { id: 'widget',  label: 'Widget',  header: w.widgetName },
    { id: 'session', label: 'Session', header: detectSessionKey(headers, rows) },
  ]
  return candidates.filter((c) => c.header)
}

export function dimensionOptions(rows, header) {
  if (!header || !rows?.length) return []
  const set = new Set()
  for (const r of rows) {
    const v = r?.[header]
    if (v === undefined || v === null || v === '') continue
    set.add(String(v))
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b))
}

export const applyDimensionFilters = memoizeFilter(
  applyDimensionFiltersImpl,
  (arg) => filterSig(arg),
)

function applyDimensionFiltersImpl(rows, headers, { primary, secondary } = {}) {
  const fields = listDimensionFields(rows, headers)
  const active = [primary, secondary]
    .filter((f) => f && Array.isArray(f.values) && f.values.length > 0)
    .map((f) => {
      const def = fields.find((d) => d.id === f.field)
      return def ? { header: def.header, set: new Set(f.values.map(String)) } : null
    })
    .filter(Boolean)
  if (active.length === 0) return rows
  return rows.filter((r) =>
    active.every((f) => f.set.has(String(r?.[f.header] ?? '')))
  )
}

function filterSig(arg) {
  const one = (f) =>
    f && Array.isArray(f.values) && f.values.length
      ? `${f.field}:${f.values.map(String).sort().join('')}`
      : ''
  return `${one(arg?.primary)}|${one(arg?.secondary)}`
}

/* ——— main entry point ——— */

const toDate = (v) => (v instanceof Date ? v : new Date(v))

/**
 * Build everything the panel needs for one chart.
 *
 * @param opts.interval   explicit interval id, or 'auto'/undefined (alias:
 *                        `granularity` for back-compat)
 * @param opts.range      { min, max } (Date | epoch ms) — window to bucket;
 *                        defaults to the full data span
 * @param opts.coarsen    when true (default), an explicit interval is coarsened
 *                        to fit a readable bar count; when false it's honored
 *                        verbatim (used to force the nav strip to the detail's
 *                        exact bucket size, capped only by MAX_BUCKETS).
 * @param opts.primaryFilter / opts.secondaryFilter  { field, values } | null
 * @returns {
 *   granularity, granularityClamped, buckets, series:{sessions,actions,widgets},
 *   totals:{sessions,actions,widgets}, span:{min,max}, range:{min,max}, empty
 * }
 */
export function buildActivityTimeline(rows, headers, {
  interval,
  granularity,
  range = null,
  coarsen = true,
  primaryFilter = null,
  secondaryFilter = null,
} = {}) {
  const requested = interval ?? granularity ?? 'auto'
  const EMPTY = {
    granularity: 'day',
    granularityClamped: false,
    buckets: [],
    series: { sessions: [], actions: [], widgets: [] },
    totals: { sessions: 0, actions: 0, widgets: 0 },
    span: { min: null, max: null },
    range: { min: null, max: null },
    empty: true,
  }
  if (!rows?.length || !headers?.length) return EMPTY

  const scoped = applyDimensionFilters(rows, headers, {
    primary: primaryFilter,
    secondary: secondaryFilter,
  })

  const sessions = aggregateBySession(scoped, headers).rows
    .map(sessionInterval).filter(Boolean)
  const widgets = aggregateByWidget(scoped, headers).rows
    .map(widgetInterval).filter(Boolean)
  const actions = aggregateByAction(scoped, headers).rows
    .map(actionPoint).filter(Boolean)

  // Full data span across every interval and point.
  let spanMin = null
  let spanMax = null
  const track = (d) => {
    if (!d) return
    if (spanMin === null || d < spanMin) spanMin = d
    if (spanMax === null || d > spanMax) spanMax = d
  }
  for (const iv of sessions) { track(iv.start); track(iv.end) }
  for (const iv of widgets) { track(iv.start); track(iv.end) }
  for (const p of actions) track(p)

  if (spanMin === null || spanMax === null) return EMPTY

  // Effective window to bucket — the requested range, clamped into the span.
  let effMin = range?.min != null ? toDate(range.min) : spanMin
  let effMax = range?.max != null ? toDate(range.max) : spanMax
  if (effMin < spanMin) effMin = spanMin
  if (effMax > spanMax) effMax = spanMax
  if (effMax <= effMin) { effMin = spanMin; effMax = spanMax }

  // Resolve the interval. 'auto' fits the window; an explicit choice is honored
  // but coarsened (unless coarsen:false) if it would pack in too many bars —
  // the window is never shrunk to fit, so the drag box stays put.
  const id = requested && requested !== 'auto'
    ? (coarsen ? coarsenToFit(requested, effMin, effMax) : requested)
    : chooseGranularity(effMin, effMax)

  const { buckets, indexByKey } = enumerateBuckets(effMin, effMax, id)

  return {
    granularity: id,
    granularityClamped: false,
    buckets,
    series: {
      sessions: countIntervals(sessions, buckets.length, indexByKey, id),
      actions: countPoints(actions, buckets.length, indexByKey, id),
      widgets: countIntervals(widgets, buckets.length, indexByKey, id),
    },
    totals: {
      sessions: sessions.filter((iv) => iv.start <= effMax && iv.end >= effMin).length,
      actions: actions.filter((p) => p >= effMin && p <= effMax).length,
      widgets: widgets.filter((iv) => iv.start <= effMax && iv.end >= effMin).length,
    },
    span: { min: spanMin, max: spanMax },
    range: { min: effMin, max: effMax },
    empty: false,
  }
}

function countPoints(points, n, indexByKey, interval) {
  const counts = new Array(n).fill(0)
  for (const p of points) {
    const idx = indexByKey.get(keyOf(p, interval))
    if (idx !== undefined) counts[idx]++
  }
  return counts
}

// Difference array so an interval spanning K buckets is applied in O(1).
function countIntervals(intervals, n, indexByKey, interval) {
  const diff = new Array(n + 1).fill(0)
  for (const iv of intervals) {
    const s = indexByKey.get(keyOf(iv.start, interval))
    const e = indexByKey.get(keyOf(iv.end, interval))
    if (s === undefined || e === undefined) continue
    diff[s]++
    diff[e + 1]--
  }
  const counts = new Array(n).fill(0)
  let running = 0
  for (let i = 0; i < n; i++) {
    running += diff[i]
    counts[i] = running
  }
  return counts
}

/** Human label for an interval id (for chart subtitles). */
export function granularityLabel(id) {
  return INTERVAL_OPTIONS.find((g) => g.id === id)?.label ?? id
}
