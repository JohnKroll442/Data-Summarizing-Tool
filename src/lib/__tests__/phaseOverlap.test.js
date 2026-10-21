import { describe, it, expect } from 'vitest'
import { buildPhaseOverlap } from '../phaseOverlap'

// Raw-row shape the detector understands. Starts/ends use the app's
// "YYYY-MM-DD HH:mm:ss.fff" timestamp format.
const HEADERS = [
  'USER_ACTION', 'ACTION_TIMESTAMP', 'WIDGET_ID', 'WIDGET_NAME',
  'WIDGET_MEASURE', 'WIDGET_SUBMEASURE', 'DURATION',
  'WIDGET_RENDER_TIMESTAMP_START', 'WIDGET_RENDER_TIMESTAMP',
  'WIDGET_TIMESTAMP_START', 'WIDGET_TIMESTAMP',
]

const ts = (sec, ms = 0) =>
  `2026-03-01 10:00:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`

// Build a render row and a network(ttfb) row for one widget in one action.
function widget({ action = 'Open', atime = ts(0), id = 'w1', name = 'Chart',
                  renderStart, renderEnd, netStart, netEnd }) {
  return [
    {
      USER_ACTION: action, ACTION_TIMESTAMP: atime, WIDGET_ID: id, WIDGET_NAME: name,
      WIDGET_MEASURE: 'render', WIDGET_SUBMEASURE: '', DURATION: 100,
      WIDGET_RENDER_TIMESTAMP_START: renderStart, WIDGET_RENDER_TIMESTAMP: renderEnd,
      WIDGET_TIMESTAMP_START: '', WIDGET_TIMESTAMP: '',
    },
    {
      USER_ACTION: action, ACTION_TIMESTAMP: atime, WIDGET_ID: id, WIDGET_NAME: name,
      WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'ttfb', DURATION: 80,
      WIDGET_RENDER_TIMESTAMP_START: '', WIDGET_RENDER_TIMESTAMP: '',
      WIDGET_TIMESTAMP_START: netStart, WIDGET_TIMESTAMP: netEnd,
    },
  ]
}

describe('buildPhaseOverlap', () => {
  it('returns empty for no rows / no headers', () => {
    expect(buildPhaseOverlap([], HEADERS).widgets_checked).toBe(0)
    expect(buildPhaseOverlap([{}], []).widgets_checked).toBe(0)
    expect(buildPhaseOverlap(null, HEADERS).parallel_widgets).toBe(0)
  })

  it('classifies a nested widget (network entirely inside render) as parallel', () => {
    // render [00.000, 05.000], network [01.000, 04.000] → nested
    const rows = widget({
      renderStart: ts(0), renderEnd: ts(5),
      netStart: ts(1), netEnd: ts(4),
    })
    const r = buildPhaseOverlap(rows, HEADERS)
    expect(r.widgets_checked).toBe(1)
    expect(r.parallel_widgets).toBe(1)
    expect(r.sequential_widgets).toBe(0)
    expect(r.relationship_counts.nested).toBe(1)
    expect(r.pct_parallel).toBe(100)
    expect(r.parallel_examples[0]).toMatchObject({ relationship: 'nested', overlap_ms: 3000 })
  })

  it('classifies partially overlapping windows as parallel/partial_overlap', () => {
    // render [00, 03], network [02, 05] → overlap [02,03] = 1000ms, neither contains the other
    const rows = widget({
      renderStart: ts(0), renderEnd: ts(3),
      netStart: ts(2), netEnd: ts(5),
    })
    const r = buildPhaseOverlap(rows, HEADERS)
    expect(r.parallel_widgets).toBe(1)
    expect(r.relationship_counts.partial_overlap).toBe(1)
    expect(r.relationship_counts.nested).toBe(0)
    expect(r.parallel_examples[0].overlap_ms).toBe(1000)
  })

  it('classifies non-overlapping windows as sequential and measures the gap', () => {
    // render [00, 02], network [03, 05] → no overlap, gap 1000ms
    const rows = widget({
      renderStart: ts(0), renderEnd: ts(2),
      netStart: ts(3), netEnd: ts(5),
    })
    const r = buildPhaseOverlap(rows, HEADERS)
    expect(r.parallel_widgets).toBe(0)
    expect(r.sequential_widgets).toBe(1)
    expect(r.relationship_counts.sequential).toBe(1)
    expect(r.sequential_examples[0].gap_ms).toBe(1000)
  })

  it('flags network starting before render as an inverted start', () => {
    // network [00, 04], render [01, 05] → overlap exists but network starts first
    const rows = widget({
      renderStart: ts(1), renderEnd: ts(5),
      netStart: ts(0), netEnd: ts(4),
    })
    const r = buildPhaseOverlap(rows, HEADERS)
    expect(r.inverted_start).toBe(1)
    expect(r.parallel_widgets).toBe(1) // windows still overlap
  })

  it('skips widgets lacking a parseable render or network window', () => {
    const rows = widget({
      renderStart: ts(0), renderEnd: ts(5),
      netStart: 'ttfb', netEnd: 'ttfb', // non-timestamp sentinel
    })
    const r = buildPhaseOverlap(rows, HEADERS)
    expect(r.widgets_checked).toBe(0)
  })

  it('aggregates across widgets/actions and sorts examples by overlap desc', () => {
    const rows = [
      ...widget({ action: 'A', atime: ts(0), id: 'w1', name: 'Small',
                  renderStart: ts(0), renderEnd: ts(5), netStart: ts(1), netEnd: ts(2) }), // overlap 1000
      ...widget({ action: 'B', atime: ts(10), id: 'w2', name: 'Big',
                  renderStart: ts(10), renderEnd: ts(20), netStart: ts(11), netEnd: ts(19) }), // overlap 8000
    ]
    const r = buildPhaseOverlap(rows, HEADERS)
    expect(r.widgets_checked).toBe(2)
    expect(r.parallel_widgets).toBe(2)
    expect(r.max_overlap_ms).toBe(8000)
    expect(r.avg_overlap_ms).toBe(4500) // (1000 + 8000) / 2
    expect(r.parallel_examples.map((e) => e.widget_name)).toEqual(['Big', 'Small'])
  })
})
