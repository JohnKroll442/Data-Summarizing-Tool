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

  it('takes max duration per phase, then shows nested phases as exclusive time', () => {
    const rows = [
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'render',  DURATION: 100 }),
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'render',  DURATION: 250 }),
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'network', DURATION: 400 }),
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'backend', DURATION: 30  }),
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'offset',  DURATION: 10  }),
    ]
    const { rows: out } = aggregateByWidget(rows, HEADERS)
    expect(out).toHaveLength(1)
    // render(250) − network(400) = −150 (kept as-is), network(400) − backend(30)
    // = 370, backend stays 30, offset untouched.
    expect(out[0].render).toBe(-150)
    expect(out[0].network).toBe(370)
    expect(out[0].backend).toBe(30)
    expect(out[0].offset).toBe(10)
  })

  it('phaseMax equals the largest exclusive phase duration across all widgets', () => {
    const rows = [
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'render',  DURATION: 100 }),
      row({ WIDGET_ID: 'w2', WIDGET_MEASURE: 'network', DURATION: 800 }),
      row({ WIDGET_ID: 'w2', WIDGET_MEASURE: 'backend', DURATION: 40  }),
    ]
    const { phaseMax } = aggregateByWidget(rows, HEADERS)
    // w1 render (no network) = 100; w2 network(800) − backend(40) = 760.
    expect(phaseMax).toBe(760)
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

  // When a WIDGET_SUBMEASURE column exists, Network counts the ttfb round-trip
  // only — a larger 'waiting'/incomplete network sub-measure (which can span
  // the whole session) must not win, and its timestamps must not surface.
  it('picks the ttfb sub-measure for network when a submeasure column exists', () => {
    const headers = [...HEADERS, 'WIDGET_SUBMEASURE']
    const rows = [
      row({ WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'ttfb', DURATION: 300,
            WIDGET_TIMESTAMP_START: 'ttfb-start', WIDGET_TIMESTAMP: 'ttfb-end' }),
      row({ WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'waiting', DURATION: 900000,
            WIDGET_TIMESTAMP_START: 'wait-start', WIDGET_TIMESTAMP: 'wait-end' }),
    ]
    const { rows: out } = aggregateByWidget(rows, headers)
    expect(out[0].network).toBe(300)
    expect(out[0].network_start).toBe('ttfb-start')
    expect(out[0].network_end).toBe('ttfb-end')
  })

  it('network/backend timestamps come from WIDGET_TIMESTAMP_START/WIDGET_TIMESTAMP', () => {    const rows = [
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

  it('matches the exclusive-time example (2.1/1.7/1.5s → 0.4/0.2/1.5s)', () => {
    const rows = [
      row({ WIDGET_MEASURE: 'render',  DURATION: 2100 }),
      row({ WIDGET_MEASURE: 'network', DURATION: 1700 }),
      row({ WIDGET_MEASURE: 'backend', DURATION: 1500 }),
    ]
    const { rows: out } = aggregateByWidget(rows, HEADERS)
    expect(out[0].render).toBe(400)   // 2100 − 1700
    expect(out[0].network).toBe(200)  // 1700 − 1500
    expect(out[0].backend).toBe(1500) // innermost, unchanged
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
})
