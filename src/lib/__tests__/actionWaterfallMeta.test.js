import { describe, it, expect } from 'vitest'
import { resolveHeaderMeta } from '../actionWaterfallMeta'

describe('resolveHeaderMeta', () => {
  it('reads fields off the selected enriched action entry', () => {
    const actions = [
      { name: 'Go to page', timestamp: '10:03:03', story: 'LS_OPEX', user: 'Z_ATAMAN', durationMs: 1200 },
    ]
    const m = resolveHeaderMeta({ actions, selectedIdx: 0, widgetCount: 3 })
    expect(m).toEqual({
      actionName: 'Go to page',
      story: 'LS_OPEX',
      user: 'Z_ATAMAN',
      timestamp: '10:03:03',
      durationMs: 1200,
      widgetCount: 3,
    })
  })

  it('falls back to the meta prop when the entry omits a field', () => {
    const actions = [{ name: 'Go to page', timestamp: '10:03:03' }]
    const m = resolveHeaderMeta({
      actions,
      selectedIdx: 0,
      meta: { story: 'S1', user: 'U1', durationMs: 900 },
      widgetCount: 1,
    })
    expect(m.story).toBe('S1')
    expect(m.user).toBe('U1')
    expect(m.durationMs).toBe(900)
    expect(m.actionName).toBe('Go to page')
    expect(m.timestamp).toBe('10:03:03')
  })

  it('defaults safely when nothing is available', () => {
    const m = resolveHeaderMeta({ actions: [], selectedIdx: 0 })
    expect(m).toEqual({
      actionName: '',
      story: '',
      user: '',
      timestamp: '',
      durationMs: undefined,
      widgetCount: 0,
    })
  })
})
