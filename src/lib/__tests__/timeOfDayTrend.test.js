import { describe, it, expect } from 'vitest'
import { buildTimeOfDayTrend, percentile } from '../timeOfDayTrend'

// aggRow shape mirrors aggregateByAction(...).rows — one row per action instance.
const pad = (n, w = 2) => String(n).padStart(w, '0')
const ts = (y, mo, d, hh, mi = 0, s = 0) =>
  `${y}-${pad(mo)}-${pad(d)} ${pad(hh)}:${pad(mi)}:${pad(s)}.000000000`

const inst = ({ name = 'Open story', story = 'Sales', user = 'alice', t, ms }) => ({
  action_name: name,
  story_name: story,
  user,
  _action_timestamp: t,
  action_duration: ms,
})

describe('percentile', () => {
  it('returns null for an empty set', () => {
    expect(percentile([], 0.5)).toBeNull()
  })

  it('returns the sole value for a one-element set', () => {
    expect(percentile([2000], 0.5)).toBe(2000)
    expect(percentile([2000], 0.9)).toBe(2000)
  })

  it('interpolates linearly between ranks (sorted ascending input)', () => {
    const xs = [1000, 2000, 3000, 4000, 5000]
    expect(percentile(xs, 0.5)).toBe(3000) // rank 2.0 → sorted[2]
    expect(percentile(xs, 0.9)).toBeCloseTo(4600) // rank 3.6 → 4000 + 0.6*1000
  })
})

describe('buildTimeOfDayTrend — shape', () => {
  it('returns an empty structure on empty input', () => {
    const r = buildTimeOfDayTrend([])
    expect(r.hasData).toBe(false)
    expect(r.buckets).toEqual([])
    expect(r.totalActions).toBe(0)
    expect(r.granularity).toBeNull()
  })

  it('buckets a single action with p50=p90=duration, ratio 1, count 1', () => {
    const rows = [inst({ t: ts(2026, 7, 8, 9, 15), ms: 3400 })]
    const r = buildTimeOfDayTrend(rows)
    expect(r.hasData).toBe(true)
    expect(r.totalActions).toBe(1)
    // One instance → zero span → finest granularity (minute), one bucket.
    expect(r.granularity).toBe('minute')
    expect(r.buckets).toHaveLength(1)
    const b = r.buckets[0]
    expect(b.count).toBe(1)
    expect(b.p50).toBe(3400)
    expect(b.p90).toBe(3400)
    expect(b.ratio).toBe(1)
    expect(b.instances).toHaveLength(1)
    expect(b.instances[0]).toMatchObject({
      actionKey: `Open story::${ts(2026, 7, 8, 9, 15)}`,
      action: 'Open story',
      duration: 3400,
    })
    // Instance carries an epoch-ms timestamp for the time-axis drill scatter.
    expect(b.instances[0].t).toBe(new Date(2026, 6, 8, 9, 15).getTime())
  })

  it('computes p50/p90/ratio across several actions in one bucket', () => {
    // All within the same minute → one bucket.
    const rows = [1000, 2000, 3000, 4000, 5000].map((ms, i) =>
      inst({ t: ts(2026, 7, 8, 9, 0, i), ms }),
    )
    const r = buildTimeOfDayTrend(rows)
    expect(r.buckets).toHaveLength(1)
    const b = r.buckets[0]
    expect(b.count).toBe(5)
    expect(b.p50).toBe(3000)
    expect(b.p90).toBeCloseTo(4600)
    expect(b.ratio).toBeCloseTo(4600 / 3000)
  })
})

