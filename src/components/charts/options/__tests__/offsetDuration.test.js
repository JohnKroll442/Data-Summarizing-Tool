import { describe, it, expect } from 'vitest'
import { buildOffsetDurationOption, OFFSET_CLASS_LEGEND } from '../offsetDuration'

const pt = (over = {}) => ({
  actionKey: 'A::t',
  action: 'Open story',
  story: 'Sales',
  user: 'alice',
  timestamp: '2026-07-01 10:00:00.000',
  duration: 10000,
  maxOffset: 500,
  klass: 'ok',
  ...over,
})

const seriesByName = (opt) => Object.fromEntries(opt.series.map((s) => [s.name, s]))

describe('OFFSET_CLASS_LEGEND', () => {
  it('names the three classes in loud→quiet order with distinct colors', () => {
    expect(OFFSET_CLASS_LEGEND.map((c) => c.klass)).toEqual(['overrun', 'large', 'ok'])
    const colors = OFFSET_CLASS_LEGEND.map((c) => c.color)
    expect(new Set(colors).size).toBe(3)
  })
})

describe('buildOffsetDurationOption — empty', () => {
  it('renders an empty-state (no data series) when there are no points', () => {
    const opt = buildOffsetDurationOption({ points: [], largeOffsetMs: Infinity })
    const withData = (opt.series ?? []).filter((s) => Array.isArray(s.data) && s.data.length)
    expect(withData).toHaveLength(0)
  })
})

describe('buildOffsetDurationOption — axes & reference line', () => {
  const opt = buildOffsetDurationOption({
    points: [pt({ duration: 200, maxOffset: 40 }), pt({ duration: 240000, maxOffset: 30000, actionKey: 'B::t' })],
    largeOffsetMs: 100000,
  })

  it('uses log scales on both axes', () => {
    expect(opt.xAxis.type).toBe('log')
    expect(opt.yAxis.type).toBe('log')
  })

  it('includes an offset = duration diagonal reference line spanning the range', () => {
    const line = opt.series.find((s) => s.type === 'line')
    expect(line).toBeTruthy()
    expect(line.data).toHaveLength(2)
    // A y = x diagonal: both endpoints have equal x and y.
    for (const [x, y] of line.data) expect(x).toBe(y)
    // Non-interactive backdrop line.
    expect(line.silent).toBe(true)
  })
})

describe('buildOffsetDurationOption — class routing & marks', () => {
  const points = [
    pt({ klass: 'ok', maxOffset: 100 }),
    pt({ klass: 'large', maxOffset: 9000, actionKey: 'L::t' }),
    pt({ klass: 'overrun', duration: 1000, maxOffset: 3000, actionKey: 'O::t' }),
  ]
  const opt = buildOffsetDurationOption({ points, largeOffsetMs: 8000 })
  const s = seriesByName(opt)

  it('splits points into Healthy / Large offset / Overrun scatter series', () => {
    expect(s.Healthy.data).toHaveLength(1)
    expect(s['Large offset'].data).toHaveLength(1)
    expect(s.Overrun.data).toHaveLength(1)
  })

  it('draws overruns as a distinct triangle marker (shape, not color alone)', () => {
    expect(s.Overrun.symbol).toBe('triangle')
  })

  it('colors each class with its legend color', () => {
    const byKlass = Object.fromEntries(OFFSET_CLASS_LEGEND.map((c) => [c.klass, c.color]))
    expect(s.Overrun.itemStyle.color).toBe(byKlass.overrun)
    expect(s['Large offset'].itemStyle.color).toBe(byKlass.large)
    expect(s.Healthy.itemStyle.color).toBe(byKlass.ok)
  })

  it('plots [duration, maxOffset] and carries the point for the tooltip', () => {
    const d = s.Overrun.data[0]
    expect(d.value[0]).toBe(1000)  // x = duration
    expect(d.value[1]).toBe(3000)  // y = max offset
    expect(d.action).toBe('Open story')
  })

  it('exposes a legend for the classes', () => {
    expect(opt.legend).toBeTruthy()
  })
})
