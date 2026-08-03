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

  it('is a no-op when no key or direction is given', () => {
    const rows = [dur(3), dur(1)]
    expect(sortRows(rows, null, 'asc')).toBe(rows)
    expect(sortRows(rows, 'action_duration', null)).toBe(rows)
  })
})
