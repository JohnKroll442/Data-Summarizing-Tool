import { describe, it, expect } from 'vitest'
import { buildStoryActionMatrix, cellKeyOf } from '../storyActionMatrix'

// Minimal aggregated-action-row shape the builder reads.
const row = (story_name, action_name, action_duration, extra = {}) => ({
  story_name,
  action_name,
  action_duration,
  ...extra,
})

describe('buildStoryActionMatrix', () => {
  it('returns an empty matrix for empty input', () => {
    for (const input of [[], null, undefined]) {
      const m = buildStoryActionMatrix(input)
      expect(m.stories).toEqual([])
      expect(m.actions).toEqual([])
      expect(m.cells.size).toBe(0)
      expect(m.maxP95).toBe(0)
    }
  })

  it('groups by story × action and lists distinct labels alphabetically', () => {
    const rows = [
      row('Story B', 'Open', 100),
      row('Story A', 'Open', 100),
      row('Story A', 'Close', 100),
    ]
    const m = buildStoryActionMatrix(rows)
    expect(m.stories).toEqual(['Story A', 'Story B'])
    expect(m.actions).toEqual(['Close', 'Open'])
    // Three distinct combos → three populated cells.
    expect(m.cells.size).toBe(3)
    expect(m.cells.get(cellKeyOf('Story A', 'Open')).count).toBe(1)
  })

  it('computes the p95 of each cell via the shared percentile (interpolated)', () => {
    // 10 values 1000..10000 → p95 = interpolate at rank 0.95*(9) = 8.55
    // between the 9th (9000) and 10th (10000): 9000 + 0.55*1000 = 9550.
    const rows = Array.from({ length: 10 }, (_, i) =>
      row('S', 'A', (i + 1) * 1000),
    )
    const m = buildStoryActionMatrix(rows)
    const cell = m.cells.get(cellKeyOf('S', 'A'))
    expect(cell.count).toBe(10)
    expect(cell.p95).toBeCloseTo(9550, 5)
    expect(m.maxP95).toBeCloseTo(9550, 5)
  })

  it('keeps the instance rows on each cell for drill-down', () => {
    const a = row('S', 'A', 100, { _action_timestamp: 't1', user: 'u1' })
    const b = row('S', 'A', 200, { _action_timestamp: 't2', user: 'u2' })
    const m = buildStoryActionMatrix([a, b])
    const cell = m.cells.get(cellKeyOf('S', 'A'))
    expect(cell.instances).toEqual([a, b])
  })

  it('skips rows missing a story or an action, and cells with no finite duration', () => {
    const rows = [
      row('', 'A', 100),
      row('S', '', 100),
      row('S', 'A', ''), // present combo, but no finite duration
    ]
    const m = buildStoryActionMatrix(rows)
    expect(m.stories).toEqual(['S'])
    expect(m.actions).toEqual(['A'])
    const cell = m.cells.get(cellKeyOf('S', 'A'))
    expect(cell.count).toBe(1)
    expect(cell.p95).toBeNull()
    expect(m.maxP95).toBe(0)
  })
})
