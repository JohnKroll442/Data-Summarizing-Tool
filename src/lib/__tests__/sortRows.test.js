import { describe, it, expect } from 'vitest'
import { sortRows } from '../sortRows'

const dur = (v) => ({ action_duration: v })

describe('sortRows', () => {
  it('sorts numeric/duration ascending with empties LAST', () => {
    const rows = [dur(300), dur(''), dur(50), dur(null), dur(120)]
    const out = sortRows(rows, 'action_duration', 'asc', 'duration')
    expect(out.map((r) => r.action_duration)).toEqual([50, 120, 300, '', null])
  })

  it('sorts numeric/duration descending with empties STILL last', () => {
    // The whole point of the fix: dashes must not flip to the top on desc.
    const rows = [dur(300), dur(''), dur(50), dur(null), dur(120)]
    const out = sortRows(rows, 'action_duration', 'desc', 'duration')
    expect(out.map((r) => r.action_duration)).toEqual([300, 120, 50, '', null])
  })

  it('keeps empties last for string columns in both directions', () => {
    const rows = [{ user: 'bob' }, { user: '' }, { user: 'amy' }, { user: undefined }]
    const asc = sortRows(rows, 'user', 'asc', 'string')
    expect(asc.map((r) => r.user)).toEqual(['amy', 'bob', '', undefined])
    const desc = sortRows(rows, 'user', 'desc', 'string')
    expect(desc.map((r) => r.user)).toEqual(['bob', 'amy', '', undefined])
  })

  it('puts negative durations at the BOTTOM on a descending sort (never "longest")', () => {
    // Exclusive-time anomalies (e.g. render −250 ms) must not rank as "longest".
    const rows = [dur(460), dur(-250), dur(50), dur(-10), dur('')]
    const out = sortRows(rows, 'action_duration', 'desc', 'duration')
    expect(out.map((r) => r.action_duration)).toEqual([460, 50, -10, -250, ''])
  })

  it('puts negative durations at the TOP on an ascending sort (smallest first)', () => {
    const rows = [dur(460), dur(-250), dur(50), dur(-10), dur('')]
    const out = sortRows(rows, 'action_duration', 'asc', 'duration')
    expect(out.map((r) => r.action_duration)).toEqual([-250, -10, 50, 460, ''])
  })

  it('does not demote negatives for plain number columns (only durations)', () => {
    const rows = [{ n: 5 }, { n: -3 }, { n: 1 }]
    const out = sortRows(rows, 'n', 'desc', 'number')
    expect(out.map((r) => r.n)).toEqual([5, 1, -3])
  })

  it('is a no-op when no key or direction is given', () => {
    const rows = [dur(3), dur(1)]
    expect(sortRows(rows, null, 'asc')).toBe(rows)
    expect(sortRows(rows, 'action_duration', null)).toBe(rows)
  })
})
