import { describe, it, expect } from 'vitest'
import { buildAgentPayload } from '../buildAgentPayload'

// Per-phase timestamp field names that must NEVER appear in widget_summary.
// Keeping them there is the ~730k-token payload-bloat path (priority #4).
const TS_FIELDS = [
  'render_start', 'render_end',
  'network_start', 'network_end',
  'backend_start', 'backend_end',
]

const LEAN_KEYS = [
  'widget_id', 'widget_name',
  'render_ms', 'network_ms', 'backend_ms', 'offset_ms', 'total_ms',
].sort()

describe('buildAgentPayload — widget_summary lean contract (priority #4)', () => {
  // aggregateByWidget() rows carry per-phase start/end timestamps. Feed rows that
  // DO include them, to prove the payload builder strips them out of
  // widget_summary rather than propagating them to the LLM.
  const widgetAggRows = Array.from({ length: 5 }, (_, i) => ({
    widget_id: `w${i}`, widget_name: `Widget ${i}`,
    render: 500 - i, network: 80, backend: 50, offset: 10, total: 640 - i,
    render_start: '2026-03-01 10:00:00.000000000',
    render_end: '2026-03-01 10:00:05.000000000',
    network_start: '2026-03-01 10:00:00.000000000',
    network_end: '2026-03-01 10:00:04.900000000',
    backend_start: '2026-03-01 10:00:00.000000000',
    backend_end: '2026-03-01 10:00:04.800000000',
  }))

  const payload = buildAgentPayload({ aggRows: [], widgetAggRows })

  it('exposes every widget_summary row with ONLY the lean duration keys', () => {
    const ws = payload.widget_summary
    const rows = [
      ...ws.top_by_render, ...ws.top_by_network,
      ...ws.top_by_backend, ...ws.top_by_total,
    ]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(LEAN_KEYS)
      for (const f of TS_FIELDS) expect(row).not.toHaveProperty(f)
    }
  })

  it('never serializes a per-phase timestamp field name inside widget_summary', () => {
    const json = JSON.stringify(payload.widget_summary)
    for (const f of TS_FIELDS) expect(json).not.toContain(f)
  })

  it('keeps the compute-and-inject blocks present but bounded', () => {
    // timestamp_integrity and phase_overlap are where per-phase timestamps are
    // allowed — but only as capped summaries, never the full widget set.
    expect(payload).toHaveProperty('timestamp_integrity')
    expect(payload).toHaveProperty('phase_overlap')
    expect(payload.timestamp_integrity.worst_offenders.length).toBeLessThanOrEqual(15)
    expect(payload.phase_overlap.parallel_examples.length).toBeLessThanOrEqual(12)
    expect(payload.phase_overlap.sequential_examples.length).toBeLessThanOrEqual(12)
  })
})
