import { describe, it, expect } from 'vitest'
import {
  enumerateBuckets,
  chooseGranularity,
  estimateBucketCount,
  sessionInterval,
  widgetInterval,
  actionPoint,
  listDimensionFields,
  dimensionOptions,
  buildActivityTimeline,
  MAX_BUCKETS,
} from '../activityTimeline'

describe('enumerateBuckets', () => {
  it('produces a contiguous day axis including empty gaps', () => {
    const min = new Date(2026, 6, 1, 10)
    const max = new Date(2026, 6, 3, 10) // 2 days later; nothing on Jul 2
    const { buckets, indexByKey } = enumerateBuckets(min, max, 'day')
    expect(buckets.map((b) => b.key)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03'])
    expect(indexByKey.get('2026-07-02')).toBe(1)
  })

  it('handles a single-bucket span', () => {
    const d = new Date(2026, 6, 1, 10)
    const { buckets } = enumerateBuckets(d, d, 'day')
    expect(buckets).toHaveLength(1)
  })

  it('never exceeds MAX_BUCKETS', () => {
    const min = new Date(2020, 0, 1)
    const max = new Date(2030, 0, 1)
    const { buckets } = enumerateBuckets(min, max, 'day')
    expect(buckets.length).toBeLessThanOrEqual(MAX_BUCKETS)
  })
})

describe('chooseGranularity', () => {
  it('picks the finest interval that fits the target', () => {
    const min = new Date(2026, 6, 1, 0, 0)
    const max = new Date(2026, 6, 1, 2, 0) // 2 hours → 121 one-minute buckets
    expect(estimateBucketCount(min, max, 'minute')).toBeGreaterThan(40)
    expect(chooseGranularity(min, max)).toBe('5min') // 25 buckets, fits
  })

  it('stays within MAX_BUCKETS for very long spans', () => {
    const min = new Date(2010, 0, 1)
    const max = new Date(2030, 0, 1)
    const g = chooseGranularity(min, max)
    expect(estimateBucketCount(min, max, g)).toBeLessThanOrEqual(MAX_BUCKETS)
  })
})

describe('interval / point extractors', () => {
  it('reads a session interval and swaps a reversed range', () => {
    const iv = sessionInterval({ timestamp_range: '2026-07-05 00:00:00', _timestamp_end: '2026-07-01 00:00:00' })
    expect(iv.start.getDate()).toBe(1)
    expect(iv.end.getDate()).toBe(5)
  })

  it('treats a session with no end as a point', () => {
    const iv = sessionInterval({ timestamp_range: '2026-07-01 10:00:00', _timestamp_end: '' })
    expect(iv.start.getTime()).toBe(iv.end.getTime())
  })

  it('returns null for an unparseable session start', () => {
    expect(sessionInterval({ timestamp_range: '', _timestamp_end: '' })).toBeNull()
  })

  it('spans a widget across its present phase timestamps, or a single point', () => {
    const iv = widgetInterval({
      render_start: '2026-07-01 10:00:00',
      render_end: '2026-07-01 10:00:05',
      network_end: '2026-07-01 10:00:09',
    })
    expect(iv.start.getSeconds()).toBe(0)
    expect(iv.end.getSeconds()).toBe(9)

    const point = widgetInterval({ render_start: '2026-07-01 10:00:00' })
    expect(point.start.getTime()).toBe(point.end.getTime())

    expect(widgetInterval({})).toBeNull()
  })

  it('reads an action point', () => {
    expect(actionPoint({ _action_timestamp: '2026-07-01 10:00:00' })).toBeInstanceOf(Date)
    expect(actionPoint({ _action_timestamp: '' })).toBeNull()
  })
})

/* ——— integration against the real aggregators ——— */

const HEADERS = [
  'SESSION_ID', 'USER_NAME', 'USER_ACTION', 'ACTION_TIMESTAMP',
  'WIDGET_ID', 'WIDGET_MEASURE', 'DURATION',
  'WIDGET_RENDER_TIMESTAMP_START', 'WIDGET_RENDER_TIMESTAMP',
]

// S1 (Alice): action A on Jul 1, action B on Jul 2 → session spans 2 days.
// S2 (Bob):   action C on Jul 1.
const ROWS = [
  { SESSION_ID: 'S1', USER_NAME: 'EMEA_Alice', USER_ACTION: 'A', ACTION_TIMESTAMP: '2026-07-01 10:00:00', WIDGET_ID: 'W1', WIDGET_MEASURE: 'render', DURATION: 100, WIDGET_RENDER_TIMESTAMP_START: '2026-07-01 10:00:00', WIDGET_RENDER_TIMESTAMP: '2026-07-01 10:00:01' },
  { SESSION_ID: 'S1', USER_NAME: 'EMEA_Alice', USER_ACTION: 'B', ACTION_TIMESTAMP: '2026-07-02 10:00:00', WIDGET_ID: 'W2', WIDGET_MEASURE: 'render', DURATION: 100, WIDGET_RENDER_TIMESTAMP_START: '2026-07-02 10:00:00', WIDGET_RENDER_TIMESTAMP: '2026-07-02 10:00:01' },
  { SESSION_ID: 'S2', USER_NAME: 'EMEA_Bob', USER_ACTION: 'C', ACTION_TIMESTAMP: '2026-07-01 12:00:00', WIDGET_ID: 'W3', WIDGET_MEASURE: 'render', DURATION: 100, WIDGET_RENDER_TIMESTAMP_START: '2026-07-01 12:00:00', WIDGET_RENDER_TIMESTAMP: '2026-07-01 12:00:01' },
]

describe('buildActivityTimeline', () => {
  it('counts sessions (overlap), actions (point) and widgets per day bucket', () => {
    const r = buildActivityTimeline(ROWS, HEADERS, { granularity: 'day' })
    expect(r.empty).toBe(false)
    expect(r.buckets.map((b) => b.key)).toEqual(['2026-07-01', '2026-07-02'])
    // S1 overlaps both days. S2 has a single timestamp (Jul 1), so its end is
    // filled with the file's latest timestamp (S1's Jul 2 action) → it now spans
    // both days too.
    expect(r.series.sessions).toEqual([2, 2])
    // A + C on Jul 1, B on Jul 2.
    expect(r.series.actions).toEqual([2, 1])
    // W1,W3 on Jul 1, W2 on Jul 2.
    expect(r.series.widgets).toEqual([2, 1])
    expect(r.totals).toEqual({ sessions: 2, actions: 3, widgets: 3 })
  })

  it('narrows all three counts when a dimension filter is applied', () => {
    const r = buildActivityTimeline(ROWS, HEADERS, {
      granularity: 'day',
      primaryFilter: { field: 'user', values: ['EMEA_Alice'] },
    })
    expect(r.totals).toEqual({ sessions: 1, actions: 2, widgets: 2 })
    expect(r.series.sessions).toEqual([1, 1])
  })

  it('coarsens an explicit interval that would pack in too many bars', () => {
    // 30-min over the ~1-day fixture span is ~49 buckets (> READABLE_TARGET),
    // so it coarsens to hour — the window is NOT shrunk.
    const r = buildActivityTimeline(ROWS, HEADERS, { interval: '30min' })
    expect(r.granularity).toBe('hour')
    expect(r.granularityClamped).toBe(false)
    expect(r.buckets.length).toBeLessThanOrEqual(800)
  })

  it('buckets a sub-window at 30-minute resolution when it fits', () => {
    // Zoom into Jul 1 10:00–13:00 (3h) → 7 half-hour buckets.
    const r = buildActivityTimeline(ROWS, HEADERS, {
      interval: '30min',
      range: { min: new Date(2026, 6, 1, 10, 0), max: new Date(2026, 6, 1, 13, 0) },
    })
    expect(r.granularity).toBe('30min')
    expect(r.buckets.length).toBe(7) // 10:00,10:30,…,13:00
    // Action A + widget W1 fall in the first half-hour bucket.
    expect(r.series.actions[0]).toBe(1)
    expect(r.series.widgets[0]).toBe(1)
  })

  it('returns an empty result when there are no rows', () => {
    expect(buildActivityTimeline([], HEADERS).empty).toBe(true)
  })
})

describe('dimension fields', () => {
  it('lists only fields whose column exists', () => {
    const ids = listDimensionFields(ROWS, HEADERS).map((f) => f.id)
    expect(ids).toContain('user')
    expect(ids).toContain('action')
    expect(ids).toContain('session')
    expect(ids).not.toContain('widget') // no WIDGET_NAME/TYPE column
  })

  it('lists distinct sorted raw option values', () => {
    expect(dimensionOptions(ROWS, 'USER_NAME')).toEqual(['EMEA_Alice', 'EMEA_Bob'])
  })
})
