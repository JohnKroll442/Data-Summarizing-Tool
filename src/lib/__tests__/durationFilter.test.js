import { describe, it, expect } from 'vitest'
import { toMs, matchesDurationFilter, DURATION_UNITS } from '../durationFilter'

describe('toMs', () => {
  it('converts seconds and minutes to milliseconds', () => {
    expect(toMs('2', 'min')).toBe(120_000)
    expect(toMs('30', 'sec')).toBe(30_000)
    expect(toMs(1.5, 'min')).toBe(90_000)
  })

  it('returns null for blank, non-numeric, or negative amounts', () => {
    expect(toMs('', 'min')).toBeNull()
    expect(toMs(null, 'min')).toBeNull()
    expect(toMs(undefined, 'min')).toBeNull()
    expect(toMs('abc', 'min')).toBeNull()
    expect(toMs('-5', 'min')).toBeNull()
  })

  it('returns null for an unknown unit', () => {
    expect(toMs('2', 'hour')).toBeNull()
  })

  it('every declared unit has a positive ms multiplier', () => {
    for (const u of DURATION_UNITS) expect(u.ms).toBeGreaterThan(0)
  })
})

describe('matchesDurationFilter', () => {
  const row = (v) => ({ total_action_duration: v })
  const KEY = 'total_action_duration'

  it('matches every row when the filter is null', () => {
    expect(matchesDurationFilter(row(999999), KEY, null)).toBe(true)
    expect(matchesDurationFilter(row(''), KEY, null)).toBe(true)
  })

  it('matches every row when both bounds are open', () => {
    const f = { minMs: null, maxMs: null }
    expect(matchesDurationFilter(row(120_000), KEY, f)).toBe(true)
  })

  it('keeps values strictly between min and max', () => {
    const f = { minMs: 60_000, maxMs: 180_000 }
    expect(matchesDurationFilter(row(120_000), KEY, f)).toBe(true)
    expect(matchesDurationFilter(row(60_000), KEY, f)).toBe(false)  // exactly at min
    expect(matchesDurationFilter(row(180_000), KEY, f)).toBe(false) // exactly at max
    expect(matchesDurationFilter(row(30_000), KEY, f)).toBe(false)
    expect(matchesDurationFilter(row(200_000), KEY, f)).toBe(false)
  })

  it('open upper bound keeps values strictly over min', () => {
    const f = { minMs: 120_000, maxMs: null }
    expect(matchesDurationFilter(row(180_000), KEY, f)).toBe(true)
    expect(matchesDurationFilter(row(120_000), KEY, f)).toBe(false)
    expect(matchesDurationFilter(row(60_000), KEY, f)).toBe(false)
  })

  it('open lower bound keeps values strictly under max', () => {
    const f = { minMs: null, maxMs: 120_000 }
    expect(matchesDurationFilter(row(60_000), KEY, f)).toBe(true)
    expect(matchesDurationFilter(row(120_000), KEY, f)).toBe(false)
    expect(matchesDurationFilter(row(180_000), KEY, f)).toBe(false)
  })

  it('blank / non-numeric durations never match an active filter', () => {
    const f = { minMs: null, maxMs: 120_000 }
    expect(matchesDurationFilter(row(''), KEY, f)).toBe(false)
    expect(matchesDurationFilter(row(null), KEY, f)).toBe(false)
    expect(matchesDurationFilter(row(undefined), KEY, f)).toBe(false)
    expect(matchesDurationFilter({}, KEY, f)).toBe(false)
  })
})
