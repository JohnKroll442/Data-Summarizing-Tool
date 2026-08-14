/**
 * Time-Of-Day-Trend data layer for the Action View's fourth panel.
 *
 * Buckets every action instance along the REAL timeline so the panel answers
 * "when were the busy / slow times?" over the whole dataset — not "which hour of
 * day", which would wrongly merge two weeks of 9am runs into one point.
 *
 * The bucket granularity ADAPTS to the span so the chart stays readable at any
 * length: a few hours bucket by minute/hour, a couple of weeks by day, a few
 * months by week, a year+ by month — always aiming for a comfortable handful of
 * buckets rather than hundreds of empty hourly slots. Buckets are enumerated
 * across the full span (gaps included), so a quiet stretch reads as empty
 * buckets (zero count, null percentiles) rather than disappearing.
 *
 * Per bucket it reports the p50 / p90 of action duration, their ratio, the
 * action count (the "how busy" signal), and the individual instances (for the
 * click-to-drill scatter, which plots each run at its real timestamp).
 *
 * Input is the per-instance action rows — aggregateByAction(rows, headers).rows
 * — each carrying `_action_timestamp`, `action_duration`, `action_name`,
 * `story_name`, `user`.
 *
 * Returns { buckets, totalActions, granularity, hasData } where each bucket is
 *   { key, label, fullLabel, sort, p50, p90, ratio, count, instances }
 * and each instance is
 *   { actionKey, action, story, user, timestamp, duration, t }.
 */

import { parseTimestamp, bucketOf } from './timeBuckets'

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

const pad = (n) => String(n).padStart(2, '0')

/**
 * Linear-interpolation percentile of an ASCENDING-sorted numeric array.
 * `q` in [0,1]. Returns null for an empty set, the sole value for one element,
 * and interpolates between the two ranks that bracket `q*(n-1)` otherwise.
 */
export function percentile(sortedAsc, q) {
  const n = sortedAsc.length
  if (n === 0) return null
  if (n === 1) return sortedAsc[0]
  const rank = q * (n - 1)
  const lo = Math.floor(rank)
  if (lo + 1 >= n) return sortedAsc[n - 1]
  const frac = rank - lo
  return sortedAsc[lo] + frac * (sortedAsc[lo + 1] - sortedAsc[lo])
}

// Coarsening ladder, finest → coarsest, with the approximate span of one bucket.
// We pick the FINEST granularity whose enumerated bucket count fits MAX_BUCKETS,
// so the axis is dense enough to show shape but never a wall of hundreds of ticks.
const GRAN_ORDER = ['minute', 'hour', 'day', 'week', 'month']
const APPROX_MS = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_629_800_000, // 30.44 days
}
const MAX_BUCKETS = 60

function chooseGranularity(spanMs) {
  for (const g of GRAN_ORDER) {
    if (Math.floor(spanMs / APPROX_MS[g]) + 1 <= MAX_BUCKETS) return g
  }
  return 'month'
}

// One bucket forward from an aligned boundary date (bucketOf(..).sort). Using
// calendar arithmetic keeps week/month boundaries aligned (Monday-anchored weeks,
// month firsts) rather than drifting on fixed-ms steps.
function advance(date, granularity) {
  const d = new Date(date.getTime())
  switch (granularity) {
    case 'minute': d.setMinutes(d.getMinutes() + 1); break
    case 'hour': d.setHours(d.getHours() + 1); break
    case 'week': d.setDate(d.getDate() + 7); break
    case 'month': d.setMonth(d.getMonth() + 1); break
    case 'day':
    default: d.setDate(d.getDate() + 1); break
  }
  return d
}

