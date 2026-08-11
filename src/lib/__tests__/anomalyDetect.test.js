import { describe, it, expect } from 'vitest'
import {
  detectAnomalies,
  summarizeActionFlags,
  rankAnomalyTiers,
  ANOMALY_TYPES,
  SLOW_ACTION_MS,
} from '../anomalyDetect'

// Full-shape headers: action name + timestamps, widget id/measure/submeasure,
// duration, render start/end, story. Individual tests override cells; columns
// they don't exercise stay blank so unrelated rules don't fire.
const HEADERS = [
  'USER_NAME', 'USER_ACTION', 'ACTION_TIMESTAMP', 'ACTION_TIMESTAMP_END',
  'WIDGET_ID', 'WIDGET_MEASURE', 'WIDGET_SUBMEASURE', 'DURATION',
  'WIDGET_RENDER_TIMESTAMP_START', 'WIDGET_RENDER_TIMESTAMP', 'STORY_NAME',
]

const T0 = '2026-07-01 10:00:00.000'

const row = (over = {}) => ({
  USER_NAME: 'APAC_alice',
  USER_ACTION: 'Open story',
  ACTION_TIMESTAMP: T0,
  ACTION_TIMESTAMP_END: '',
  WIDGET_ID: 'w1',
  WIDGET_MEASURE: 'render',
  WIDGET_SUBMEASURE: '',
  DURATION: 100,
  WIDGET_RENDER_TIMESTAMP_START: '',
  WIDGET_RENDER_TIMESTAMP: '',
  STORY_NAME: 'Sales',
  ...over,
})

// The flags for the default action key, or the sole finding's flag types.
const flagsFor = (result, name = 'Open story', ts = T0) =>
  result.byActionKey.get(`${name}::${ts}`) ?? []
const typesOf = (flags) => flags.map((f) => f.type)

describe('ANOMALY_TYPES config', () => {
  it('has ten types, unique keys, valid tiers', () => {
    expect(ANOMALY_TYPES).toHaveLength(10)
    const keys = ANOMALY_TYPES.map((t) => t.key)
    expect(new Set(keys).size).toBe(10)
    for (const t of ANOMALY_TYPES) {
      expect(['performance', 'data']).toContain(t.tier)
      expect(typeof t.label).toBe('string')
      expect(typeof t.icon).toBe('string')
      expect(typeof t.description).toBe('string')
    }
  })

  it('is all-performance, with the three phase flags in a "phase" subgroup', () => {
    const perf = ANOMALY_TYPES.filter((t) => t.tier === 'performance').map((t) => t.key)
    const data = ANOMALY_TYPES.filter((t) => t.tier === 'data').map((t) => t.key)
    expect(perf).toEqual(['slow_action', 'large_offset', 'straggler', 'frontend_bound', 'network_bound', 'backend_bound', 'fragmented', 'offset_overrun', 'negative_phase', 'component_overrun'])
    expect(data).toEqual([])
    const phase = ANOMALY_TYPES.filter((t) => t.subgroup === 'phase').map((t) => t.key)
    expect(phase).toEqual(['frontend_bound', 'network_bound', 'backend_bound'])
  })
})

describe('detectAnomalies — empty / missing columns', () => {
  it('returns empty structure on empty input', () => {
    const r = detectAnomalies([], HEADERS)
    expect(r.rows).toEqual([])
    expect(r.totalFlagged).toEqual({ actions: 0, pct: 0 })
    expect(r.byActionKey.size).toBe(0)
    for (const t of ANOMALY_TYPES) expect(r.counts[t.key]).toEqual({ actions: 0, pct: 0 })
  })

  it('returns empty rows when no action-name column can be detected', () => {
    const r = detectAnomalies([{ FOO: 'x' }], ['FOO'])
    expect(r.rows).toEqual([])
    expect(r.mapping.actionName).toBe('')
  })
})

describe('slow_action (≥ 2m end-to-end)', () => {
  it('flags an action whose END − START ≥ 2m', () => {
    const rows = [row({ ACTION_TIMESTAMP_END: '2026-07-01 10:02:05.000' })]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).toContain('slow_action')
    expect(r.rows[0].action_duration).toBe(125000)
  })

  it('does not flag an action just under 2m', () => {
    const rows = [row({ ACTION_TIMESTAMP_END: '2026-07-01 10:01:55.000' })]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).not.toContain('slow_action')
    expect(SLOW_ACTION_MS).toBe(120000)
  })
})

