import { describe, it, expect } from 'vitest'
import { memoizeAggregate, memoizeFilter, memoizeAggregate3 } from '../memoize'

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

describe('memoizeAggregate3', () => {
  it('returns the same result for the same (rows, headers, sig)', () => {
    let calls = 0
    const fn = memoizeAggregate3(
      (rows, headers, thresholds) => { calls++; return { count: rows.length, ms: thresholds?.slowMs } },
      (t) => String(t?.slowMs ?? 0),
    )
    const rows = [{ a: 1 }, { a: 2 }]
    const headers = ['a']
    const t = { slowMs: 30000 }

    const first = fn(rows, headers, t)
    const second = fn(rows, headers, t) // same sig → cache hit

    expect(second).toBe(first)
    expect(calls).toBe(1)
  })

  it('treats different sig values as separate cache entries', () => {
    let calls = 0
    const fn = memoizeAggregate3(
      (rows, _h, t) => { calls++; return { ms: t?.ms } },
      (t) => String(t?.ms ?? 0),
    )
    const rows = [{ a: 1 }]
    const headers = ['a']

    const r1 = fn(rows, headers, { ms: 5000 })
    const r2 = fn(rows, headers, { ms: 10000 })

    expect(r1).not.toBe(r2)
    expect(calls).toBe(2)

    // Re-using an existing sig → cache hit, no third call
    const r3 = fn(rows, headers, { ms: 5000 })
    expect(r3).toBe(r1)
    expect(calls).toBe(2)
  })

  it('falls through (no caching) for non-object rows or headers', () => {
    let calls = 0
    const fn = memoizeAggregate3(
      (rows, headers, t) => { calls++; return { rows, t } },
      (t) => String(t),
    )
    fn(null, ['a'], 'x')
    fn([{ a: 1 }], null, 'x')
    expect(calls).toBe(2)
  })
})
