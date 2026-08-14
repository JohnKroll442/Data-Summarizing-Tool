import { describe, it, expect } from 'vitest'
import {
  ACTION_VIEWS,
  DEFAULT_ACTION_VIEW,
  isActionViewKey,
  resolveActiveView,
} from '../actionViews'

describe('actionViews', () => {
  it('lists the four views in switcher order with exact labels', () => {
    expect(ACTION_VIEWS.map((v) => v.key)).toEqual(['table', 'heatmap', 'offset', 'timeOfDay'])
    expect(ACTION_VIEWS.map((v) => v.label)).toEqual([
      'Data Table',
      'Story × Action',
      'Offset vs Duration',
      'Time-Of-Day-Trend',
    ])
  })

  it('defaults to the table view', () => {
    expect(DEFAULT_ACTION_VIEW).toBe('table')
  })

  it('isActionViewKey recognizes only known keys', () => {
    expect(isActionViewKey('table')).toBe(true)
    expect(isActionViewKey('heatmap')).toBe(true)
    expect(isActionViewKey('offset')).toBe(true)
    expect(isActionViewKey('timeOfDay')).toBe(true)
    expect(isActionViewKey('bogus')).toBe(false)
    expect(isActionViewKey(undefined)).toBe(false)
  })

  it('resolveActiveView returns valid keys and falls back to the default', () => {
    expect(resolveActiveView('heatmap')).toBe('heatmap')
    expect(resolveActiveView('offset')).toBe('offset')
    expect(resolveActiveView('timeOfDay')).toBe('timeOfDay')
    expect(resolveActiveView(undefined)).toBe('table')
    expect(resolveActiveView(null)).toBe('table')
    expect(resolveActiveView('bogus')).toBe('table')
  })
})
