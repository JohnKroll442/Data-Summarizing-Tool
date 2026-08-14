import { describe, it, expect } from 'vitest'
import { buildTimeOfDayHourScatterOption } from '../timeOfDayHourScatter'
import { SAP_DANGER } from '../../../../lib/chartColors'

const T0 = new Date(2026, 6, 8, 9, 15).getTime()
const inst = (over = {}) => ({
  actionKey: 'Open story::2026-07-08 09:15:00.000000000',
  action: 'Open story',
  story: 'Sales',
  user: 'alice',
  timestamp: '2026-07-08 09:15:00.000000000',
  duration: 3400,
  t: T0,
  flagged: false,
  ...over,
})

const seriesByName = (opt) => Object.fromEntries(opt.series.map((s) => [s.name, s]))

describe('buildTimeOfDayHourScatterOption — empty', () => {
  it('renders an empty-state when the bucket has no instances', () => {
    const opt = buildTimeOfDayHourScatterOption({ instances: [], bucketLabel: '7/8' })
    const withData = (opt.series ?? []).filter((s) => Array.isArray(s.data) && s.data.length)
    expect(withData).toHaveLength(0)
  })
})

describe('buildTimeOfDayHourScatterOption — axes & points', () => {
  const t1 = T0
  const t2 = T0 + 25 * 60 * 1000
  const opt = buildTimeOfDayHourScatterOption({
    instances: [inst({ t: t1, duration: 2000 }), inst({ t: t2, duration: 9000, flagged: true })],
    bucketLabel: '7/8',
  })

  it('plots real time on X and duration on a log Y', () => {
    expect(opt.xAxis.type).toBe('time')
    expect(opt.yAxis.type).toBe('log')
  })

  it('places each instance at [timestamp, duration]', () => {
    const all = opt.series.flatMap((s) => s.data)
    const coords = all.map((d) => d.value)
    expect(coords).toContainEqual([t1, 2000])
    expect(coords).toContainEqual([t2, 9000])
  })
})

describe('buildTimeOfDayHourScatterOption — color key by action type', () => {
  const opt = buildTimeOfDayHourScatterOption({
    instances: [
      inst({ action: 'Open story', t: T0, duration: 2000 }),
      inst({ action: 'Refresh', t: T0 + 60000, duration: 3000 }),
      inst({ action: 'Open story', t: T0 + 120000, duration: 9000, flagged: true }),
    ],
    bucketLabel: '7/8',
  })
  const s = seriesByName(opt)

  it('gives each action type its own colored circle series', () => {
    expect(s['Open story'].type).toBe('scatter')
    expect(s['Open story'].symbol).toBe('circle')
    expect(s['Refresh'].symbol).toBe('circle')
    expect(s['Open story'].itemStyle.color).not.toBe(s['Refresh'].itemStyle.color)
  })

  it('keeps flagged instances as a red-triangle series, not double-plotted by type', () => {
    expect(s.Flagged.symbol).toBe('triangle')
    expect(s.Flagged.itemStyle.color).toBe(SAP_DANGER)
    expect(s.Flagged.data).toHaveLength(1)
    // the flagged "Open story" run is NOT also in the Open story color series
    expect(s['Open story'].data).toHaveLength(1)
  })

  it('lists every action type plus Flagged in the legend', () => {
    expect(opt.legend.data).toEqual(['Open story', 'Refresh', 'Flagged'])
  })

  it('omits the Flagged legend entry when nothing is flagged', () => {
    const clean = buildTimeOfDayHourScatterOption({
      instances: [inst({ action: 'Open story' }), inst({ action: 'Refresh' })],
      bucketLabel: '7/8',
    })
    expect(clean.legend.data).toEqual(['Open story', 'Refresh'])
  })
})

describe('buildTimeOfDayHourScatterOption — tooltip', () => {
  it('shows action, story and duration for a dot', () => {
    const opt = buildTimeOfDayHourScatterOption({
      instances: [inst({ action: 'Open story', story: 'Sales', duration: 3400 })],
      bucketLabel: '7/8',
    })
    const html = opt.tooltip.formatter({ data: { action: 'Open story', story: 'Sales', duration: 3400, t: T0 } })
    expect(html).toContain('Open story')
    expect(html).toContain('Sales')
    // formatted duration, not the raw ms
    expect(html).not.toContain('3400')
  })
})
