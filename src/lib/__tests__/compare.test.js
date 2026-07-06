import { describe, it, expect } from 'vitest'
import { compareKpis, compareEntities } from '../compare'

const SESSION_HEADERS = ['SESSION_ID', 'USER_NAME', 'STORY_NAME', 'DURATION']
const ACTION_HEADERS = [
  'USER_NAME', 'USER_ACTION', 'ACTION_TIMESTAMP',
  'WIDGET_ID', 'WIDGET_MEASURE', 'DURATION',
]
const WIDGET_HEADERS = ['WIDGET_ID', 'WIDGET_NAME', 'WIDGET_MEASURE', 'DURATION']

const sessionRow = (over) => ({
  SESSION_ID: 's1', USER_NAME: 'alice', STORY_NAME: 'A', DURATION: 100,
  ...over,
})

const actionRow = (over) => ({
  USER_NAME: 'alice',
  USER_ACTION: 'Open story',
  ACTION_TIMESTAMP: 't1',
  WIDGET_ID: 'w1',
  WIDGET_MEASURE: 'render',
  DURATION: 100,
  ...over,
})

const widgetRow = (over) => ({
  WIDGET_ID: 'w1',
  WIDGET_NAME: 'Bar',
  WIDGET_MEASURE: 'render',
  DURATION: 100,
  ...over,
})

const payload = (rows, headers) => ({ rows, headers })

/* ——— compareKpis ——— */

describe('compareKpis', () => {
  it('produces the expected session KPI labels', () => {
    const b = payload([sessionRow()], SESSION_HEADERS)
    const c = payload([sessionRow()], SESSION_HEADERS)
    const kpis = compareKpis('session', b, c)
    expect(kpis.map((k) => k.label)).toEqual([
      'Total sessions', 'Unique users',
      'Avg actions / session', 'Max session duration',
    ])
  })

  it('produces the expected action KPI labels', () => {
    const b = payload([actionRow()], ACTION_HEADERS)
    const c = payload([actionRow()], ACTION_HEADERS)
    const kpis = compareKpis('action', b, c)
    expect(kpis.map((k) => k.label)).toEqual([
      'Total actions', 'Unique names', 'Avg duration', 'Slowest action',
    ])
  })

  it('produces the expected widget KPI labels', () => {
    const b = payload([widgetRow()], WIDGET_HEADERS)
    const c = payload([widgetRow()], WIDGET_HEADERS)
    const kpis = compareKpis('widget', b, c)
    expect(kpis.map((k) => k.label)).toEqual([
      'Total widgets', 'Avg render time', 'Avg network time', 'Avg backend time',
    ])
  })

  it('returns em-dash for both sides when input has no rows', () => {
    const empty = payload([], SESSION_HEADERS)
    const kpis = compareKpis('session', empty, empty)
    for (const k of kpis) {
      expect(k.baseline).toBe('—')
      expect(k.current).toBe('—')
      expect(k.direction).toBe('flat')
      expect(k.delta).toBeNull()
    }
  })

  it('marks direction "up" when the change exceeds the flat threshold', () => {
    const b = payload([sessionRow({ SESSION_ID: 's1' })], SESSION_HEADERS)
    // Two sessions in current — that's a 100% jump vs. baseline of 1.
    const c = payload([sessionRow({ SESSION_ID: 's1' }), sessionRow({ SESSION_ID: 's2' })], SESSION_HEADERS)
    const kpi = compareKpis('session', b, c).find((k) => k.label === 'Total sessions')
    expect(kpi.direction).toBe('up')
    expect(kpi.delta).toBe(1)
  })

  it('marks direction "flat" when the change is below 0.5%', () => {
    const b = payload([sessionRow({ DURATION: 1000 })], SESSION_HEADERS)
    // 1000 -> 1001 = 0.1% change, below FLAT_THRESHOLD_PCT (0.5)
    const c = payload([sessionRow({ DURATION: 1001 })], SESSION_HEADERS)
    const kpi = compareKpis('session', b, c).find((k) => k.label === 'Max session duration')
    expect(kpi.direction).toBe('flat')
  })

  it('deltaPct is null when baseline is 0 but direction still reflects sign', () => {
    // Widgets with no render rows -> avgRender = null on baseline; use a
    // controllable numeric via action total instead.
    // Simpler: session avg-actions with 0 vs 1 (baseline 0 sessions -> null,
    // not zero). Use action deltas with a synthetic zero-duration action.
    const b = payload([actionRow({ DURATION: 0 })], ACTION_HEADERS)
    const c = payload([actionRow({ DURATION: 100 })], ACTION_HEADERS)
    const kpi = compareKpis('action', b, c).find((k) => k.label === 'Avg duration')
    expect(kpi.deltaPct).toBeNull()
    expect(kpi.direction).toBe('up')
  })

  it('reports missing side as em-dash when one payload lacks the column', () => {
    const b = payload([{ FOO: 'x' }], ['FOO'])
    const c = payload([sessionRow()], SESSION_HEADERS)
    const kpi = compareKpis('session', b, c).find((k) => k.label === 'Total sessions')
    expect(kpi.baseline).toBe('—')
    expect(kpi.current).not.toBe('—')
    expect(kpi.direction).toBe('flat')
  })
})

