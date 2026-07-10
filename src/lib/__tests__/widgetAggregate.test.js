import { describe, it, expect } from 'vitest'
import { aggregateByWidget } from '../widgetAggregate'

const HEADERS = [
  'WIDGET_ID', 'WIDGET_NAME', 'WIDGET_MEASURE', 'DURATION',
  'WIDGET_RENDER_TIMESTAMP_START', 'WIDGET_RENDER_TIMESTAMP',
  'WIDGET_TIMESTAMP_START', 'WIDGET_TIMESTAMP',
  'TIMESTAMP',
]

const row = (over = {}) => ({
  WIDGET_ID: 'w1',
  WIDGET_NAME: 'Bar chart',
  WIDGET_MEASURE: 'render',
  DURATION: 100,
  WIDGET_RENDER_TIMESTAMP_START: '',
  WIDGET_RENDER_TIMESTAMP: '',
  WIDGET_TIMESTAMP_START: '',
  WIDGET_TIMESTAMP: '',
  TIMESTAMP: '',
  ...over,
})

describe('aggregateByWidget', () => {
  it('returns empty rows on empty input', () => {
    const r1 = aggregateByWidget([], HEADERS)
    const r2 = aggregateByWidget(null, HEADERS)
    expect(r1.rows).toEqual([])
    expect(r1.phaseMax).toBe(0)
    expect(r2.rows).toEqual([])
  })

  it('returns empty rows when no widget id column can be detected', () => {
    const result = aggregateByWidget([{ FOO: 'x' }], ['FOO'])
    expect(result.rows).toEqual([])
    expect(result.mapping.widgetId).toBe('')
  })

  it('takes max duration per phase per widget', () => {
    const rows = [
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'render',  DURATION: 100 }),
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'render',  DURATION: 250 }),
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'network', DURATION: 400 }),
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'backend', DURATION: 30  }),
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'offset',  DURATION: 10  }),
    ]
    const { rows: out } = aggregateByWidget(rows, HEADERS)
    expect(out).toHaveLength(1)
    expect(out[0].render).toBe(250)
    expect(out[0].network).toBe(400)
    expect(out[0].backend).toBe(30)
    expect(out[0].offset).toBe(10)
  })

  it('phaseMax equals the largest single-phase duration across all widgets', () => {
    const rows = [
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'render',  DURATION: 100 }),
      row({ WIDGET_ID: 'w2', WIDGET_MEASURE: 'network', DURATION: 800 }),
      row({ WIDGET_ID: 'w2', WIDGET_MEASURE: 'backend', DURATION: 40  }),
    ]
    const { phaseMax } = aggregateByWidget(rows, HEADERS)
    expect(phaseMax).toBe(800)
  })

  it('pulls render start/end from the row that won the render max', () => {
    const rows = [
      row({ WIDGET_MEASURE: 'render', DURATION: 100,
            WIDGET_RENDER_TIMESTAMP_START: 'a-start', WIDGET_RENDER_TIMESTAMP: 'a-end' }),
      row({ WIDGET_MEASURE: 'render', DURATION: 500,
            WIDGET_RENDER_TIMESTAMP_START: 'winner-start', WIDGET_RENDER_TIMESTAMP: 'winner-end' }),
      row({ WIDGET_MEASURE: 'render', DURATION: 300,
            WIDGET_RENDER_TIMESTAMP_START: 'b-start', WIDGET_RENDER_TIMESTAMP: 'b-end' }),
    ]
    const { rows: out } = aggregateByWidget(rows, HEADERS)
    expect(out[0].render).toBe(500)
    expect(out[0].render_start).toBe('winner-start')
    expect(out[0].render_end).toBe('winner-end')
  })

  it('network/backend timestamps come from WIDGET_TIMESTAMP_START/WIDGET_TIMESTAMP', () => {
    const rows = [
      row({ WIDGET_MEASURE: 'network', DURATION: 400,
            WIDGET_TIMESTAMP_START: 'n-start', WIDGET_TIMESTAMP: 'n-end' }),
      row({ WIDGET_MEASURE: 'backend', DURATION: 30,
            WIDGET_TIMESTAMP_START: 'b-start', WIDGET_TIMESTAMP: 'b-end' }),
    ]
    const { rows: out } = aggregateByWidget(rows, HEADERS)
    expect(out[0].network_start).toBe('n-start')
    expect(out[0].network_end).toBe('n-end')
    expect(out[0].backend_start).toBe('b-start')
    expect(out[0].backend_end).toBe('b-end')
  })

  it('synthesizes render start from TIMESTAMP − DURATION when no dedicated column exists', () => {
    const headers = ['WIDGET_ID', 'WIDGET_MEASURE', 'DURATION', 'TIMESTAMP']
    const end = '2024-01-01T00:00:01.000Z'
    const rows = [{
      WIDGET_ID: 'w1',
      WIDGET_MEASURE: 'render',
      DURATION: 1000,
      TIMESTAMP: end,
    }]
    const { rows: out } = aggregateByWidget(rows, headers)
    expect(out[0].render_end).toBe(end)
    expect(out[0].render_start).toBe('2024-01-01T00:00:00.000Z')
  })

  it('skips rows with empty widget ids', () => {
    const rows = [
      row({ WIDGET_ID: '' }),
      row({ WIDGET_ID: null }),
      row({ WIDGET_ID: 'w1' }),
    ]
    const { rows: out } = aggregateByWidget(rows, HEADERS)
    expect(out).toHaveLength(1)
    expect(out[0].widget_id).toBe('w1')
  })

  it('falls back to WIDGET_TYPE when no WIDGET_NAME column exists', () => {
    const headers = ['WIDGET_ID', 'WIDGET_TYPE', 'WIDGET_MEASURE', 'DURATION']
    const rows = [{ WIDGET_ID: 'w1', WIDGET_TYPE: 'Chart', WIDGET_MEASURE: 'render', DURATION: 100 }]
    const { rows: out, mapping } = aggregateByWidget(rows, headers)
    expect(mapping.widgetName).toBe('WIDGET_TYPE')
    expect(out[0].widget_name).toBe('Chart')
  })

  it('empty phase values are left blank, not zero', () => {
    const rows = [row({ WIDGET_MEASURE: 'render', DURATION: 100 })]
    const { rows: out } = aggregateByWidget(rows, HEADERS)
    expect(out[0].network).toBe('')
    expect(out[0].backend).toBe('')
    expect(out[0].offset).toBe('')
  })

  it('groups distinct widget ids into separate rows', () => {
    const rows = [
      row({ WIDGET_ID: 'w1', DURATION: 100 }),
      row({ WIDGET_ID: 'w2', DURATION: 200 }),
      row({ WIDGET_ID: 'w1', DURATION: 50 }),
    ]
    const { rows: out } = aggregateByWidget(rows, HEADERS)
    expect(out.map((r) => r.widget_id).sort()).toEqual(['w1', 'w2'])
  })

  it('surfaces session_id from SESSION_ID when the column is populated', () => {
    const headers = [...HEADERS, 'SESSION_ID']
    const rows = [
      row({ WIDGET_ID: 'w1', SESSION_ID: 's-42' }),
      row({ WIDGET_ID: 'w1', SESSION_ID: 's-42' }),
    ]
    const { rows: out, mapping } = aggregateByWidget(rows, headers)
    expect(mapping.session).toBe('SESSION_ID')
    expect(out[0].session_id).toBe('s-42')
  })

  it('falls back to BROWSERSESSION_ID when SESSION_ID is empty', () => {
    const headers = [...HEADERS, 'SESSION_ID', 'BROWSERSESSION_ID']
    const rows = [
      row({ WIDGET_ID: 'w1', SESSION_ID: '', BROWSERSESSION_ID: 'bs-1' }),
      row({ WIDGET_ID: 'w1', SESSION_ID: '', BROWSERSESSION_ID: 'bs-1' }),
    ]
    const { rows: out, mapping } = aggregateByWidget(rows, headers)
    expect(mapping.session).toBe('BROWSERSESSION_ID')
    expect(out[0].session_id).toBe('bs-1')
  })

  it('leaves session_id blank when no session column exists', () => {
    const rows = [row({ WIDGET_ID: 'w1' })]
    const { rows: out, mapping } = aggregateByWidget(rows, HEADERS)
    expect(mapping.session).toBe('')
    expect(out[0].session_id).toBe('')
  })

  it('surfaces action_name from USER_ACTION when the column is present', () => {
    const headers = [...HEADERS, 'USER_ACTION']
    const rows = [
      row({ WIDGET_ID: 'w1', USER_ACTION: 'Open story' }),
      row({ WIDGET_ID: 'w1', USER_ACTION: 'Open story' }),
    ]
    const { rows: out, mapping } = aggregateByWidget(rows, headers)
    expect(mapping.actionName).toBe('USER_ACTION')
    expect(out[0].action_name).toBe('Open story')
  })

  it('leaves action_name blank when no action column exists', () => {
    const rows = [row({ WIDGET_ID: 'w1' })]
    const { rows: out, mapping } = aggregateByWidget(rows, HEADERS)
    expect(mapping.actionName).toBe('')
    expect(out[0].action_name).toBe('')
  })
})
