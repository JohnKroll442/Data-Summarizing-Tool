/**
 * Time-bucket helpers for the summary tables' timestamp filter.
 *
 * The filter groups rows into buckets at a chosen granularity (month / week /
 * day / hour / minute) and lets the user pick which buckets to keep. Bucket
 * options are derived ONLY from timestamps present in the uploaded data — a
 * January-only file offers no February bucket.
 */

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

export const TIME_GRANULARITIES = [
  { id: 'month', label: 'Month' },
  { id: 'week', label: 'Week' },
  { id: 'day', label: 'Day' },
  { id: 'hour', label: 'Hour' },
  { id: 'minute', label: 'Minute' },
]

/**
 * Parse a CSV timestamp into a Date. Handles the app's datetime shape
 * "YYYY-MM-DD HH:mm:ss.fffffffff" (space separator, up to 9 fractional
 * digits — more than Date can natively take), ISO strings, and Date objects.
 * Returns null when the value is empty or unparseable.
 */
export function parseTimestamp(v) {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  const s = String(v).trim()
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/)
  if (m) {
    const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0
    const dt = new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4]), Number(m[5]), Number(m[6]), ms,
    )
    return Number.isNaN(dt.getTime()) ? null : dt
  }
  const dt = new Date(s)
  return Number.isNaN(dt.getTime()) ? null : dt
}

// A full "YYYY-MM-DD[ T]HH:MM:SS" datetime; the anchor for parseStrictTimestamp.
const FULL_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/

/**
 * Strict timestamp parse: only a full "YYYY-MM-DD[ T]HH:MM:SS(.fff…)" datetime
 * (or a Date) is accepted. Unlike parseTimestamp — which falls back to
 * `new Date(s)` and so turns a sentinel like "ttfb" or a bare "2029" into a
 * date — this returns null for anything that isn't a real, complete timestamp.
 * Used where such sentinels must NOT be mistaken for a real start/end.
 */
export function parseStrictTimestamp(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (!FULL_DATETIME.test(s)) return null
  return parseTimestamp(s)
}

const pad = (n) => String(n).padStart(2, '0')

// Monday-anchored start of the week containing `d`, at midnight.
function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dow = (x.getDay() + 6) % 7 // Monday = 0 … Sunday = 6
  x.setDate(x.getDate() - dow)
  return x
}

/**
 * The bucket a date falls into at a granularity.
 * Returns { key, label, sort } — `key` identifies the bucket (what selections
 * store), `label` is the human display, `sort` is a numeric chronological key.
 */
export function bucketOf(date, granularity) {
  const y = date.getFullYear()
  const mo = date.getMonth()
  const d = date.getDate()
  const hh = date.getHours()
  const mi = date.getMinutes()
  switch (granularity) {
    case 'month':
      return { key: `${y}-${pad(mo + 1)}`, label: `${MONTHS[mo]} ${y}`, sort: new Date(y, mo, 1).getTime() }
    case 'week': {
      const s = startOfWeek(date)
      return {
        key: `w:${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`,
        label: `Week of ${MONTHS[s.getMonth()]} ${s.getDate()}, ${s.getFullYear()}`,
        sort: s.getTime(),
      }
    }
    case 'hour':
      return {
        key: `${y}-${pad(mo + 1)}-${pad(d)} ${pad(hh)}`,
        label: `${MONTHS[mo]} ${d}, ${y} · ${pad(hh)}:00`,
        sort: new Date(y, mo, d, hh).getTime(),
      }
    case 'minute':
      return {
        key: `${y}-${pad(mo + 1)}-${pad(d)} ${pad(hh)}:${pad(mi)}`,
        label: `${MONTHS[mo]} ${d}, ${y} · ${pad(hh)}:${pad(mi)}`,
        sort: new Date(y, mo, d, hh, mi).getTime(),
      }
    case 'day':
    default:
      return {
        key: `${y}-${pad(mo + 1)}-${pad(d)}`,
        label: `${MONTHS[mo]} ${d}, ${y}`,
        sort: new Date(y, mo, d).getTime(),
      }
  }
}