/* ——— compareEntities: session (single-key join) ——— */

describe('compareEntities — session', () => {
  it('categorizes matched, dropped, and new sessions', () => {
    const b = payload([
      sessionRow({ SESSION_ID: 's1', DURATION: 100 }),
      sessionRow({ SESSION_ID: 's2', DURATION: 200 }),
    ], SESSION_HEADERS)
    const c = payload([
      sessionRow({ SESSION_ID: 's1', DURATION: 150 }),
      sessionRow({ SESSION_ID: 's3', DURATION: 300 }),
    ], SESSION_HEADERS)
    const { matched, newInCurrent, droppedFromBaseline } = compareEntities('session', b, c)
    expect(matched.map((m) => m.key).sort()).toEqual(['s1'])
    expect(newInCurrent.map((n) => n.key).sort()).toEqual(['s3'])
    expect(droppedFromBaseline.map((d) => d.key).sort()).toEqual(['s2'])
  })

  it('computes delta and deltaPct for matched sessions', () => {
    const b = payload([sessionRow({ SESSION_ID: 's1', DURATION: 100 })], SESSION_HEADERS)
    const c = payload([sessionRow({ SESSION_ID: 's1', DURATION: 150 })], SESSION_HEADERS)
    const { matched } = compareEntities('session', b, c)
    expect(matched[0].delta).toBe(50)
    expect(matched[0].deltaPct).toBe(50)
  })

  it('deltaPct is null when baseline value is 0', () => {
    const b = payload([sessionRow({ SESSION_ID: 's1', DURATION: 0 })], SESSION_HEADERS)
    const c = payload([sessionRow({ SESSION_ID: 's1', DURATION: 100 })], SESSION_HEADERS)
    const { matched } = compareEntities('session', b, c)
    expect(matched[0].deltaPct).toBeNull()
    expect(matched[0].delta).toBe(100)
  })
})

/* ——— compareEntities: action (two-pass join) ——— */

