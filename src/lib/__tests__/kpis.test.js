import { describe, it, expect } from 'vitest'
import { computeKpis } from '../kpis'

const SESSION_HEADERS = ['SESSION_ID', 'USER_NAME', 'STORY_NAME', 'DURATION']
const ACTION_HEADERS = [
  'USER_NAME', 'USER_ACTION', 'ACTION_TIMESTAMP',
  'WIDGET_ID', 'WIDGET_MEASURE', 'DURATION',
]
const WIDGET_HEADERS = ['WIDGET_ID', 'WIDGET_NAME', 'WIDGET_MEASURE', 'DURATION']

describe('computeKpis', () => {
  it('returns null for empty rows', () => {
    expect(computeKpis('session', [], SESSION_HEADERS)).toBeNull()
    expect(computeKpis('action', null, ACTION_HEADERS)).toBeNull()
  })

  it('returns null for an unknown variant', () => {
    expect(computeKpis('bogus', [{ X: 1 }], ['X'])).toBeNull()
  })

  it('produces the expected session KPI labels', () => {
    const rows = [{ SESSION_ID: 's1', USER_NAME: 'a', STORY_NAME: 'S', DURATION: 100 }]
    const kpis = computeKpis('session', rows, SESSION_HEADERS)
    expect(kpis.map((k) => k.label)).toEqual([
      'Total sessions', 'Unique users',
      'Avg actions / session', 'Max session duration',
    ])
  })

  it('formats numeric session KPIs (count + duration)', () => {
    const rows = [
      { SESSION_ID: 's1', USER_NAME: 'a', STORY_NAME: 'S', DURATION: 100 },
      { SESSION_ID: 's1', USER_NAME: 'a', STORY_NAME: 'S', DURATION: 250 },
      { SESSION_ID: 's2', USER_NAME: 'b', STORY_NAME: 'S', DURATION: 500 },
    ]
    const kpis = computeKpis('session', rows, SESSION_HEADERS)
    const byLabel = Object.fromEntries(kpis.map((k) => [k.label, k.value]))
    expect(byLabel['Total sessions']).toBe('2')
    expect(byLabel['Unique users']).toBe('2')
    expect(byLabel['Max session duration']).toBe('500 ms')
  })

  it('renders missing / non-detected KPI values as em-dash', () => {
    const rows = [{ FOO: 'x' }]
    const kpis = computeKpis('session', rows, ['FOO'])
    for (const k of kpis) {
      expect(k.value).toBe('—')
    }
  })

  it('produces the expected action KPI labels and slowest-action string', () => {
    const rows = [
      { USER_NAME: 'a', USER_ACTION: 'Fast', ACTION_TIMESTAMP: 't1', WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 50 },
      { USER_NAME: 'a', USER_ACTION: 'Slow', ACTION_TIMESTAMP: 't2', WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 900 },
    ]
    const kpis = computeKpis('action', rows, ACTION_HEADERS)
    expect(kpis.map((k) => k.label)).toEqual([
      'Total actions', 'Unique names', 'Avg duration', 'Slowest action',
    ])
    const slowest = kpis.find((k) => k.label === 'Slowest action')
    expect(slowest.value).toContain('Slow')
    expect(slowest.value).toContain('900 ms')
  })

  it('produces the expected widget KPI labels', () => {
    const rows = [
      { WIDGET_ID: 'w1', WIDGET_NAME: 'Bar', WIDGET_MEASURE: 'render',  DURATION: 100 },
      { WIDGET_ID: 'w1', WIDGET_NAME: 'Bar', WIDGET_MEASURE: 'network', DURATION: 300 },
      { WIDGET_ID: 'w1', WIDGET_NAME: 'Bar', WIDGET_MEASURE: 'backend', DURATION: 50 },
    ]
    const kpis = computeKpis('widget', rows, WIDGET_HEADERS)
    expect(kpis.map((k) => k.label)).toEqual([
      'Total widgets', 'Avg render time', 'Avg network time', 'Avg backend time',
    ])
    const byLabel = Object.fromEntries(kpis.map((k) => [k.label, k.value]))
    expect(byLabel['Total widgets']).toBe('1')
    expect(byLabel['Avg render time']).toBe('100 ms')
    expect(byLabel['Avg network time']).toBe('300 ms')
    expect(byLabel['Avg backend time']).toBe('50 ms')
  })

  it('derives headers from row keys when the headers arg is empty', () => {
    const rows = [{ SESSION_ID: 's1', USER_NAME: 'a', STORY_NAME: 'S', DURATION: 100 }]
    const kpis = computeKpis('session', rows, [])
    const total = kpis.find((k) => k.label === 'Total sessions')
    expect(total.value).toBe('1')
  })
})
