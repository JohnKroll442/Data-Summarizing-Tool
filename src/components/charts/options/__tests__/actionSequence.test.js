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

// Two widgets that both wait the same offset (100ms) then do backend work.
// With the old global cursor, widget B's backend started after ALL of
// widget A's phases; with offset-anchoring it starts at its own offset, so
// the two backend bars share a startMs — the visible proof of parallelism.
const twoWidgetRows = [
  { WIDGET_ID: 'w1', WIDGET_NAME: 'A', WIDGET_MEASURE: 'offset',  WIDGET_SUBMEASURE: '', DURATION: 100 },
  { WIDGET_ID: 'w1', WIDGET_NAME: 'A', WIDGET_MEASURE: 'backend', WIDGET_SUBMEASURE: '', DURATION: 200 },
  { WIDGET_ID: 'w2', WIDGET_NAME: 'B', WIDGET_MEASURE: 'offset',  WIDGET_SUBMEASURE: '', DURATION: 100 },
  { WIDGET_ID: 'w2', WIDGET_NAME: 'B', WIDGET_MEASURE: 'backend', WIDGET_SUBMEASURE: '', DURATION: 500 },
]

describe('buildActionSequenceOption — parallel offset-anchored layout', () => {
  const opt = buildActionSequenceOption(twoWidgetRows)
  const duration = opt.series.find((s) => s.name === 'duration')
  // Data is stored reversed for top-down y-order; index by phaseLabel instead.
  const byLabel = Object.fromEntries(duration.data.map((d) => [d.phaseLabel, d]))

  it('anchors each widget backend at its own offset, so equal-offset widgets overlap', () => {
    // Both offsets are 100ms → both backends start at 100, not stacked.
    expect(byLabel['Query data of A'].startMs).toBe(100)
    expect(byLabel['Query data of B'].startMs).toBe(100)
  })

  it('cascades phases within a widget (offset then backend end-to-end)', () => {
    expect(byLabel['A — Offset'].startMs).toBe(0)
    expect(byLabel['A — Offset'].endMs).toBe(100)
    expect(byLabel['Query data of A'].startMs).toBe(100)
    expect(byLabel['Query data of A'].endMs).toBe(300)
  })
})

// Helper: pull the markLine label formatters (the text markers) off the option.
const markLabels = (opt) => {
  const duration = opt.series.find((s) => s.name === 'duration')
  return duration.markLine.data.map((d) => d.label?.formatter)
}

describe('buildActionSequenceOption — action end marker', () => {
  it('pins the end marker to the passed actionDurationMs, not the summed total', () => {
    // Summed phases = 100+200 (A) + 100+500 (B) reconstructed end = 600;
    // but the real action duration is 450. The marker must read 450.
    const opt = buildActionSequenceOption(twoWidgetRows, { actionDurationMs: 450 })
    const duration = opt.series.find((s) => s.name === 'duration')
    const endLine = duration.markLine.data.find(
      (d) => d.label?.formatter === 'Action End Timestamp'
    )
    expect(endLine).toBeTruthy()
    expect(endLine.xAxis).toBe(450)
  })

  it('labels the markers Action Start / Action End and drops Total Phase Timestamp', () => {
    const opt = buildActionSequenceOption(twoWidgetRows, { actionDurationMs: 450 })
    const labels = markLabels(opt)
    expect(labels).toContain('Action Start Timestamp')
    expect(labels).toContain('Action End Timestamp')
    expect(labels).not.toContain('Total Phase Timestamp')
  })

  it('sets the x-axis max to the end marker * 1.15 (bars are clamped to it)', () => {
    // Bars now never overshoot the Action End marker, so the axis is sized to
    // the marker (450), not the summed reconstructed end (600), plus a pad.
    const opt = buildActionSequenceOption(twoWidgetRows, { actionDurationMs: 450 })
    expect(opt.xAxis.max).toBeCloseTo(450 * 1.15, 5)
  })

  it('falls back to the reconstructed end when no actionDurationMs is given', () => {
    const opt = buildActionSequenceOption(twoWidgetRows)
    const duration = opt.series.find((s) => s.name === 'duration')
    const endLine = duration.markLine.data.find(
      (d) => d.label?.formatter === 'Action End Timestamp'
    )
    expect(endLine.xAxis).toBe(600)
  })

  it('treats an empty-string actionDurationMs as absent (not 0ms) and falls back', () => {
    // action_duration is emitted as '' when it can't be computed. Number('')
    // is 0 (and finite), which would otherwise pin the end marker to x=0 on top
    // of the start marker. '' must fall back to the reconstructed end (600).
    const opt = buildActionSequenceOption(twoWidgetRows, { actionDurationMs: '' })
    const duration = opt.series.find((s) => s.name === 'duration')
    const endLine = duration.markLine.data.find(
      (d) => d.label?.formatter === 'Action End Timestamp'
    )
    expect(endLine.xAxis).toBe(600)
    expect(opt.xAxis.max).toBeCloseTo(600 * 1.15, 5)
  })
})

