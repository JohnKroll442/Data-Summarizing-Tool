import { describe, it, expect } from 'vitest'
import { buildOffsetDurationPoints, classifyOffsetPoint } from '../anomalyDetect'

// Same full-shape headers the detector understands.
const HEADERS = [
  'USER_NAME', 'USER_ACTION', 'ACTION_TIMESTAMP', 'ACTION_TIMESTAMP_END',
  'WIDGET_ID', 'WIDGET_MEASURE', 'WIDGET_SUBMEASURE', 'DURATION',
  'WIDGET_RENDER_TIMESTAMP_START', 'WIDGET_RENDER_TIMESTAMP', 'STORY_NAME',
]

// A widget row. Duration comes from ACTION_TIMESTAMP_END − ACTION_TIMESTAMP
// (the detector's preferred source), decoupled from the DURATION column so
// offset rows never contaminate the action duration.
const START = new Date(2026, 6, 1, 10, 0, 0, 0)
const pad = (n, w = 2) => String(n).padStart(w, '0')
const fmtTs = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
const START_TS = fmtTs(START)
const endTs = (ms) => fmtTs(new Date(START.getTime() + ms))

const row = (over = {}) => ({
  USER_NAME: 'APAC_alice',
  USER_ACTION: 'Open story',
  ACTION_TIMESTAMP: START_TS,
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

// One action instance: duration set via the end timestamp, plus any number of
// offset widget rows (whose max becomes the action's max widget offset).
const action = ({ name = 'Open story', ts = START_TS, durationMs, offsets = [], story = 'Sales', user = 'APAC_alice' }) => {
  const end = endTs(durationMs)
  const common = { USER_ACTION: name, ACTION_TIMESTAMP: ts, ACTION_TIMESTAMP_END: end, STORY_NAME: story, USER_NAME: user }
  const rows = [row({ ...common, WIDGET_MEASURE: 'render', DURATION: 100 })]
  for (const o of offsets) {
    rows.push(row({ ...common, WIDGET_MEASURE: 'offset', DURATION: o }))
  }
  return rows
}

describe('classifyOffsetPoint', () => {
  it('flags overrun when the offset exceeds the duration', () => {
    expect(classifyOffsetPoint(2000, 1000, 5000)).toBe('overrun')
  })

  it('flags large when offset is within duration but ≥ the terminal band edge', () => {
    expect(classifyOffsetPoint(6000, 8000, 5000)).toBe('large')
    // exactly at the edge is still large
    expect(classifyOffsetPoint(5000, 8000, 5000)).toBe('large')
  })

  it('flags ok when the offset is below the band edge and within duration', () => {
    expect(classifyOffsetPoint(1000, 8000, 5000)).toBe('ok')
  })

  it('prefers overrun over large when both would apply', () => {
    // offset > duration AND ≥ band edge → overrun wins
    expect(classifyOffsetPoint(9000, 8000, 5000)).toBe('overrun')
  })
})

describe('buildOffsetDurationPoints — shape & filtering', () => {
  it('returns an empty structure on empty input', () => {
    const r = buildOffsetDurationPoints([], HEADERS)
    expect(r.points).toEqual([])
    expect(r.counts).toEqual({ ok: 0, large: 0, overrun: 0 })
  })

  it('emits one point per action with duration + max widget offset', () => {
    const rows = action({ durationMs: 10000, offsets: [200, 900, 400] })
    const { points } = buildOffsetDurationPoints(rows, HEADERS)
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({
      action: 'Open story',
      story: 'Sales',
      duration: 10000,
      maxOffset: 900, // MAX across widget offsets, not sum
    })
  })

  it('drops actions with no finite widget offset (nothing to plot on Y)', () => {
    const rows = action({ durationMs: 10000, offsets: [] })
    expect(buildOffsetDurationPoints(rows, HEADERS).points).toHaveLength(0)
  })

  it('drops actions with a non-positive / missing duration', () => {
    const rows = action({ durationMs: 0, offsets: [100] })
    expect(buildOffsetDurationPoints(rows, HEADERS).points).toHaveLength(0)
  })

  it('classifies an overrun (offset > duration) regardless of band edges', () => {
    const rows = action({ durationMs: 1000, offsets: [2000] })
    const { points, counts } = buildOffsetDurationPoints(rows, HEADERS)
    expect(points[0].klass).toBe('overrun')
    expect(counts.overrun).toBe(1)
  })

  it('classifies a healthy action with a tiny offset as ok', () => {
    const rows = action({ durationMs: 120000, offsets: [50] })
    const { points } = buildOffsetDurationPoints(rows, HEADERS)
    expect(points[0].klass).toBe('ok')
  })

  it('tallies counts across a mix of actions', () => {
    const rows = [
      ...action({ name: 'A', durationMs: 1000, offsets: [3000] }),   // overrun
      ...action({ name: 'B', durationMs: 120000, offsets: [40] }),   // ok
    ]
    const { counts, points } = buildOffsetDurationPoints(rows, HEADERS)
    expect(points).toHaveLength(2)
    expect(counts.overrun).toBe(1)
    expect(counts.ok).toBe(1)
  })
})
