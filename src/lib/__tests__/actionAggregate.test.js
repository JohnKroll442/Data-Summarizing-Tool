import { describe, it, expect } from 'vitest'
import { aggregateByAction, RECOGNIZED_MEASURES } from '../actionAggregate'

const HEADERS = [
  'USER_NAME', 'USER_ACTION', 'ACTION_TIMESTAMP',
  'WIDGET_ID', 'WIDGET_MEASURE', 'WIDGET_SUBMEASURE', 'DURATION',
]

const row = (over = {}) => ({
  USER_NAME: 'alice',
  USER_ACTION: 'Open story',
  ACTION_TIMESTAMP: '10:00:00',
  WIDGET_ID: 'w1',
  WIDGET_MEASURE: 'render',
  WIDGET_SUBMEASURE: '',
  DURATION: 100,
  ...over,
})

describe('aggregateByAction', () => {
  it('exposes the recognized measure list', () => {
    expect(RECOGNIZED_MEASURES).toEqual(['render', 'frontend', 'network', 'backend', 'offset'])
  })

  it('returns empty rows on empty input', () => {
    const r1 = aggregateByAction([], HEADERS)
    const r2 = aggregateByAction(null, HEADERS)
    expect(r1.rows).toEqual([])
    expect(r2.rows).toEqual([])
    expect(r1.columns.map((c) => c.key)).toEqual([
      'user', 'action_name', 'widget_count',
      'max_frontend', 'max_network', 'max_backend',
    ])
  })

  it('returns empty rows when no action-name column can be detected', () => {
    const rows = [{ FOO: 'x' }]
    const result = aggregateByAction(rows, ['FOO'])
    expect(result.rows).toEqual([])
    expect(result.mapping.actionName).toBe('')
  })

  it('keys grouping by (action name + timestamp)', () => {
    const rows = [
      row({ USER_ACTION: 'Open story', ACTION_TIMESTAMP: 't1', DURATION: 50 }),
      row({ USER_ACTION: 'Open story', ACTION_TIMESTAMP: 't1', DURATION: 200 }),
      row({ USER_ACTION: 'Open story', ACTION_TIMESTAMP: 't2', DURATION: 300 }),
    ]
    const { rows: out } = aggregateByAction(rows, HEADERS)
    expect(out).toHaveLength(2)
    const t1 = out.find((r) => r._action_timestamp === 't1')
    const t2 = out.find((r) => r._action_timestamp === 't2')
    expect(t1.max_frontend).toBe(200)
    expect(t2.max_frontend).toBe(300)
  })

  it('falls back to name-only grouping when no timestamp column exists', () => {
    const headers = HEADERS.filter((h) => h !== 'ACTION_TIMESTAMP')
    const rows = [
      row({ USER_ACTION: 'A', DURATION: 10 }),
      row({ USER_ACTION: 'A', DURATION: 20 }),
      row({ USER_ACTION: 'B', DURATION: 5 }),
    ].map((r) => { delete r.ACTION_TIMESTAMP; return r })
    const { rows: out, mapping } = aggregateByAction(rows, headers)
    expect(mapping.actionTimestamp).toBe('')
    expect(out).toHaveLength(2)
    expect(out.find((r) => r.action_name === 'A').max_frontend).toBe(20)
  })

  it('splits max duration across render / network / backend measures', () => {
    const rows = [
      row({ WIDGET_MEASURE: 'render',  DURATION: 100 }),
      row({ WIDGET_MEASURE: 'render',  DURATION: 250 }),
      row({ WIDGET_MEASURE: 'network', DURATION: 500 }),
      row({ WIDGET_MEASURE: 'backend', DURATION: 40  }),
    ]
    const { rows: out } = aggregateByAction(rows, HEADERS)
    expect(out).toHaveLength(1)
    expect(out[0].max_frontend).toBe(250)
    expect(out[0].max_network).toBe(500)
    expect(out[0].max_backend).toBe(40)
  })

  // The measure column may use "network_ttfb" as a folded submeasure — must
  // still count for the network bucket.
  it('accepts <target>_<suffix> as a folded measure match', () => {
    const rows = [
      row({ WIDGET_MEASURE: 'network_ttfb', DURATION: 300 }),
      row({ WIDGET_MEASURE: 'network_full', DURATION: 800 }),
    ]
    const { rows: out } = aggregateByAction(rows, HEADERS)
    expect(out[0].max_network).toBe(800)
  })

  it('counts distinct widget ids for widget_count', () => {
    const rows = [
      row({ WIDGET_ID: 'w1' }),
      row({ WIDGET_ID: 'w2' }),
      row({ WIDGET_ID: 'w1' }),
      row({ WIDGET_ID: '' }),
      row({ WIDGET_ID: null }),
    ]
    const { rows: out } = aggregateByAction(rows, HEADERS)
    expect(out[0].widget_count).toBe(2)
  })

  it('skips rows with empty/null action names', () => {
    const rows = [
      row({ USER_ACTION: 'A' }),
      row({ USER_ACTION: '' }),
      row({ USER_ACTION: null }),
    ]
    const { rows: out } = aggregateByAction(rows, HEADERS)
    expect(out).toHaveLength(1)
    expect(out[0].action_name).toBe('A')
  })

  it('rejects USER_ACTION_ID and USER_ACTION_TIMESTAMP as the action-name column', () => {
    const headers = ['USER_ACTION_ID', 'USER_ACTION_TIMESTAMP', 'USER_ACTION', 'DURATION']
    const rows = [{
      USER_ACTION_ID: 'aid',
      USER_ACTION_TIMESTAMP: 'ats',
      USER_ACTION: 'Open story',
      DURATION: 10,
    }]
    const { mapping } = aggregateByAction(rows, headers)
    expect(mapping.actionName).toBe('USER_ACTION')
  })

  it('rejects the ACTION_END_TIMESTAMP flavor for the action timestamp', () => {
    const headers = ['USER_ACTION', 'ACTION_END_TIMESTAMP', 'ACTION_TIMESTAMP', 'DURATION']
    const rows = [{
      USER_ACTION: 'A',
      ACTION_END_TIMESTAMP: 'end',
      ACTION_TIMESTAMP: 'start',
      DURATION: 10,
    }]
    const { mapping } = aggregateByAction(rows, headers)
    expect(mapping.actionTimestamp).toBe('ACTION_TIMESTAMP')
  })
})