// One heavy single-widget action mirroring the screenshot: offset 160, backend
// 3050, network Full 3840 (with waiting 791 + content download 22 nested), and
// a render (4000) nearly as long as the whole action (4160). A naive
// end-to-end cascade would run to ~11.9s — far past the real 4.16s end.
const heavyWidgetRows = [
  { WIDGET_ID: 'w1', WIDGET_NAME: 'X', WIDGET_MEASURE: 'offset',  WIDGET_SUBMEASURE: '',                DURATION: 160 },
  { WIDGET_ID: 'w1', WIDGET_NAME: 'X', WIDGET_MEASURE: 'backend', WIDGET_SUBMEASURE: '',                DURATION: 3050 },
  { WIDGET_ID: 'w1', WIDGET_NAME: 'X', WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'ttfb',            DURATION: 3840 },
  { WIDGET_ID: 'w1', WIDGET_NAME: 'X', WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'waiting',         DURATION: 791 },
  { WIDGET_ID: 'w1', WIDGET_NAME: 'X', WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'contentdownload', DURATION: 22 },
  { WIDGET_ID: 'w1', WIDGET_NAME: 'X', WIDGET_MEASURE: 'render',  WIDGET_SUBMEASURE: '',                DURATION: 4000 },
]
const HEAVY_END = 4160

describe('buildActionSequenceOption — nested + overlapping intra-widget layout', () => {
  const opt = buildActionSequenceOption(heavyWidgetRows, { actionDurationMs: HEAVY_END })
  const duration = opt.series.find((s) => s.name === 'duration')
  const byLabel = Object.fromEntries(duration.data.map((d) => [d.phaseLabel, d]))

  it('never lets a bar extend past the Action End marker', () => {
    for (const d of duration.data) {
      expect(d.endMs).toBeLessThanOrEqual(HEAVY_END + 1e-6)
    }
  })

  it('overlaps backend and Network (Full) — both start at the widget offset', () => {
    expect(byLabel['Query data of X'].startMs).toBe(160)
    expect(byLabel['X — Network (Full)'].startMs).toBe(160)
  })

  it('nests the network sub-phases inside the Network (Full) window', () => {
    const full = byLabel['X — Network (Full)']
    const waiting = byLabel['X — Network (waiting)']
    const contentDl = byLabel['X — Network (Content Download)']
    // Waiting sits at the head of Full; content download at its tail.
    expect(waiting.startMs).toBe(full.startMs)
    expect(waiting.endMs).toBeLessThanOrEqual(full.endMs)
    expect(contentDl.endMs).toBe(full.endMs)
    expect(contentDl.startMs).toBeGreaterThanOrEqual(full.startMs)
  })

  it('shifts an over-long render LEFT so it ends at the marker, keeping its true width', () => {
    const render = byLabel['Render X']
    // Natural render would run 4000→8000; clamped to end at 4160.
    expect(render.endMs).toBe(HEAVY_END)
    expect(render.startMs).toBe(160)
    // Real width is preserved (drawn value == true duration).
    expect(render.value).toBe(4000)
    expect(render.durationMs).toBe(4000)
  })

  it('reports TRUE phase durations regardless of clamping', () => {
    expect(byLabel['Query data of X'].durationMs).toBe(3050)
    expect(byLabel['X — Network (Full)'].durationMs).toBe(3840)
    expect(byLabel['X — Network (waiting)'].durationMs).toBe(791)
    expect(byLabel['X — Network (Content Download)'].durationMs).toBe(22)
  })

  it('does not stack the network sub-phases after Full (no double-counting)', () => {
    // The three network rows all live within [160, 4000]; their spans do not
    // sum past Full's end the way the old end-to-end cascade did.
    const full = byLabel['X — Network (Full)']
    expect(byLabel['X — Network (waiting)'].endMs).toBeLessThanOrEqual(full.endMs)
    expect(byLabel['X — Network (Content Download)'].endMs).toBeLessThanOrEqual(full.endMs)
  })
})