describe('compareEntities — action', () => {
  it('first pass matches by (name, user) when both have a user', () => {
    const b = payload([
      actionRow({ USER_ACTION: 'Save', USER_NAME: 'alice', DURATION: 100 }),
      actionRow({ USER_ACTION: 'Save', USER_NAME: 'bob',   DURATION: 200, ACTION_TIMESTAMP: 't2' }),
    ], ACTION_HEADERS)
    const c = payload([
      actionRow({ USER_ACTION: 'Save', USER_NAME: 'bob',   DURATION: 220, ACTION_TIMESTAMP: 't2' }),
      actionRow({ USER_ACTION: 'Save', USER_NAME: 'alice', DURATION: 110 }),
    ], ACTION_HEADERS)
    const { matched } = compareEntities('action', b, c)
    // Both must match on (Save, alice) and (Save, bob), not cross-wired.
    const aliceMatch = matched.find((m) => m.name === 'Save' && m.baseline === 100)
    const bobMatch = matched.find((m) => m.name === 'Save' && m.baseline === 200)
    expect(aliceMatch.current).toBe(110)
    expect(bobMatch.current).toBe(220)
  })

  it('second pass falls back to name-only matching for remaining entries', () => {
    // Baseline has no user; current has user -> falls to name-only pass.
    const b = payload([
      actionRow({ USER_ACTION: 'Save', USER_NAME: '', DURATION: 100 }),
    ], ACTION_HEADERS)
    const c = payload([
      actionRow({ USER_ACTION: 'Save', USER_NAME: 'alice', DURATION: 150 }),
    ], ACTION_HEADERS)
    const { matched, newInCurrent, droppedFromBaseline } = compareEntities('action', b, c)
    expect(matched).toHaveLength(1)
    expect(matched[0].baseline).toBe(100)
    expect(matched[0].current).toBe(150)
    expect(newInCurrent).toEqual([])
    expect(droppedFromBaseline).toEqual([])
  })

  it('does not double-match: a used current entry cannot pair again', () => {
    // Baseline: two distinct entries (A, alice) and (A, bob).
    // Current: only one entry (A, alice) with 150.
    // First pass matches (A, alice) -> (A, alice). Second pass would try to
    // pair (A, bob) with a name-only match against 'A' in current — but the
    // only 'A' in current is already used, so (A, bob) must be dropped.
    const b = payload([
      actionRow({ USER_ACTION: 'X', USER_NAME: 'alice', DURATION: 100, ACTION_TIMESTAMP: 't1' }),
      actionRow({ USER_ACTION: 'X', USER_NAME: 'bob',   DURATION: 200, ACTION_TIMESTAMP: 't2' }),
    ], ACTION_HEADERS)
    const c = payload([
      actionRow({ USER_ACTION: 'X', USER_NAME: 'alice', DURATION: 150, ACTION_TIMESTAMP: 't3' }),
    ], ACTION_HEADERS)
    const { matched, droppedFromBaseline } = compareEntities('action', b, c)
    expect(matched).toHaveLength(1)
    expect(matched[0].baseline).toBe(100)
    expect(matched[0].current).toBe(150)
    expect(droppedFromBaseline).toHaveLength(1)
  })
})

/* ——— compareEntities: widget (three-tier fallback) ——— */

describe('compareEntities — widget', () => {
  it('prefers (widgetName, widgetId) exact-pair matching', () => {
    const b = payload([
      widgetRow({ WIDGET_ID: 'w1', WIDGET_NAME: 'Bar', DURATION: 100 }),
    ], WIDGET_HEADERS)
    const c = payload([
      widgetRow({ WIDGET_ID: 'w1', WIDGET_NAME: 'Bar', DURATION: 150 }),
      widgetRow({ WIDGET_ID: 'w2', WIDGET_NAME: 'Bar', DURATION: 999 }),
    ], WIDGET_HEADERS)
    const { matched } = compareEntities('widget', b, c)
    // Should match against (Bar, w1) — not the other Bar with w2.
    const barW1 = matched.find((m) => m.baseline === 100)
    expect(barW1.current).toBe(150)
  })

  it('falls back to widgetId-only when names diverge', () => {
    const b = payload([
      widgetRow({ WIDGET_ID: 'w1', WIDGET_NAME: '', DURATION: 100 }),
    ], WIDGET_HEADERS)
    const c = payload([
      widgetRow({ WIDGET_ID: 'w1', WIDGET_NAME: '', DURATION: 200 }),
    ], WIDGET_HEADERS)
    const { matched } = compareEntities('widget', b, c)
    expect(matched).toHaveLength(1)
    expect(matched[0].baseline).toBe(100)
    expect(matched[0].current).toBe(200)
  })

  it('separates matched, new, and dropped widgets', () => {
    const b = payload([
      widgetRow({ WIDGET_ID: 'w1', WIDGET_NAME: 'A', DURATION: 100 }),
      widgetRow({ WIDGET_ID: 'w2', WIDGET_NAME: 'B', DURATION: 200 }),
    ], WIDGET_HEADERS)
    const c = payload([
      widgetRow({ WIDGET_ID: 'w1', WIDGET_NAME: 'A', DURATION: 150 }),
      widgetRow({ WIDGET_ID: 'w3', WIDGET_NAME: 'C', DURATION: 300 }),
    ], WIDGET_HEADERS)
    const { matched, newInCurrent, droppedFromBaseline } = compareEntities('widget', b, c)
    expect(matched).toHaveLength(1)
    expect(newInCurrent).toHaveLength(1)
    expect(droppedFromBaseline).toHaveLength(1)
  })
})