describe('large_offset (widget offset ≥ the terminal duration band)', () => {
  // A dataset containing a ≥2m action forces the terminal band to the 2m ceiling
  // (`>2m`, min = 120000), so the large_offset threshold is a known 120000.
  const anchor = row({ USER_ACTION: 'Anchor', ACTION_TIMESTAMP_END: '2026-07-01 10:02:05.000' })

  it('exposes the canonical bands the detector computed', () => {
    const r = detectAnomalies([anchor], HEADERS)
    expect(Array.isArray(r.bands)).toBe(true)
    expect(r.bands.length).toBeGreaterThan(0)
  })

  it('flags a widget whose offset ≥ the terminal band lower edge', () => {
    // A long (5m) action so the 130s offset stays under its duration (no
    // offset_overrun), but 130000 ≥ the 120000 terminal-band edge.
    const rows = [
      anchor,
      row({ USER_ACTION: 'Big', ACTION_TIMESTAMP_END: '2026-07-01 10:05:00.000', WIDGET_MEASURE: 'offset', DURATION: 130000 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(r.bands[r.bands.length - 1].min).toBe(120000)
    expect(typesOf(flagsFor(r, 'Big'))).toContain('large_offset')
    expect(typesOf(flagsFor(r, 'Big'))).not.toContain('offset_overrun')
  })

  it('does not flag a widget whose offset is below the terminal edge', () => {
    const rows = [
      anchor,
      row({ USER_ACTION: 'Small', ACTION_TIMESTAMP_END: '2026-07-01 10:05:00.000', WIDGET_MEASURE: 'offset', DURATION: 100000 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r, 'Small'))).not.toContain('large_offset')
  })
})

describe('straggler (a widget ≥ 5× the action median and ≥ 5s, ≥3 widgets)', () => {
  it('flags one widget far slower than its peers', () => {
    const rows = [
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 100 }),
      row({ WIDGET_ID: 'w2', WIDGET_MEASURE: 'render', DURATION: 100 }),
      row({ WIDGET_ID: 'w3', WIDGET_MEASURE: 'render', DURATION: 6000 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).toContain('straggler')
  })

  it('does not flag when the slowest is under 5× the median', () => {
    const rows = [
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 6000 }),
      row({ WIDGET_ID: 'w2', WIDGET_MEASURE: 'render', DURATION: 6000 }),
      row({ WIDGET_ID: 'w3', WIDGET_MEASURE: 'render', DURATION: 18000 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).not.toContain('straggler')
  })

  it('does not flag a big ratio when the slowest is still under 5s (absolute floor)', () => {
    const rows = [
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 100 }),
      row({ WIDGET_ID: 'w2', WIDGET_MEASURE: 'render', DURATION: 100 }),
      row({ WIDGET_ID: 'w3', WIDGET_MEASURE: 'render', DURATION: 1000 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).not.toContain('straggler')
  })

  it('does not flag with fewer than 3 widgets', () => {
    const rows = [
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 100 }),
      row({ WIDGET_ID: 'w2', WIDGET_MEASURE: 'render', DURATION: 6000 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).not.toContain('straggler')
  })
})

describe('phase attribution (*_bound, action ≥ 10s, phase > 50% of busy time)', () => {
  // A 15s action (via END − START) so the ≥10s attribution gate is open but the
  // 30s slow_action gate stays shut. One widget, no straggler peers → no
  // straggler noise, so the sole flag is the attribution one.
  const slow = { ACTION_TIMESTAMP_END: '2026-07-01 10:00:15.000' }

  it('flags frontend_bound when client render dominates busy time', () => {
    const rows = [
      row({ ...slow, WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 1000 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).toContain('frontend_bound')
  })

  it('flags backend_bound when backend dominates busy time', () => {
    const rows = [
      row({ ...slow, WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 1000 }),
      row({ ...slow, WIDGET_ID: 'w1', WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'ttfb', DURATION: 1000 }),
      row({ ...slow, WIDGET_ID: 'w1', WIDGET_MEASURE: 'backend', DURATION: 900 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).toContain('backend_bound')
  })

  it('flags network_bound when transport dominates busy time', () => {
    const rows = [
      row({ ...slow, WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 1000 }),
      row({ ...slow, WIDGET_ID: 'w1', WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'ttfb', DURATION: 900 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).toContain('network_bound')
  })

  it('attributes at most one phase, and none when the split is mixed', () => {
    // fe=500, ne=100, be=400 → no phase is a majority.
    const rows = [
      row({ ...slow, WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 1000 }),
      row({ ...slow, WIDGET_ID: 'w1', WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'ttfb', DURATION: 500 }),
      row({ ...slow, WIDGET_ID: 'w1', WIDGET_MEASURE: 'backend', DURATION: 400 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    const types = typesOf(flagsFor(r))
    expect(types).not.toContain('frontend_bound')
    expect(types).not.toContain('network_bound')
    expect(types).not.toContain('backend_bound')
  })

  it('does not attribute an action under 10s (gate)', () => {
    const rows = [
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:05.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 1000 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).not.toContain('frontend_bound')
  })
})

describe('fragmented (≥10s, ≥3 widgets, ≥50% wall-clock unexplained by slowest widget)', () => {
  it('flags an action whose wall-clock dwarfs its slowest single widget', () => {
    // 20s action, 3 widgets, slowest widget only 1s → 95% overhead.
    const slow = { ACTION_TIMESTAMP_END: '2026-07-01 10:00:20.000' }
    const rows = [
      row({ ...slow, WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 1000 }),
      row({ ...slow, WIDGET_ID: 'w2', WIDGET_MEASURE: 'render', DURATION: 900 }),
      row({ ...slow, WIDGET_ID: 'w3', WIDGET_MEASURE: 'render', DURATION: 800 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).toContain('fragmented')
  })

  it('does not flag when one widget explains most of the wall-clock', () => {
    // 20s action but the slowest widget ran ~18s → only ~10% overhead.
    const slow = { ACTION_TIMESTAMP_END: '2026-07-01 10:00:20.000' }
    const rows = [
      row({ ...slow, WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 18000 }),
      row({ ...slow, WIDGET_ID: 'w2', WIDGET_MEASURE: 'render', DURATION: 900 }),
      row({ ...slow, WIDGET_ID: 'w3', WIDGET_MEASURE: 'render', DURATION: 800 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).not.toContain('fragmented')
  })

  it('does not flag with fewer than 3 widgets', () => {
    const slow = { ACTION_TIMESTAMP_END: '2026-07-01 10:00:20.000' }
    const rows = [
      row({ ...slow, WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 1000 }),
      row({ ...slow, WIDGET_ID: 'w2', WIDGET_MEASURE: 'render', DURATION: 900 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).not.toContain('fragmented')
  })
})

describe('offset_overrun (a widget offset exceeds the whole action duration)', () => {
  it('flags an action whose max widget offset exceeds its duration', () => {
    // 5s action (END − START), one widget with an 8s offset → impossible.
    const rows = [
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:05.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'offset', DURATION: 8000 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).toContain('offset_overrun')
    expect(r.rows[0].flags.find((f) => f.type === 'offset_overrun').value).toBe(8000)
  })

  it('uses the MAX offset, not the sum (summed offsets over duration do not flag)', () => {
    // 6s action; two widgets each with a 4s offset → sum 8s > 6s, but max 4s < 6s.
    const rows = [
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:06.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'offset', DURATION: 4000 }),
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:06.000', WIDGET_ID: 'w2', WIDGET_MEASURE: 'offset', DURATION: 4000 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).not.toContain('offset_overrun')
  })

  it('flags on the single widget whose offset exceeds duration among peers', () => {
    // 5s action; one widget offset 8s (impossible), another a tame 0.1s.
    const rows = [
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:05.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'offset', DURATION: 8000 }),
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:05.000', WIDGET_ID: 'w2', WIDGET_MEASURE: 'offset', DURATION: 100 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).toContain('offset_overrun')
  })

  it('does not flag when the offset is within the duration', () => {
    const rows = [
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:20.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'offset', DURATION: 3000 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).not.toContain('offset_overrun')
  })

  it('does not flag an action with no offset rows', () => {
    const rows = [
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:05.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 8000 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).not.toContain('offset_overrun')
  })
})

describe('negative_phase (max exclusive phase < 0 across all widgets)', () => {
  it('flags when the max exclusive frontend (render − network) is negative', () => {
    // 5s action (no attribution/slow noise); one widget with network > render, so
    // its exclusive frontend slice is −200ms and — with only one widget — that IS
    // the max across the action.
    const rows = [
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:05.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 300 }),
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:05.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'ttfb', DURATION: 500 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).toContain('negative_phase')
    expect(flagsFor(r).find((f) => f.type === 'negative_phase').value).toBe(-200)
  })

  it('does not flag when only SOME widgets are negative but the max is positive', () => {
    // w1 is negative (render 300 < network 500 → −200) but w2 is strongly positive
    // (render 1000 − network 200 → 800). Max-based, so 800 > 0 → no flag.
    const rows = [
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:05.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 300 }),
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:05.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'ttfb', DURATION: 500 }),
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:05.000', WIDGET_ID: 'w2', WIDGET_MEASURE: 'render', DURATION: 1000 }),
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:05.000', WIDGET_ID: 'w2', WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'ttfb', DURATION: 200 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).not.toContain('negative_phase')
  })

  it('does not flag a well-ordered nesting (render ⊇ network ⊇ backend)', () => {
    const rows = [
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:05.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 1000 }),
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:05.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'ttfb', DURATION: 600 }),
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:05.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'backend', DURATION: 300 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).not.toContain('negative_phase')
  })
})

describe('component_overrun (a widget’s summed phases exceed the action duration)', () => {
  it('flags when a single widget’s phases total more than the whole action', () => {
    // 5s action but a widget whose render alone is 8s → its phases total 8s > 5s.
    const rows = [
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:05.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 8000 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).toContain('component_overrun')
    expect(flagsFor(r).find((f) => f.type === 'component_overrun').value).toBe(8000)
  })

  it('does not flag when the widget’s phases fit within the action duration', () => {
    const rows = [
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:05.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 3000 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).not.toContain('component_overrun')
  })
})

describe('aggregation across an action & the whole view', () => {
  it('collects multiple flags into one action, in ANOMALY_TYPES order', () => {
    const rows = [
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 1000, ACTION_TIMESTAMP_END: '2026-07-01 10:02:35.000' }),
      row({ WIDGET_ID: 'w1', WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'ttfb', DURATION: 900, ACTION_TIMESTAMP_END: '2026-07-01 10:02:35.000' }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    const flags = flagsFor(r)
    // 155s → slow_action; ≥10s + ttfb-dominated busy time → network_bound.
    expect(typesOf(flags)).toEqual(['slow_action', 'network_bound'])
    expect(flags.every((f) => f.tier === 'performance')).toBe(true)
  })

  it('computes per-type counts, percentages and the any-flag total', () => {
    const rows = [
      row({ USER_ACTION: 'A', ACTION_TIMESTAMP: '2026-07-01 10:00:00.000', ACTION_TIMESTAMP_END: '2026-07-01 10:02:35.000' }),
      row({ USER_ACTION: 'B', ACTION_TIMESTAMP: '2026-07-01 11:00:00.000', ACTION_TIMESTAMP_END: '2026-07-01 11:00:01.000' }),
      row({ USER_ACTION: 'C', ACTION_TIMESTAMP: '2026-07-01 12:00:00.000', ACTION_TIMESTAMP_END: '2026-07-01 12:00:01.000' }),
      row({ USER_ACTION: 'D', ACTION_TIMESTAMP: '2026-07-01 13:00:00.000', ACTION_TIMESTAMP_END: '2026-07-01 13:00:01.000' }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(r.totalActions).toBe(4)
    expect(r.counts.slow_action).toEqual({ actions: 1, pct: 0.25 })
    expect(r.totalFlagged).toEqual({ actions: 1, pct: 0.25 })
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].action_name).toBe('A')
  })

  it('excludes a phase-attribution-only action from the any-flag total', () => {
    // A 12s single-widget action dominated by frontend render fires only
    // frontend_bound. It's counted in the Frontend row but is NOT an anomaly, so
    // it stays out of the "any anomaly" union and the findings list.
    const rows = [
      row({ ACTION_TIMESTAMP_END: '2026-07-01 10:00:12.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 1000 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(typesOf(flagsFor(r))).toEqual(['frontend_bound'])
    expect(r.counts.frontend_bound.actions).toBe(1)
    expect(r.totalFlagged).toEqual({ actions: 0, pct: 0 })
    expect(r.rows).toEqual([]) // no headline flag → not a finding
  })

  it('sorts findings so the most-flagged actions surface first', () => {
    const rows = [
      // lighter: a 12s single-widget action → frontend_bound only (one flag)
      row({ USER_ACTION: 'Light', ACTION_TIMESTAMP: '2026-07-01 09:00:00.000', ACTION_TIMESTAMP_END: '2026-07-01 09:00:12.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 1000 }),
      // heavier: a 160s single-widget action → slow_action + frontend_bound
      row({ USER_ACTION: 'Heavy', ACTION_TIMESTAMP: '2026-07-01 10:00:00.000', ACTION_TIMESTAMP_END: '2026-07-01 10:02:40.000', WIDGET_ID: 'w1', WIDGET_MEASURE: 'render', DURATION: 1000 }),
    ]
    const r = detectAnomalies(rows, HEADERS)
    expect(r.rows[0].action_name).toBe('Heavy')
  })

  it('strips the user prefix on finding rows', () => {
    const rows = [row({ ACTION_TIMESTAMP_END: '2026-07-01 10:02:35.000' })]
    const r = detectAnomalies(rows, HEADERS)
    expect(r.rows[0].user).toBe('alice')
  })
})

describe('summarizeActionFlags — re-tally over a visible subset', () => {
  // One slow action (A), one clean action (B), one out-of-view action (C).
  const rows = [
    row({ USER_ACTION: 'A', ACTION_TIMESTAMP: '2026-07-01 10:00:00.000', ACTION_TIMESTAMP_END: '2026-07-01 10:02:35.000' }),
    row({ USER_ACTION: 'B', ACTION_TIMESTAMP: '2026-07-01 11:00:00.000', ACTION_TIMESTAMP_END: '2026-07-01 11:00:01.000' }),
    row({ USER_ACTION: 'C', ACTION_TIMESTAMP: '2026-07-01 12:00:00.000', ACTION_TIMESTAMP_END: '2026-07-01 12:02:40.000' }),
  ]
  const full = detectAnomalies(rows, HEADERS)

  it('narrows counts + denominator to the given keys', () => {
    // Visible = A (slow) + B (clean); C is filtered out of view.
    const keys = ['A::2026-07-01 10:00:00.000', 'B::2026-07-01 11:00:00.000']
    const s = summarizeActionFlags(keys, full.byActionKey)
    expect(s.totalActions).toBe(2)
    expect(s.counts.slow_action).toEqual({ actions: 1, pct: 0.5 })
    expect(s.totalFlagged).toEqual({ actions: 1, pct: 0.5 })
  })

  it('returns an all-zero summary for an empty visible set', () => {
    const s = summarizeActionFlags([], full.byActionKey)
    expect(s.totalActions).toBe(0)
    expect(s.totalFlagged).toEqual({ actions: 0, pct: 0 })
    for (const t of ANOMALY_TYPES) expect(s.counts[t.key]).toEqual({ actions: 0, pct: 0 })
  })

  it('excludes a phase-only action from the any-flag total', () => {
    // An action whose ONLY flag is a phase attribution is a lens on where its
    // time went, not an anomaly — so it counts in the phase row but NOT toward
    // the "any anomaly" union.
    const byActionKey = new Map([
      ['P::t', [{ type: 'frontend_bound', tier: 'performance', value: 60, detail: '' }]],
      ['B::t', []],
    ])
    const s = summarizeActionFlags(['P::t', 'B::t'], byActionKey)
    expect(s.totalActions).toBe(2)
    expect(s.totalFlagged).toEqual({ actions: 0, pct: 0 })
    expect(s.counts.frontend_bound).toEqual({ actions: 1, pct: 0.5 })
  })

  it('counts an action toward the total when it also carries a headline flag', () => {
    // slow_action (headline) + frontend_bound (phase) → the action is in the
    // union; the phase flag just adds context.
    const byActionKey = new Map([
      ['P::t', [
        { type: 'slow_action', tier: 'performance', value: 130000, detail: '' },
        { type: 'frontend_bound', tier: 'performance', value: 60, detail: '' },
      ]],
      ['B::t', []],
    ])
    const s = summarizeActionFlags(['P::t', 'B::t'], byActionKey)
    expect(s.totalFlagged).toEqual({ actions: 1, pct: 0.5 })
    expect(s.counts.slow_action).toEqual({ actions: 1, pct: 0.5 })
    expect(s.counts.frontend_bound).toEqual({ actions: 1, pct: 0.5 })
  })
})

describe('rankAnomalyTiers — T1/T2/T3 by prevalence', () => {
  // Build a counts object shaped like detectAnomalies / summarizeActionFlags:
  // any key given a pct is "present" (actions > 0); every other type is zeroed.
  const mkCounts = (byPct) => {
    const c = {}
    for (const t of ANOMALY_TYPES) c[t.key] = { actions: 0, pct: 0 }
    for (const [key, pct] of Object.entries(byPct)) {
      c[key] = { actions: Math.max(1, Math.round(pct * 100)), pct }
    }
    return c
  }

  it('returns an empty map for missing / all-zero counts', () => {
    expect(rankAnomalyTiers(null).size).toBe(0)
    expect(rankAnomalyTiers(undefined).size).toBe(0)
    expect(rankAnomalyTiers(mkCounts({})).size).toBe(0)
  })

  it('ranks the highest percentage T1, the middle T2, the lowest T3', () => {
    const tiers = rankAnomalyTiers(mkCounts({ slow_action: 0.6, fragmented: 0.3, straggler: 0.1 }))
    expect(tiers.get('slow_action')).toBe(1)
    expect(tiers.get('fragmented')).toBe(2)
    expect(tiers.get('straggler')).toBe(3)
  })

  it('only ranks types that flagged an action (zero-count types get no tier)', () => {
    const tiers = rankAnomalyTiers(mkCounts({ slow_action: 0.5, large_offset: 0.2 }))
    expect(tiers.has('straggler')).toBe(false) // absent → no badge
    expect(tiers.get('slow_action')).toBe(1)
  })

  it('gives equal percentages the same tier', () => {
    // Two types tie for the top share; the lower one falls to the next band.
    const tiers = rankAnomalyTiers(mkCounts({ slow_action: 0.4, large_offset: 0.4, straggler: 0.1 }))
    expect(tiers.get('slow_action')).toBe(1)
    expect(tiers.get('large_offset')).toBe(1)
    // Two DISTINCT percentages → the lower lands in T2 (floor(1*3/2)+1).
    expect(tiers.get('straggler')).toBe(2)
  })

  it('assigns T1 by percentage, not by ANOMALY_TYPES order', () => {
    // offset_overrun is LAST in the config but the most prevalent here → still T1.
    const tiers = rankAnomalyTiers(mkCounts({ slow_action: 0.1, offset_overrun: 0.9 }))
    expect(tiers.get('offset_overrun')).toBe(1)
    expect(tiers.get('slow_action')).toBe(2)
  })

  it('puts every present type in T1 when they all share one percentage', () => {
    const tiers = rankAnomalyTiers(mkCounts({ slow_action: 0.3, large_offset: 0.3 }))
    expect(tiers.get('slow_action')).toBe(1)
    expect(tiers.get('large_offset')).toBe(1)
  })

  it('never tiers the phase-attribution subcategory, even when it is most prevalent', () => {
    const tiers = rankAnomalyTiers(
      mkCounts({ frontend_bound: 0.9, network_bound: 0.5, backend_bound: 0.4, slow_action: 0.1 }),
    )
    expect(tiers.has('frontend_bound')).toBe(false)
    expect(tiers.has('network_bound')).toBe(false)
    expect(tiers.has('backend_bound')).toBe(false)
    // Only the headline type is ranked, so it's the sole (top) tier.
    expect(tiers.get('slow_action')).toBe(1)
  })
})
