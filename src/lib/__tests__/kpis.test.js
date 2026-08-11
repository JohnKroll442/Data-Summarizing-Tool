import { describe, it, expect } from 'vitest'
import { computeKpis, percentile } from '../kpis'

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
      'p95 session duration', 'Max session duration',
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
      'Total actions', 'Unique names', '>30s actions',
      'Median duration', 'p90 duration', 'p95 action duration', 'Slowest action',
    ])
    const slowest = kpis.find((k) => k.label === 'Slowest action')
    expect(slowest.value).toContain('Slow')
    expect(slowest.value).toContain('900 ms')
  })

  it('reports median, p90 and the >30s-action count as count + share', () => {
    // Four actions with END−START durations of 10s / 20s / 35s / 40s. Two cross
    // the 30s slow_action cutoff → "2 (50%)". Median of the four is 27.5s.
    const headers = ['USER_ACTION', 'ACTION_TIMESTAMP', 'ACTION_TIMESTAMP_END', 'DURATION']
    const mk = (name, start, end) => ({
      USER_ACTION: name, ACTION_TIMESTAMP: start, ACTION_TIMESTAMP_END: end, DURATION: 1,
    })
    const rows = [
      mk('A', '2026-07-01 10:00:00.000', '2026-07-01 10:00:10.000'),
      mk('B', '2026-07-01 11:00:00.000', '2026-07-01 11:00:20.000'),
      mk('C', '2026-07-01 12:00:00.000', '2026-07-01 12:00:35.000'),
      mk('D', '2026-07-01 13:00:00.000', '2026-07-01 13:00:40.000'),
    ]
    const kpis = computeKpis('action', rows, headers)
    const byLabel = Object.fromEntries(kpis.map((k) => [k.label, k.value]))
    expect(byLabel['>30s actions']).toBe('2 (50%)')
    expect(byLabel['Median duration']).toBe('27.5 s')
  })

  it('produces the expected widget KPI labels (per-phase p95s)', () => {
    const rows = [
      { WIDGET_ID: 'w1', WIDGET_NAME: 'Bar', WIDGET_MEASURE: 'render',  DURATION: 100 },
      { WIDGET_ID: 'w1', WIDGET_NAME: 'Bar', WIDGET_MEASURE: 'network', DURATION: 300 },
      { WIDGET_ID: 'w1', WIDGET_NAME: 'Bar', WIDGET_MEASURE: 'backend', DURATION: 50 },
    ]
    const kpis = computeKpis('widget', rows, WIDGET_HEADERS)
    expect(kpis.map((k) => k.label)).toEqual([
      'p95 render', 'p95 network', 'p95 backend', 'p95 total',
    ])
    const byLabel = Object.fromEntries(kpis.map((k) => [k.label, k.value]))
    // One widget → each phase's p95 is just that widget's exclusive phase time
    // (network 300−50=250, backend 50; render's exclusive time can go negative).
    expect(byLabel['p95 render']).toBe('-200 ms')
    expect(byLabel['p95 network']).toBe('250 ms')
    expect(byLabel['p95 backend']).toBe('50 ms')
    expect(byLabel['p95 total']).toBeDefined()
  })

  it('computes percentiles by linear interpolation, ignoring non-numbers', () => {
    // rank = 0.95 * (5-1) = 3.8 → between 40 (idx 3) and 50 (idx 4): 40 + 10*0.8
    expect(percentile([10, 20, 30, 40, 50], 0.95)).toBeCloseTo(48)
    expect(percentile([50, 10, 30], 0.5)).toBe(30) // median, unsorted input
    expect(percentile([100], 0.95)).toBe(100)      // single value
    expect(percentile([], 0.95)).toBe('')          // nothing to rank
    expect(percentile([5, 'x', null, 15], 1)).toBe(15) // skips non-finite
  })

  it('derives headers from row keys when the headers arg is empty', () => {
    const rows = [{ SESSION_ID: 's1', USER_NAME: 'a', STORY_NAME: 'S', DURATION: 100 }]
    const kpis = computeKpis('session', rows, [])
    const total = kpis.find((k) => k.label === 'Total sessions')
    expect(total.value).toBe('1')
  })
})
