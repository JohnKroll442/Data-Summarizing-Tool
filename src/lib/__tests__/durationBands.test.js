import { describe, it, expect } from 'vitest'
import {
  computeDurationBands,
  bucketDurations,
  bucketKeyOf,
  durationTier,
  ROUND_LADDER,
  DURATION_CEIL_MS,
} from '../durationBands'

describe('durationTier', () => {
  it('escalates through the 5 bands at 5s / 30s / 1m / 2m', () => {
    expect(durationTier(4999)).toBe('good')     // < 5s
    expect(durationTier(5000)).toBe('neutral')  // 5s–30s
    expect(durationTier(29999)).toBe('neutral')
    expect(durationTier(30000)).toBe('watch')   // 30s–1m
    expect(durationTier(59999)).toBe('watch')
    expect(durationTier(60000)).toBe('warn')    // 1m–2m
    expect(durationTier(119999)).toBe('warn')
    expect(durationTier(120000)).toBe('bad')    // ≥ 2m
  })

  it('returns null for non-finite input', () => {
    expect(durationTier('ttfb')).toBeNull()
    expect(durationTier(NaN)).toBeNull()
  })
})

describe('computeDurationBands', () => {
  it('falls back to the fixed 8-band ladder for empty / all-non-finite input', () => {
    for (const input of [[], null, undefined, ['', NaN, 'ttfb']]) {
      const bands = computeDurationBands(input)
      expect(bands.map((b) => b.label)).toEqual([
        '<0.5s', '0.5s–2s', '2s–5s', '5s–10s', '10s–30s', '30s–1m', '1m–2m', '>2m',
      ])
      expect(bands[bands.length - 1].danger).toBe(true)
    }
  })

  it('starts at 0, is contiguous [min,max), and snaps every interior edge to the round ladder', () => {
    const bands = computeDurationBands([300, 1200, 4000, 8000, 22000, 55000, 118000])
    expect(bands[0].min).toBe(0)
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].min).toBe(bands[i - 1].max) // contiguous
    }
    // Every non-terminal max is a round ladder value.
    for (const b of bands.slice(0, -1)) {
      expect(ROUND_LADDER).toContain(b.max)
    }
  })

  it('caps up: a dataset reaching ≥2m ends in an open >2m danger band (min = 120000)', () => {
    const bands = computeDurationBands([1000, 5000, 30000, 90000, 125000])
    const terminal = bands[bands.length - 1]
    expect(terminal.min).toBe(DURATION_CEIL_MS) // 120000
    expect(terminal.max).toBe(Infinity)
    expect(terminal.label).toBe('>2m')
    expect(terminal.danger).toBe(true)
  })

  it('adapts down: a dataset topping out under a minute has no >2m bar, terminal contains the max', () => {
    const durations = [1000, 5000, 20000, 44000]
    const maxD = Math.max(...durations)
    const bands = computeDurationBands(durations)
    const terminal = bands[bands.length - 1]
    expect(terminal.danger).toBeUndefined()
    expect(terminal.max).toBe(45000) // next round rung above 44s
    expect(ROUND_LADDER).toContain(terminal.max)
    // The slowest action lands inside the terminal (closed) band.
    expect(terminal.min).toBeLessThanOrEqual(maxD)
    expect(maxD).toBeLessThan(terminal.max)
    // No band edge is ever placed above the 2m ceiling.
    expect(bands.every((b) => b.max <= DURATION_CEIL_MS)).toBe(true)
  })
})

describe('bucketKeyOf', () => {
  it('is min-inclusive / max-exclusive against a supplied band set', () => {
    const bands = computeDurationBands([1000, 5000, 30000, 125000])
    // A value at/above every max lands in the last band; nothing is dropped.
    expect(bucketKeyOf(10 ** 9, bands)).toBe(bands[bands.length - 1].key)
    expect(bucketKeyOf(0, bands)).toBe(bands[0].key)
  })

  it('returns null for blanks / non-finite values', () => {
    const bands = computeDurationBands([1000, 5000, 30000, 125000])
    for (const blank of ['', null, undefined, NaN, 'ttfb', Infinity]) {
      expect(bucketKeyOf(blank, bands)).toBeNull()
    }
  })

  it('agrees with bucketDurations counts (one source of truth for membership)', () => {
    // The rows the table filters to for a band must equal that bar's height.
    const bands = computeDurationBands([500, 3000, 12000, 40000, 130000])
    const values = [-5, 100, 499, 500, 2000, 4999, 9999, 30000, 90000, 200000, '', NaN]
    const byKey = bucketDurations(values, bands).reduce((m, b) => ({ ...m, [b.key]: b.count }), {})
    const tallied = {}
    for (const v of values) {
      const key = bucketKeyOf(v, bands)
      if (key === null) continue
      tallied[key] = (tallied[key] ?? 0) + 1
    }
    for (const b of bands) {
      expect(tallied[b.key] ?? 0).toBe(byKey[b.key])
    }
  })
})

describe('bucketDurations', () => {
  it('starts every band at zero for empty / nullish input (fallback ladder)', () => {
    for (const input of [[], null, undefined]) {
      const out = bucketDurations(input)
      expect(out).toHaveLength(8)
      expect(out.every((b) => b.count === 0)).toBe(true)
    }
  })

  it('drops non-finite values and floors negatives into the first band', () => {
    const bands = computeDurationBands([1000, 5000, 30000, 125000])
    const out = bucketDurations([-5, 100, '', null, 'ttfb', NaN, 150000], bands)
    const byKey = Object.fromEntries(out.map((b) => [b.key, b.count]))
    expect(byKey[bands[0].key]).toBe(2) // -5 and 100 floor into the first band
    expect(byKey[bands[bands.length - 1].key]).toBe(1) // 150000 → terminal >2m
    // The blanks / NaN / "ttfb" are skipped, not bucketed.
    expect(out.reduce((n, b) => n + b.count, 0)).toBe(3)
  })
})
