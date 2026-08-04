import { describe, it, expect } from 'vitest'
import { emptyViewedItems, addViewed } from '../viewedItems'

describe('emptyViewedItems', () => {
  it('returns a fresh empty map per view', () => {
    expect(emptyViewedItems()).toEqual({ session: {}, action: {}, widget: {} })
  })

  it('returns a new object each call (safe to use as a reset value)', () => {
    expect(emptyViewedItems()).not.toBe(emptyViewedItems())
  })
})

describe('addViewed', () => {
  it('marks an id viewed under the given view', () => {
    const next = addViewed(emptyViewedItems(), 'session', 'sess-1')
    expect(next.session['sess-1']).toBe(true)
  })

  it('stringifies the id so numeric and string keys agree', () => {
    const next = addViewed(emptyViewedItems(), 'session', 5)
    expect(next.session['5']).toBe(true)
  })

  it('returns a NEW reference when something changes (drives re-render)', () => {
    const prev = emptyViewedItems()
    const next = addViewed(prev, 'widget', 'w1')
    expect(next).not.toBe(prev)
    expect(next.widget).not.toBe(prev.widget)
  })

  it('returns the SAME reference when the id is already viewed (idempotent)', () => {
    const first = addViewed(emptyViewedItems(), 'action', 'a::10')
    const second = addViewed(first, 'action', 'a::10')
    expect(second).toBe(first)
  })

  it('leaves other views untouched', () => {
    const prev = emptyViewedItems()
    const next = addViewed(prev, 'session', 's1')
    expect(next.action).toBe(prev.action)
    expect(next.widget).toBe(prev.widget)
  })

  it('ignores invalid input (no view, null id, unknown view)', () => {
    const prev = emptyViewedItems()
    expect(addViewed(prev, '', 's1')).toBe(prev)
    expect(addViewed(prev, 'session', null)).toBe(prev)
    expect(addViewed(prev, 'session', undefined)).toBe(prev)
    expect(addViewed(prev, 'nope', 's1')).toBe(prev)
  })

  it('accepts 0 as a valid id (only null/undefined are rejected)', () => {
    const next = addViewed(emptyViewedItems(), 'widget', 0)
    expect(next.widget['0']).toBe(true)
  })
})
