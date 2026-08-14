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
  })

  it('buckets a single action into its hour with p50=p90=duration, ratio 1, count 1', () => {
    const rows = [inst({ t: ts(2026, 7, 8, 9, 15), ms: 3400 })]
    const r = buildTimeOfDayTrend(rows)
    expect(r.hasData).toBe(true)
    expect(r.totalActions).toBe(1)
    expect(r.buckets).toHaveLength(1)
    const b = r.buckets[0]
    expect(b.hour).toBe(9)
    expect(b.count).toBe(1)
    expect(b.p50).toBe(3400)
    expect(b.p90).toBe(3400)
    expect(b.ratio).toBe(1)
    expect(b.instances).toHaveLength(1)
    expect(b.instances[0]).toMatchObject({
      actionKey: `Open story::${ts(2026, 7, 8, 9, 15)}`,
      action: 'Open story',
      duration: 3400,
      minute: 15,
    })
  })

  it('computes p50/p90/ratio across several actions in the same hour', () => {
    const rows = [1000, 2000, 3000, 4000, 5000].map((ms, i) =>
      inst({ t: ts(2026, 7, 8, 9, i), ms }),
    )
    const [b] = buildTimeOfDayTrend(rows).buckets
    expect(b.count).toBe(5)
    expect(b.p50).toBe(3000)
    expect(b.p90).toBeCloseTo(4600)
    expect(b.ratio).toBeCloseTo(4600 / 3000)
  })
})

describe('buildTimeOfDayTrend — span & scaling', () => {
  it('keeps empty hours between populated ones as zero-count gaps (single day)', () => {
    const rows = [
      inst({ t: ts(2026, 7, 8, 9, 0), ms: 1000 }),
      inst({ t: ts(2026, 7, 8, 11, 0), ms: 2000 }), // skip hour 10
    ]
    const r = buildTimeOfDayTrend(rows)
    expect(r.multiDay).toBe(false)
    expect(r.buckets.map((b) => b.hour)).toEqual([9, 10, 11])
    expect(r.buckets.map((b) => b.count)).toEqual([1, 0, 1])
    // The empty hour carries no percentiles (a gap in the line, not a zero dip).
    expect(r.buckets[1].p50).toBeNull()
    expect(r.buckets[1].p90).toBeNull()
    expect(r.buckets[1].ratio).toBeNull()
  })

  it('expands past 24 hours across multiple days, marking multiDay', () => {
    const rows = [
      inst({ t: ts(2026, 7, 8, 23, 0), ms: 1000 }),
      inst({ t: ts(2026, 7, 9, 1, 0), ms: 2000 }), // next day, hour 1
    ]
    const r = buildTimeOfDayTrend(rows)
    expect(r.multiDay).toBe(true)
    // 23:00 Jul 8 → 00:00 Jul 9 → 01:00 Jul 9 = 3 contiguous hourly buckets.
    expect(r.buckets).toHaveLength(3)
    expect(r.buckets.map((b) => b.count)).toEqual([1, 0, 1])
    expect(r.buckets[0].dateKey).toBe('2026-07-08')
    expect(r.buckets[2].dateKey).toBe('2026-07-09')
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
    expect(r.buckets).toHaveLength(1)
    expect(r.buckets[0].count).toBe(1)
  })
})
