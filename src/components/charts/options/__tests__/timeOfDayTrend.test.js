import { describe, it, expect } from 'vitest'
import { buildTimeOfDayTrendOption } from '../timeOfDayTrend'

// A chronological bucket: compact axis label + verbose tooltip label.
const bkt = (over = {}) => ({
  key: '2026-07-08',
  label: '7/8',
  fullLabel: 'Jul 8, 2026',
  sort: new Date(2026, 6, 8).getTime(),
  p50: 3400,
  p90: 35100,
  ratio: 35100 / 3400,
  count: 192,
  instances: [],
  ...over,
})
const emptyBkt = (over = {}) =>
  bkt({ count: 0, p50: null, p90: null, ratio: null, ...over })

const seriesByName = (opt) => Object.fromEntries(opt.series.map((s) => [s.name, s]))

describe('buildTimeOfDayTrendOption — empty', () => {
  it('renders an empty-state (no data series) when there are no buckets', () => {
    const opt = buildTimeOfDayTrendOption({ buckets: [] })
    const withData = (opt.series ?? []).filter((s) => Array.isArray(s.data) && s.data.length)
    expect(withData).toHaveLength(0)
  })
})

describe('buildTimeOfDayTrendOption — chronological axis labels', () => {
  it('uses the buckets compact labels for the X axis', () => {
    const opt = buildTimeOfDayTrendOption({
      buckets: [
        bkt({ key: 'a', label: '7/8' }),
        bkt({ key: 'b', label: '7/9' }),
      ],
    })
    expect(opt.xAxis.data).toEqual(['7/8', '7/9'])
  })

  it('carries whatever granularity label the data layer produced (e.g. hourly)', () => {
    const opt = buildTimeOfDayTrendOption({
      buckets: [bkt({ label: '7/8 09:00' }), bkt({ key: 'b', label: '7/8 10:00' })],
    })
    expect(opt.xAxis.data).toEqual(['7/8 09:00', '7/8 10:00'])
  })
})

describe('buildTimeOfDayTrendOption — series', () => {
  const opt = buildTimeOfDayTrendOption({
    buckets: [bkt(), emptyBkt({ key: 'b', label: '7/9', fullLabel: 'Jul 9, 2026' })],
  })
  const s = seriesByName(opt)

  it('plots p50 and p90 as lines with dots on the duration (left) axis', () => {
    expect(s.p50.type).toBe('line')
    expect(s.p90.type).toBe('line')
    expect(s.p50.yAxisIndex ?? 0).toBe(0)
    expect(s.p90.yAxisIndex ?? 0).toBe(0)
    expect(s.p50.data).toEqual([3400, null])
    expect(s.p90.data).toEqual([35100, null])
  })

  it('draws faint action-count bars on a secondary (right) axis', () => {
    expect(s.Actions.type).toBe('bar')
    expect(s.Actions.yAxisIndex).toBe(1)
    expect(s.Actions.data).toEqual([192, 0])
    expect(opt.yAxis).toHaveLength(2)
  })

  it('adds a full-column markArea click target for each populated bucket, keyed by index', () => {
    // Lets a click anywhere in a bucket's column drill in (not just the thin line
    // / short bar), without disturbing the bar layout. Only the populated bucket
    // gets a band; each band carries its bucket index in `name` for the panel.
    const hit = s['hit-area']
    expect(hit.type).toBe('line')
    expect(hit.markArea.data).toEqual([[{ name: '0', xAxis: '7/8' }, { xAxis: '7/8' }]])
    expect(hit.markArea.itemStyle.color).toBe('transparent')
    expect(hit.markArea.silent).toBe(false)
    // Not toggleable via the legend, so the target survives any series being hidden.
    expect(opt.legend.data).not.toContain('hit-area')
  })

  it('fills a shaded spread band between p50 and p90', () => {
    expect(s.Spread.areaStyle).toBeTruthy()
    expect(s.Spread.stack).toBeTruthy()
    const base = opt.series.find((x) => x.stack === s.Spread.stack && x !== s.Spread)
    expect(base).toBeTruthy()
    // Band top = p90 − p50 stacked over a p50 base → reaches p90.
    expect(base.data).toEqual([3400, null])
    expect(s.Spread.data).toEqual([35100 - 3400, null])
  })

  it('only lists the four meaningful series in the legend (base band hidden)', () => {
    expect(new Set(opt.legend.data)).toEqual(new Set(['Actions', 'p50', 'p90', 'Spread']))
  })

  it('keeps both spread band series silent so they never swallow a drill-down click', () => {
    expect(s.Spread.silent).toBe(true)
    const base = opt.series.find((x) => x.stack === s.Spread.stack && x !== s.Spread)
    expect(base.silent).toBe(true)
  })
})

describe('buildTimeOfDayTrendOption — tooltip', () => {
  const opt = buildTimeOfDayTrendOption({
    buckets: [bkt(), emptyBkt({ key: 'b', label: '7/9', fullLabel: 'Jul 9, 2026' })],
  })

  it('shows the verbose bucket label plus p50, p90, ratio and count for a populated bucket', () => {
    const html = opt.tooltip.formatter([{ dataIndex: 0 }])
    expect(html).toContain('Jul 8, 2026') // verbose fullLabel, not the compact axis label
    expect(html).toContain('p50')
    expect(html).toContain('p90')
    expect(html).toContain('ratio')
    expect(html).toContain('×')
    expect(html).toContain('192')
  })

  it('shows a no-actions note for an empty bucket', () => {
    const html = opt.tooltip.formatter([{ dataIndex: 1 }])
    expect(html).toContain('Jul 9, 2026')
    expect(html.toLowerCase()).toContain('no actions')
  })
})
