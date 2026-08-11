import { describe, it, expect } from 'vitest'
import { bucketDurations, bucketKeyOf, DURATION_BUCKETS } from '../DurationDistribution'

describe('bucketDurations', () => {
  it('exposes six ordered buckets with the >30s danger bucket last', () => {
    expect(DURATION_BUCKETS.map((b) => b.label)).toEqual([
      '<0.5s', '0.5–2s', '2–5s', '5–10s', '10–30s', '>30s',
    ])
    expect(DURATION_BUCKETS[DURATION_BUCKETS.length - 1].danger).toBe(true)
  })

  it('starts every bucket at zero for empty / nullish input', () => {
    for (const input of [[], null, undefined]) {
      const out = bucketDurations(input)
      expect(out).toHaveLength(6)
      expect(out.every((b) => b.count === 0)).toBe(true)
    }
  })

  it('places each edge value in the higher (min-inclusive, max-exclusive) bucket', () => {
    // Edges: 500 → 0.5–2s, 2000 → 2–5s, 5000 → 5–10s, 10000 → 10–30s, 30000 → >30s.
    const counts = tally([499, 500, 1999, 2000, 4999, 5000, 9999, 10000, 29999, 30000])
    expect(counts).toEqual({
      '<0.5s': 1,   // 499
      '0.5–2s': 2,  // 500, 1999
      '2–5s': 2,    // 2000, 4999
      '5–10s': 2,   // 5000, 9999
      '10–30s': 2,  // 10000, 29999
      '>30s': 1,    // 30000
    })
  })

  it('drops non-finite values and floors negatives into the first bucket', () => {
    const out = bucketDurations([-5, 100, '', null, 'ttfb', NaN, 40000])
    const byLabel = Object.fromEntries(out.map((b) => [b.label, b.count]))
    expect(byLabel['<0.5s']).toBe(2)   // -5 and 100
    expect(byLabel['>30s']).toBe(1)    // 40000
    // The blanks / NaN / "ttfb" are skipped, not bucketed.
    expect(out.reduce((n, b) => n + b.count, 0)).toBe(3)
  })
})

function tally(values) {
  return Object.fromEntries(bucketDurations(values).map((b) => [b.label, b.count]))
}

describe('bucketKeyOf', () => {
  it('maps values to the right bucket key, min-inclusive / max-exclusive', () => {
    expect(bucketKeyOf(250)).toBe('lt0_5')
    expect(bucketKeyOf(500)).toBe('0_5_2')   // on the 0.5s floor → higher bucket
    expect(bucketKeyOf(2000)).toBe('2_5')    // on the 2s floor → 2–5s
    expect(bucketKeyOf(7000)).toBe('5_10')
    expect(bucketKeyOf(30000)).toBe('gt30')  // on the 30s floor → danger bucket
    expect(bucketKeyOf(45000)).toBe('gt30')
    expect(bucketKeyOf(Infinity)).toBeNull() // non-finite → no bucket (guarded out)
  })

  it('floors negatives into the first bucket and returns null for blanks / non-finite', () => {
    expect(bucketKeyOf(-5)).toBe('lt0_5')
    for (const blank of ['', null, undefined, NaN, 'ttfb', Infinity]) {
      expect(bucketKeyOf(blank)).toBeNull()
    }
  })

  it('agrees with bucketDurations counts (one source of truth for membership)', () => {
    // The rows the table filters to for a bucket must equal that bar's height.
    const values = [-5, 100, 499, 500, 2000, 4999, 9999, 30000, 45000, '', NaN]
    const byKey = bucketDurations(values).reduce((m, b) => ({ ...m, [b.key]: b.count }), {})
    const tallied = {}
    for (const v of values) {
      const key = bucketKeyOf(v)
      if (key === null) continue
      tallied[key] = (tallied[key] ?? 0) + 1
    }
    for (const b of DURATION_BUCKETS) {
      expect(tallied[b.key] ?? 0).toBe(byKey[b.key])
    }
  })
})
