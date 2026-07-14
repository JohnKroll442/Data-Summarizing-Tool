import { describe, it, expect } from 'vitest'
import { memoizeAggregate, memoizeFilter } from '../memoize'

describe('memoizeAggregate', () => {
  it('returns the same result reference for the same (rows, headers)', () => {
    let calls = 0
    const fn = memoizeAggregate((rows, headers) => {
      calls++
      return { count: rows.length, headers }
    })
    const rows = [{ a: 1 }, { a: 2 }]
    const headers = ['a']

    const first = fn(rows, headers)
    const second = fn(rows, headers)

    expect(second).toBe(first) // cache hit — same object reference
    expect(calls).toBe(1) // impl ran once
  })

  it('recomputes when the rows reference changes', () => {
    let calls = 0
    const fn = memoizeAggregate((rows) => {
      calls++
      return { count: rows.length }
    })
    const headers = ['a']

    const a = fn([{ a: 1 }], headers)
    const b = fn([{ a: 1 }], headers) // different array reference

    expect(b).not.toBe(a)
    expect(calls).toBe(2)
  })

  it('bypasses the cache (still returns correct values) for non-object args', () => {
    let calls = 0
    const fn = memoizeAggregate((rows, headers) => {
      calls++
      return { rows, headers }
    })
    expect(fn(null, ['a'])).toEqual({ rows: null, headers: ['a'] })
    expect(fn([{ a: 1 }], null)).toEqual({ rows: [{ a: 1 }], headers: null })
    expect(calls).toBe(2)
  })
})

describe('memoizeFilter', () => {
  it('returns a stable scoped-array reference for the same (rows, arg)', () => {
    let calls = 0
    const fn = memoizeFilter(
      (rows, headers, arg) => {
        calls++
        return rows.filter((r) => r.g === arg)
      },
      (arg) => String(arg),
    )
    const rows = [{ g: 'x' }, { g: 'y' }, { g: 'x' }]

    const first = fn(rows, [], 'x')
    const second = fn(rows, [], 'x')

    expect(second).toBe(first)
    expect(calls).toBe(1)
    expect(first).toEqual([{ g: 'x' }, { g: 'x' }])
  })

  it('treats different signatures as separate cache entries', () => {
    let calls = 0
    const fn = memoizeFilter(
      (rows, headers, arg) => {
        calls++
        return rows.filter((r) => r.g === arg)
      },
      (arg) => String(arg),
    )
    const rows = [{ g: 'x' }, { g: 'y' }]

    const x = fn(rows, [], 'x')
    const y = fn(rows, [], 'y')

    expect(x).not.toBe(y)
    expect(calls).toBe(2)
    expect(fn(rows, [], 'x')).toBe(x) // 'x' still cached
    expect(calls).toBe(2)
  })
})