// Coarse → fine ordering. A selection at one level constrains the available
// options (and the effective filter) at every finer level.
const ORDER = ['month', 'week', 'day', 'hour', 'minute']

/** A fresh, empty per-granularity selection set. */
export function emptyTimeSelections() {
  return { month: [], week: [], day: [], hour: [], minute: [] }
}

/** True if any granularity has at least one selected bucket. */
export function hasTimeSelection(selections) {
  return ORDER.some((g) => (selections?.[g]?.length ?? 0) > 0)
}

/** Total number of selected buckets across all granularities. */
export function timeSelectionCount(selections) {
  return ORDER.reduce((n, g) => n + (selections?.[g]?.length ?? 0), 0)
}

// Does a date satisfy the selections at every level COARSER than `granularity`?
// (Levels with no selection don't constrain.)
function passesCoarser(date, selections, granularity) {
  for (const g of ORDER) {
    if (g === granularity) break
    const sel = selections?.[g]
    if (sel && sel.length && !sel.includes(bucketOf(date, g).key)) return false
  }
  return true
}

/**
 * Distinct buckets present in `rows` at `granularity`, but only from rows that
 * fall within the selections made at coarser granularities — so picking "week
 * of Jun 15" limits the Day options to days inside that week. Chronologically
 * sorted, each with a count.
 */
export function listConstrainedBuckets(rows, getTimestamp, granularity, selections) {
  const map = new Map()
  for (const row of rows) {
    const dt = parseTimestamp(getTimestamp(row))
    if (!dt) continue
    if (!passesCoarser(dt, selections, granularity)) continue
    const b = bucketOf(dt, granularity)
    const existing = map.get(b.key)
    if (existing) existing.count++
    else map.set(b.key, { key: b.key, label: b.label, sort: b.sort, count: 1 })
  }
  return Array.from(map.values()).sort((a, b) => a.sort - b.sort)
}

/**
 * True if a row passes the time filter. A row must match the selected buckets
 * at EVERY granularity that has a selection (levels with no selection are
 * ignored). Empty selections everywhere means "no time constraint". Rows with
 * an unparseable/missing timestamp are excluded only when the filter is active.
 */
export function matchesTimeFilter(row, getTimestamp, selections) {
  if (!hasTimeSelection(selections)) return true
  const dt = parseTimestamp(getTimestamp(row))
  if (!dt) return false
  for (const g of ORDER) {
    const sel = selections[g]
    if (sel && sel.length && !sel.includes(bucketOf(dt, g).key)) return false
  }
  return true
}

/**
 * True if a row's START timestamp falls within a continuous [min, max] epoch-ms
 * range. `range == null` means no constraint. Rows with an unparseable/missing
 * timestamp are excluded only when a range is active (mirrors matchesTimeFilter).
 *
 * The rule is start-in-range by design: a row is scoped to the window selected
 * in the Activity Timeline when it STARTED inside that window. A row that starts
 * in-range but ends after it still matches (we only gate on the start), while a
 * row that started before the window is not shown even if it was still active —
 * per product direction, the table lists what began in the selected frame.
 */
export function matchesTimeRange(row, getTimestamp, range) {
  if (!range) return true
  const dt = parseTimestamp(getTimestamp(row))
  if (!dt) return false
  const t = dt.getTime()
  return t >= range.min && t <= range.max
}

/**
 * Keep the selection set consistent after a change: cascading coarse → fine,
 * drop any selected bucket at a level that no longer falls within the (already
 * pruned) coarser selections — e.g. deselecting a week removes the days that
 * belonged only to it.
 */
export function pruneSelections(rows, getTimestamp, selections) {
  const next = { ...selections }
  for (const g of ORDER) {
    const sel = next[g]
    if (!sel || !sel.length) continue
    const valid = new Set(
      listConstrainedBuckets(rows, getTimestamp, g, next).map((b) => b.key)
    )
    const pruned = sel.filter((k) => valid.has(k))
    if (pruned.length !== sel.length) next[g] = pruned
  }
  return next
}
