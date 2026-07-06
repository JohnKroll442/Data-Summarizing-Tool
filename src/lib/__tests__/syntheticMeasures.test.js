import { describe, it, expect } from 'vitest'
import { augmentRowsWithSyntheticMeasures, SYNTHETIC_MEASURES } from '../syntheticMeasures'
import { sumByColumn } from '../chartData'

const HEADERS = ['WIDGET_ID', 'WIDGET_NAME', 'WIDGET_MEASURE', 'DURATION']

const row = (over = {}) => ({
  WIDGET_ID: 'w1',
  WIDGET_NAME: 'Bar chart',
  WIDGET_MEASURE: 'render',
  DURATION: 100,
  ...over,
})

describe('augmentRowsWithSyntheticMeasures', () => {
  it('appends the four synthetic columns to headers', () => {
    const { headers } = augmentRowsWithSyntheticMeasures([row()], HEADERS)
    for (const s of SYNTHETIC_MEASURES) {
      expect(headers).toContain(s.key)
    }
  })

  it('materializes DURATION on the matching phase and leaves the others blank', () => {
    const [r] = augmentRowsWithSyntheticMeasures([row({ WIDGET_MEASURE: 'render', DURATION: 42 })], HEADERS).rows
    expect(r['Total Render']).toBe(42)
    expect(r['Total Frontend']).toBe(42) // alias for render
    expect(r['Total Backend']).toBeUndefined()
    expect(r['Total Network']).toBeUndefined()
  })

  it('treats WIDGET_MEASURE=frontend as render (alias behavior)', () => {
    const [r] = augmentRowsWithSyntheticMeasures([row({ WIDGET_MEASURE: 'frontend', DURATION: 7 })], HEADERS).rows
    expect(r['Total Render']).toBe(7)
    expect(r['Total Frontend']).toBe(7)
  })

  it('matches network prefix so WIDGET_MEASURE=network_ttfb contributes to Total Network', () => {
    const [r] = augmentRowsWithSyntheticMeasures([row({ WIDGET_MEASURE: 'network_ttfb', DURATION: 15 })], HEADERS).rows
    expect(r['Total Network']).toBe(15)
    expect(r['Total Render']).toBeUndefined()
  })

  it('produces per-group totals when combined with sumByColumn', () => {
    const rows = [
      row({ WIDGET_NAME: 'A', WIDGET_MEASURE: 'backend', DURATION: 10 }),
      row({ WIDGET_NAME: 'A', WIDGET_MEASURE: 'backend', DURATION: 30 }),
      row({ WIDGET_NAME: 'A', WIDGET_MEASURE: 'render',  DURATION: 5 }),
      row({ WIDGET_NAME: 'B', WIDGET_MEASURE: 'backend', DURATION: 7 }),
      row({ WIDGET_NAME: 'B', WIDGET_MEASURE: 'network_ttfb', DURATION: 4 }),
    ]
    const { rows: augmented } = augmentRowsWithSyntheticMeasures(rows, HEADERS)
    const backendByWidget = sumByColumn(augmented, 'WIDGET_NAME', 'Total Backend')
    expect(backendByWidget).toEqual([
      { name: 'A', value: 40 },
      { name: 'B', value: 7 },
    ])
    const networkByWidget = sumByColumn(augmented, 'WIDGET_NAME', 'Total Network')
    expect(networkByWidget).toEqual([{ name: 'B', value: 4 }])
  })

  it('leaves rows/headers unchanged when measure or duration columns are missing', () => {
    const bareHeaders = ['FOO', 'BAR']
    const bareRows = [{ FOO: 'x', BAR: 1 }]
    const out = augmentRowsWithSyntheticMeasures(bareRows, bareHeaders)
    expect(out.headers).toEqual(bareHeaders)
    expect(out.rows).toBe(bareRows)
  })

  it('is a no-op on empty input', () => {
    const out = augmentRowsWithSyntheticMeasures([], HEADERS)
    expect(out.rows).toEqual([])
    expect(out.headers).toEqual(HEADERS)
  })
})
