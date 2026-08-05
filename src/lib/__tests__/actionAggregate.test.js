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
      'session_id', 'user', 'story_name', 'action_name', 'action_duration',
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
    // The displayed column mirrors the hidden meta timestamp.
    expect(t1.action_timestamp).toBe('t1')
    expect(t2.action_timestamp).toBe('t2')
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

  it('shows exclusive (nested) phase maxes: frontend render−network, network network−backend, backend as-is', () => {
    const rows = [
      row({ WIDGET_MEASURE: 'render',  DURATION: 100 }),
      row({ WIDGET_MEASURE: 'render',  DURATION: 250 }),
      row({ WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'ttfb', DURATION: 500 }),
      row({ WIDGET_MEASURE: 'backend', DURATION: 40  }),
    ]
    const { rows: out } = aggregateByAction(rows, HEADERS)
    expect(out).toHaveLength(1)
    // Single widget w1: render 250, network 500, backend 40.
    // frontend 250−500 = −250, network 500−40 = 460, backend unchanged 40.
    expect(out[0].max_frontend).toBe(-250)
    expect(out[0].max_network).toBe(460)
    expect(out[0].max_backend).toBe(40)
  })

  it('takes the max exclusive value ACROSS widgets in the action (matching the widget table)', () => {
    // Two widgets in one action. w1 network 500 / backend 40 → 460; w2 network
    // 300 / backend 250 → 50. Max network for the action is w1's 460 — the
    // largest value the widget table shows after drilling into this action.
    const rows = [
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'ttfb', DURATION: 500 }),
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'backend', DURATION: 40 }),
      row({ WIDGET_ID: 'w2', WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'ttfb', DURATION: 300 }),
      row({ WIDGET_ID: 'w2', WIDGET_MEASURE: 'backend', DURATION: 250 }),
    ]
    const { rows: out } = aggregateByAction(rows, HEADERS)
    expect(out[0].max_network).toBe(460)
    expect(out[0].max_backend).toBe(250) // backend unchanged: max(40, 250)
  })

  // Network counts the ttfb round-trip only. A larger 'waiting'/incomplete
  // network sub-measure (which can span the whole session) must NOT win the
  // network bucket — otherwise every widget shows the same giant value.
  it('counts only the ttfb sub-measure for max_network', () => {
    const rows = [
      row({ WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'ttfb',    DURATION: 300 }),
      row({ WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'waiting', DURATION: 900000 }),
    ]
    const { rows: out } = aggregateByAction(rows, HEADERS)
    expect(out[0].max_network).toBe(300)
  })

  // The ttfb marker may instead be folded into WIDGET_MEASURE as
  // 'network_ttfb' — that still counts for the network bucket, while
  // 'network_full' (a non-ttfb sub-measure) does not.
  it('accepts network_ttfb as a folded ttfb match', () => {
    const rows = [
      row({ WIDGET_MEASURE: 'network_ttfb', DURATION: 300 }),
      row({ WIDGET_MEASURE: 'network_full', DURATION: 800 }),
    ]
    const { rows: out } = aggregateByAction(rows, HEADERS)
    expect(out[0].max_network).toBe(300)
  })

  // When the CSV has no WIDGET_SUBMEASURE column we can't distinguish
  // sub-measures, so fall back to the max across all network rows.
  it('falls back to all-network max when there is no submeasure column', () => {
    const headers = HEADERS.filter((h) => h !== 'WIDGET_SUBMEASURE')
    const rows = [
      row({ WIDGET_MEASURE: 'network', DURATION: 500 }),
    ].map((r) => { delete r.WIDGET_SUBMEASURE; return r })
    const { rows: out } = aggregateByAction(rows, headers)
    expect(out[0].max_network).toBe(500)
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

  it('surfaces story_name and story_page from the CSV when the columns exist', () => {
    const headers = [...HEADERS, 'STORY_NAME', 'STORY_PAGE']
    const rows = [
      row({ USER_ACTION: 'A', STORY_NAME: 'Sales Overview', STORY_PAGE: 'Page 1' }),
      row({ USER_ACTION: 'A', STORY_NAME: 'Sales Overview', STORY_PAGE: 'Page 1' }),
    ]
    const { rows: out, mapping } = aggregateByAction(rows, headers)
    expect(mapping.storyName).toBe('STORY_NAME')
    expect(mapping.storyPage).toBe('STORY_PAGE')
    expect(out[0].story_name).toBe('Sales Overview')
  })

  it('leaves story columns blank when the CSV has no story columns', () => {
    const rows = [row()]
    const { rows: out, mapping } = aggregateByAction(rows, HEADERS)
    expect(mapping.storyName).toBe('')
    expect(mapping.storyPage).toBe('')
    expect(out[0].story_name).toBe('')
  })

  it('sets action_duration to the max DURATION when there is no render-timestamp column', () => {
    // Fallback path: with no WIDGET_RENDER_TIMESTAMP column, action_duration is
    // the per-action max DURATION — the value Session View sums, keeping the
    // two views consistent for CSV shapes that lack render timestamps.
    const rows = [
      row({ USER_ACTION: 'A', ACTION_TIMESTAMP: 't1', WIDGET_MEASURE: 'render',  DURATION: 100 }),
      row({ USER_ACTION: 'A', ACTION_TIMESTAMP: 't1', WIDGET_MEASURE: 'network', DURATION: 450 }),
      row({ USER_ACTION: 'A', ACTION_TIMESTAMP: 't1', WIDGET_MEASURE: 'backend', DURATION: 60  }),
    ]
    const { rows: out } = aggregateByAction(rows, HEADERS)
    expect(out[0].action_duration).toBe(450)
  })

  it('computes action_duration as MAX(WIDGET_RENDER_TIMESTAMP) − ACTION_TIMESTAMP', () => {
    // The latest-rendering widget in the action decides the duration: the span
    // from ACTION_TIMESTAMP to that widget's render timestamp, in ms. DURATION
    // is ignored on this path.
    const headers = [...HEADERS, 'WIDGET_RENDER_TIMESTAMP']
    const rows = [
      row({ WIDGET_ID: 'w1', ACTION_TIMESTAMP: '2026-07-01 10:00:00.000', WIDGET_RENDER_TIMESTAMP: '2026-07-01 10:00:00.500', DURATION: 999 }),
      row({ WIDGET_ID: 'w2', ACTION_TIMESTAMP: '2026-07-01 10:00:00.000', WIDGET_RENDER_TIMESTAMP: '2026-07-01 10:00:02.000', DURATION: 999 }),
      row({ WIDGET_ID: 'w3', ACTION_TIMESTAMP: '2026-07-01 10:00:00.000', WIDGET_RENDER_TIMESTAMP: '2026-07-01 10:00:01.000', DURATION: 999 }),
    ]
    const { rows: out, mapping } = aggregateByAction(rows, headers)
    expect(mapping.renderTimestamp).toBe('WIDGET_RENDER_TIMESTAMP')
    expect(out).toHaveLength(1)
    expect(out[0].action_duration).toBe(2000) // 10:00:02.000 − 10:00:00.000
  })

  it('leaves action_duration blank when the render timestamp is present but unparseable', () => {
    const headers = [...HEADERS, 'WIDGET_RENDER_TIMESTAMP']
    const rows = [
      row({ ACTION_TIMESTAMP: '2026-07-01 10:00:00.000', WIDGET_RENDER_TIMESTAMP: 'ttfb' }),
    ]
    const { rows: out } = aggregateByAction(rows, headers)
    expect(out[0].action_duration).toBe('')
  })

  it('leaves action_duration blank when there is no DURATION column', () => {
    const headers = HEADERS.filter((h) => h !== 'DURATION')
    const rows = [row({ USER_ACTION: 'A' })].map((r) => { delete r.DURATION; return r })
    const { rows: out, mapping } = aggregateByAction(rows, headers)
    expect(mapping.duration).toBe('')
    expect(out[0].action_duration).toBe('')
  })
})
