import { describe, it, expect } from 'vitest'
import {
  buildActionSequenceOption,
  PHASE_COLORS,
  PHASE_LEGEND,
  phaseGroupOf,
} from '../actionSequence'

// One widget with an offset, a backend, a network-wait, and a render row.
const sampleRows = [
  { WIDGET_ID: 'w1', WIDGET_NAME: 'Widget A', WIDGET_MEASURE: 'offset',  WIDGET_SUBMEASURE: '', DURATION: 100 },
  { WIDGET_ID: 'w1', WIDGET_NAME: 'Widget A', WIDGET_MEASURE: 'backend', WIDGET_SUBMEASURE: '', DURATION: 200 },
  { WIDGET_ID: 'w1', WIDGET_NAME: 'Widget A', WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'waiting', DURATION: 150 },
  { WIDGET_ID: 'w1', WIDGET_NAME: 'Widget A', WIDGET_MEASURE: 'render',  WIDGET_SUBMEASURE: '', DURATION: 300 },
]

describe('phaseGroupOf', () => {
  it('maps base phase keys to their own group', () => {
    expect(phaseGroupOf('offset')).toBe('offset')
    expect(phaseGroupOf('backend')).toBe('backend')
    expect(phaseGroupOf('render')).toBe('render')
  })

  it('collapses every network sub-phase into the network group', () => {
    expect(phaseGroupOf('network-full')).toBe('network')
    expect(phaseGroupOf('network-wait')).toBe('network')
    expect(phaseGroupOf('network-cdn')).toBe('network')
  })
})

describe('PHASE_LEGEND', () => {
  it('has the four screenshot categories with matching colors', () => {
    expect(PHASE_LEGEND.map((p) => p.key)).toEqual([
      'offset',
      'backend',
      'network',
      'render',
    ])
    expect(PHASE_LEGEND.map((p) => p.label)).toEqual([
      'Offset',
      'Backend',
      'Network wait',
      'Render',
    ])
    for (const entry of PHASE_LEGEND) {
      expect(entry.color).toBe(PHASE_COLORS[entry.key])
    }
  })
})

describe('buildActionSequenceOption phase coloring', () => {
  it('colors each bar by its phase group and drops the Local/Remote legend', () => {
    const opt = buildActionSequenceOption(sampleRows)
    // No built-in ECharts legend anymore — the header owns the legend.
    expect(opt.legend).toBeUndefined()
    // No invisible Local/Remote marker series.
    const seriesNames = opt.series.map((s) => s.name)
    expect(seriesNames).not.toContain('Local')
    expect(seriesNames).not.toContain('Remote')
    expect(seriesNames).toContain('duration')

    const duration = opt.series.find((s) => s.name === 'duration')
    const colors = duration.data.map((d) => d.itemStyle.color)
    // All four phase colors present among the bars.
    expect(colors).toContain(PHASE_COLORS.offset)
    expect(colors).toContain(PHASE_COLORS.backend)
    expect(colors).toContain(PHASE_COLORS.network)
    expect(colors).toContain(PHASE_COLORS.render)
    // Bars carry their phase group.
    const groups = duration.data.map((d) => d.phaseGroup).sort()
    expect(groups).toEqual(['backend', 'network', 'offset', 'render'])
  })
})
