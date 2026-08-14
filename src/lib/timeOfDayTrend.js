/**
 * Time-Of-Day-Trend data layer for the Action View's fourth panel.
 *
 * Buckets action instances by HOUR along the data's actual chronological span
 * (not a fixed 0–23 wheel), so a single-day file yields that day's hours and a
 * multi-day file keeps bucketing forward across days. Reuses the Activity
 * Timeline's hour bucketing (enumerateBuckets / bucketOf) so empty hours in the
 * middle of the span read as gaps and the bucket count stays bounded by
 * MAX_BUCKETS.
 *
 * Per bucket it reports the p50 / p90 of action duration, their ratio, the
 * action count, and the individual instances (for the click-to-drill scatter).
 *
 * Input is the per-instance action rows — aggregateByAction(rows, headers).rows
 * — each carrying `_action_timestamp`, `action_duration`, `action_name`,
 * `story_name`, `user`.
 *
 * Returns { buckets, totalActions, multiDay, hasData } where each bucket is
 *   { key, label, sort, hour, dateKey, p50, p90, ratio, count, instances }
 * and each instance is
 *   { actionKey, action, story, user, timestamp, duration, minute }.
 */

import { parseTimestamp, bucketOf } from './timeBuckets'
import { enumerateBuckets } from './activityTimeline'

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

const EMPTY = { buckets: [], totalActions: 0, multiDay: false, hasData: false }

function buildTimeOfDayTrendImpl(aggRows) {
  if (!aggRows?.length) return EMPTY

  // Keep only instances with a parseable timestamp AND a finite positive
  // duration (a bucket point needs both). Track the span as we go.
  const parsed = []
  let min = null
  let max = null
  for (const r of aggRows) {
    const d = parseTimestamp(r?._action_timestamp)
    if (!d) continue
    const ms = Number(r?.action_duration)
    if (!Number.isFinite(ms) || ms <= 0) continue
    if (min === null || d < min) min = d
    if (max === null || d > max) max = d
    parsed.push({ d, ms, row: r })
  }
  if (!parsed.length) return EMPTY

  // Contiguous hourly buckets across the span (empty hours included, capped at
  // MAX_BUCKETS by enumerateBuckets).
  const { buckets: base, indexByKey } = enumerateBuckets(min, max, 'hour')
  const acc = base.map((b) => ({ ...b, durations: [], instances: [] }))

  for (const { d, ms, row } of parsed) {
    const idx = indexByKey.get(bucketOf(d, 'hour').key)
    if (idx === undefined) continue // beyond the MAX_BUCKETS window
    const slot = acc[idx]
    slot.durations.push(ms)
    slot.instances.push({
      actionKey: `${row.action_name}::${row._action_timestamp ?? ''}`,
      action: row.action_name,
      story: row.story_name,
      user: row.user,
      timestamp: row._action_timestamp ?? '',
      duration: ms,
      minute: d.getMinutes(),
    })
  }

  const buckets = acc.map((slot) => {
    const sorted = [...slot.durations].sort((a, b) => a - b)
    const count = sorted.length
    const p50 = count ? percentile(sorted, 0.5) : null
    const p90 = count ? percentile(sorted, 0.9) : null
    const ratio = p50 && p50 > 0 && p90 != null ? p90 / p50 : null
    const dt = new Date(slot.sort)
    return {
      key: slot.key,
      label: slot.label,
      sort: slot.sort,
      hour: dt.getHours(),
      dateKey: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
      p50,
      p90,
      ratio,
      count,
      instances: slot.instances,
    }
  })

  return {
    buckets,
    totalActions: parsed.length,
    // Labels gain a date prefix once the span crosses calendar days.
    multiDay: new Set(buckets.map((b) => b.dateKey)).size > 1,
    hasData: true,
  }
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