// Compact axis label for a bucket boundary — short enough to pack ~60 across the
// axis (hideOverlap thins the rest). Tooltips use the verbose fullLabel instead.
function compactLabel(date, granularity) {
  const mo = date.getMonth()
  const d = date.getDate()
  switch (granularity) {
    case 'minute': return `${mo + 1}/${d} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    case 'hour': return `${mo + 1}/${d} ${pad(date.getHours())}:00`
    case 'week':
    case 'day': return `${mo + 1}/${d}`
    case 'month': return `${MONTHS[mo]} ${date.getFullYear()}`
    default: return `${mo + 1}/${d}`
  }
}

const EMPTY = { buckets: [], totalActions: 0, granularity: null, hasData: false }

function buildTimeOfDayTrendImpl(aggRows) {
  if (!aggRows?.length) return EMPTY

  // Collect valid instances and the min/max timestamp that define the span.
  const items = []
  let minT = Infinity
  let maxT = -Infinity
  for (const r of aggRows) {
    const d = parseTimestamp(r?._action_timestamp)
    if (!d) continue // needs a parseable timestamp…
    const ms = Number(r?.action_duration)
    if (!Number.isFinite(ms) || ms <= 0) continue // …and a finite positive duration
    const t = d.getTime()
    items.push({ d, t, ms, r })
    if (t < minT) minT = t
    if (t > maxT) maxT = t
  }
  if (!items.length) return EMPTY

  const granularity = chooseGranularity(maxT - minT)

  // Enumerate every bucket across [min, max] at the chosen granularity so gaps
  // stay visible. byKey holds the accumulating slots; `order` keeps them
  // chronological (bucketOf keys aren't lexically sortable across granularities).
  const startSort = bucketOf(new Date(minT), granularity).sort
  const endSort = bucketOf(new Date(maxT), granularity).sort
  const byKey = new Map()
  const order = []
  let cur = new Date(startSort)
  let guard = 0
  while (cur.getTime() <= endSort && guard++ < 10_000) {
    const b = bucketOf(cur, granularity)
    if (!byKey.has(b.key)) {
      byKey.set(b.key, {
        key: b.key,
        label: compactLabel(new Date(b.sort), granularity),
        fullLabel: b.label,
        sort: b.sort,
        durations: [],
        instances: [],
      })
      order.push(b.key)
    }
    cur = advance(cur, granularity)
  }

  // Drop each instance into its bucket.
  let total = 0
  for (const it of items) {
    const slot = byKey.get(bucketOf(it.d, granularity).key)
    if (!slot) continue // outside the enumerated range — shouldn't happen
    slot.durations.push(it.ms)
    slot.instances.push({
      actionKey: `${it.r.action_name}::${it.r._action_timestamp ?? ''}`,
      action: it.r.action_name,
      story: it.r.story_name,
      user: it.r.user,
      timestamp: it.r._action_timestamp ?? '',
      duration: it.ms,
      t: it.t,
    })
    total++
  }

  if (!total) return EMPTY

  const buckets = order.map((k) => {
    const slot = byKey.get(k)
    const sorted = [...slot.durations].sort((a, b) => a - b)
    const count = sorted.length
    const p50 = count ? percentile(sorted, 0.5) : null
    const p90 = count ? percentile(sorted, 0.9) : null
    const ratio = p50 && p50 > 0 && p90 != null ? p90 / p50 : null
    return {
      key: slot.key,
      label: slot.label,
      fullLabel: slot.fullLabel,
      sort: slot.sort,
      p50,
      p90,
      ratio,
      count,
      instances: slot.instances,
    }
  })

  return { buckets, totalActions: total, granularity, hasData: true }
}

// Module-scope memo keyed on the aggRows identity (a stable ref out of the
// memoized aggregateByAction), so tab switches don't re-bucket. Non-object
// inputs (null/undefined) fall through to the empty result.
const cache = new WeakMap()
export function buildTimeOfDayTrend(aggRows) {
  if (aggRows === null || typeof aggRows !== 'object') return buildTimeOfDayTrendImpl(aggRows)
  if (cache.has(aggRows)) return cache.get(aggRows)
  const result = buildTimeOfDayTrendImpl(aggRows)
  cache.set(aggRows, result)
  return result
}