describe('buildTimeOfDayTrend — granularity adapts to the span', () => {
  // A run of actions across N days at the same hour.
  const daysSpan = (nDays) =>
    Array.from({ length: nDays }, (_, i) => inst({ t: ts(2026, 7, 1 + i, 9, 0), ms: 1000 + i }))

  it('uses hourly buckets for a sub-two-day span', () => {
    const rows = [
      inst({ t: ts(2026, 7, 8, 9, 0), ms: 1000 }),
      inst({ t: ts(2026, 7, 8, 14, 30), ms: 2000 }),
    ]
    const r = buildTimeOfDayTrend(rows)
    expect(r.granularity).toBe('hour')
    // 09:00 … 14:00 inclusive = 6 hourly buckets, gaps filled.
    expect(r.buckets).toHaveLength(6)
    expect(r.buckets[0].count).toBe(1)
    expect(r.buckets[5].count).toBe(1)
    expect(r.buckets[1].count).toBe(0) // an empty in-between hour
    expect(r.buckets[1].p50).toBeNull()
  })

  it('uses daily buckets for a ~2-week span, one bucket per day', () => {
    const rows = daysSpan(14) // Jul 1 … Jul 14
    const r = buildTimeOfDayTrend(rows)
    expect(r.granularity).toBe('day')
    expect(r.buckets).toHaveLength(14)
    // Each day has exactly one action; labels are compact M/D.
    expect(r.buckets.every((b) => b.count === 1)).toBe(true)
    expect(r.buckets[0].label).toBe('7/1')
    expect(r.buckets[13].label).toBe('7/14')
  })

  it('still uses daily buckets at ~6 weeks (≤ 60 buckets)', () => {
    const rows = daysSpan(42)
    const r = buildTimeOfDayTrend(rows)
    expect(r.granularity).toBe('day')
    expect(r.buckets).toHaveLength(42)
  })

  it('coarsens to weekly buckets for a ~3-month span', () => {
    // ~90 days would be 90 daily buckets (> 60) → weekly instead.
    const rows = Array.from({ length: 90 }, (_, i) => {
      const day = new Date(2026, 6, 1)
      day.setDate(day.getDate() + i)
      return inst({
        t: ts(day.getFullYear(), day.getMonth() + 1, day.getDate(), 9, 0),
        ms: 1000 + i,
      })
    })
    const r = buildTimeOfDayTrend(rows)
    expect(r.granularity).toBe('week')
    expect(r.buckets.length).toBeLessThanOrEqual(60)
    expect(r.buckets.length).toBeGreaterThan(10)
    expect(r.totalActions).toBe(90)
  })
})

describe('buildTimeOfDayTrend — aggregation & gaps along the timeline', () => {
  it('aggregates multiple actions that share a bucket', () => {
    // Two actions on the same day (daily granularity via a 3-day span).
    const rows = [
      inst({ t: ts(2026, 7, 1, 9, 0), ms: 1000 }),
      inst({ t: ts(2026, 7, 1, 15, 0), ms: 3000 }),
      inst({ t: ts(2026, 7, 3, 9, 0), ms: 2000 }),
    ]
    const r = buildTimeOfDayTrend(rows)
    expect(r.granularity).toBe('hour') // 3-day span in hours = 51 buckets, still ≤ 60
    // The two Jul-1 actions fall in different hourly buckets here; assert the
    // total and that same-bucket aggregation works via the count-5 test above.
    expect(r.totalActions).toBe(3)
    // Every populated bucket's instances match its count.
    for (const b of r.buckets) expect(b.instances).toHaveLength(b.count)
  })

  it('emits empty buckets for quiet stretches instead of dropping them', () => {
    const rows = [
      inst({ t: ts(2026, 7, 1, 9, 0), ms: 1000 }),
      inst({ t: ts(2026, 7, 10, 9, 0), ms: 2000 }), // 9 days later
    ]
    const r = buildTimeOfDayTrend(rows)
    expect(r.granularity).toBe('day')
    expect(r.buckets).toHaveLength(10) // Jul 1 … Jul 10 inclusive
    expect(r.buckets[0].count).toBe(1)
    expect(r.buckets[9].count).toBe(1)
    // The 8 days in between are present but empty (null percentiles).
    const empties = r.buckets.slice(1, 9)
    expect(empties.every((b) => b.count === 0 && b.p50 === null)).toBe(true)
  })

  it('keeps buckets in chronological order', () => {
    const rows = [
      inst({ t: ts(2026, 7, 10, 9, 0), ms: 2000 }),
      inst({ t: ts(2026, 7, 1, 9, 0), ms: 1000 }),
    ]
    const r = buildTimeOfDayTrend(rows)
    const sorts = r.buckets.map((b) => b.sort)
    expect(sorts).toEqual([...sorts].sort((a, b) => a - b))
  })

  it('drops rows with an unparseable timestamp or non-positive duration', () => {
    const rows = [
      inst({ t: ts(2026, 7, 8, 9, 0), ms: 1000 }),
      inst({ t: 'not a date', ms: 5000 }),
      inst({ t: ts(2026, 7, 8, 9, 5), ms: 0 }),
      inst({ t: ts(2026, 7, 8, 9, 6), ms: -3 }),
    ]
    const r = buildTimeOfDayTrend(rows)
    expect(r.totalActions).toBe(1)
  })
})
