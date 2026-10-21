import { describe, it, expect } from 'vitest'
import { buildTimestampIntegrity } from '../timestampIntegrity'

// Timestamps use the app's "YYYY-MM-DD HH:mm:ss.fff" shape (parseStrictTimestamp).
const t = (sec, ms = 0) =>
  `2026-03-01 10:00:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`

describe('buildTimestampIntegrity', () => {
  it('returns an empty summary for no rows', () => {
    const r = buildTimestampIntegrity([])
    expect(r.widgets_checked).toBe(0)
    expect(r.widgets_disordered).toBe(0)
    expect(r.worst_offenders).toEqual([])
  })

  it('returns an empty summary for null / non-array input', () => {
    expect(buildTimestampIntegrity(null).widgets_checked).toBe(0)
    expect(buildTimestampIntegrity(undefined).widgets_disordered).toBe(0)
  })

  it('counts a well-ordered widget as checked but not disordered', () => {
    // backend_end ≤ network_end ≤ render_end — the expected nesting.
    const rows = [{
      action_key: 'A::1', widget_id: 'w1', widget_name: 'Chart', session_id: 's1',
      backend_end:  t(1),
      network_end:  t(2),
      render_end:   t(3),
    }]
    const r = buildTimestampIntegrity(rows)
    expect(r.widgets_checked).toBe(1)
    expect(r.widgets_disordered).toBe(0)
    expect(r.pct_disordered).toBe(0)
  })

  it('flags network_end recorded after render_end and measures the overrun', () => {
    const rows = [{
      action_key: 'A::1', widget_id: 'w1', widget_name: 'Chart', session_id: 's1',
      backend_end:  t(1),
      render_end:   t(2),
      network_end:  t(2, 500), // 500ms after render end — the user's example
    }]
    const r = buildTimestampIntegrity(rows)
    expect(r.widgets_checked).toBe(1)
    expect(r.widgets_disordered).toBe(1)
    expect(r.by_violation.network_after_render.count).toBe(1)
    expect(r.by_violation.network_after_render.max_overrun_ms).toBe(500)
    expect(r.worst_offenders[0]).toMatchObject({
      widget_id: 'w1',
      violation: 'network_after_render',
      overrun_ms: 500,
    })
  })

  it('flags backend_end recorded after network_end', () => {
    const rows = [{
      action_key: 'A::1', widget_id: 'w2', widget_name: 'Table', session_id: 's1',
      render_end:  t(5),
      network_end: t(2),
      backend_end: t(3), // 1000ms after network end
    }]
    const r = buildTimestampIntegrity(rows)
    expect(r.widgets_disordered).toBe(1)
    expect(r.by_violation.backend_after_network.count).toBe(1)
    expect(r.by_violation.backend_after_network.max_overrun_ms).toBe(1000)
  })

  it('records both violations for one widget and ranks it by the worst overrun', () => {
    const rows = [{
      action_key: 'A::1', widget_id: 'w3', widget_name: 'Map', session_id: 's1',
      render_end:  t(1),
      network_end: t(2),        // 1000ms after render
      backend_end: t(4),        // 2000ms after network (worse)
    }]
    const r = buildTimestampIntegrity(rows)
    expect(r.widgets_disordered).toBe(1)
    expect(r.worst_offenders[0].all_violations).toEqual(
      expect.arrayContaining(['network_after_render', 'backend_after_network']),
    )
    expect(r.worst_offenders[0].violation).toBe('backend_after_network')
    expect(r.worst_offenders[0].overrun_ms).toBe(2000)
  })

  it('skips widgets whose end timestamps are missing or non-timestamp sentinels', () => {
    const rows = [
      { action_key: 'A::1', widget_id: 'w4', render_end: 'ttfb', network_end: 'ttfb', backend_end: '' },
      { action_key: 'A::1', widget_id: 'w5', render_end: t(3) }, // only one phase — nothing to compare
    ]
    const r = buildTimestampIntegrity(rows)
    expect(r.widgets_checked).toBe(0)
    expect(r.widgets_disordered).toBe(0)
  })

  it('computes avg overrun across multiple disordered widgets and sorts worst first', () => {
    const rows = [
      { action_key: 'A::1', widget_id: 'small', backend_end: t(1), render_end: t(2), network_end: t(2, 200) }, // +200
      { action_key: 'A::2', widget_id: 'big',   backend_end: t(1), render_end: t(2), network_end: t(4) },      // +2000
    ]
    const r = buildTimestampIntegrity(rows)
    expect(r.widgets_checked).toBe(2)
    expect(r.widgets_disordered).toBe(2)
    expect(r.pct_disordered).toBe(100)
    expect(r.by_violation.network_after_render.count).toBe(2)
    expect(r.by_violation.network_after_render.avg_overrun_ms).toBe(1100) // (200+2000)/2
    expect(r.by_violation.network_after_render.max_overrun_ms).toBe(2000)
    expect(r.worst_offenders.map((w) => w.widget_id)).toEqual(['big', 'small'])
  })

  it('caps worst_offenders at 15', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      action_key: `A::${i}`, widget_id: `w${i}`,
      backend_end: t(1), render_end: t(2), network_end: t(3),
    }))
    const r = buildTimestampIntegrity(rows)
    expect(r.widgets_disordered).toBe(20)
    expect(r.worst_offenders).toHaveLength(15)
  })
})
