import { describe, it, expect } from 'vitest'
import {
  parseTimestamp,
  bucketOf,
  listConstrainedBuckets,
  matchesTimeFilter,
  matchesTimeRange,
  pruneSelections,
  emptyTimeSelections,
  hasTimeSelection,
  timeSelectionCount,
} from '../timeBuckets'

const TS = '2026-07-08 18:33:46.496000000' // a Wednesday

describe('parseTimestamp', () => {
  it('parses the app datetime shape with 9 fractional digits', () => {
    const d = parseTimestamp(TS)
    expect(d).toBeInstanceOf(Date)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(6) // July (0-indexed)
    expect(d.getDate()).toBe(8)
    expect(d.getHours()).toBe(18)
    expect(d.getMinutes()).toBe(33)
    expect(d.getSeconds()).toBe(46)
    expect(d.getMilliseconds()).toBe(496)
  })

  it('accepts ISO strings and Date objects', () => {
    expect(parseTimestamp('2026-07-08T18:33:46.496Z')).toBeInstanceOf(Date)
    const now = new Date(2026, 0, 1)
    expect(parseTimestamp(now)).toBe(now)
  })

  it('returns null for empty/unparseable values', () => {
    expect(parseTimestamp('')).toBeNull()
    expect(parseTimestamp(null)).toBeNull()
    expect(parseTimestamp(undefined)).toBeNull()
    expect(parseTimestamp('not a date')).toBeNull()
  })
})

describe('bucketOf', () => {
  const d = parseTimestamp(TS)
  it('buckets by month', () => {
    expect(bucketOf(d, 'month')).toMatchObject({ key: '2026-07', label: 'Jul 2026' })
  })
  it('buckets by week (Monday-anchored)', () => {
    // Wed Jul 8 → week of Mon Jul 6
    expect(bucketOf(d, 'week')).toMatchObject({ key: 'w:2026-07-06', label: 'Week of Jul 6, 2026' })
  })
  it('buckets by day', () => {
    expect(bucketOf(d, 'day')).toMatchObject({ key: '2026-07-08', label: 'Jul 8, 2026' })
  })
  it('buckets by hour and minute', () => {
    expect(bucketOf(d, 'hour').key).toBe('2026-07-08 18')
    expect(bucketOf(d, 'minute').key).toBe('2026-07-08 18:33')
  })
})

describe('listConstrainedBuckets', () => {
  const rows = [
    { ts: '2026-07-08 18:33:46.496000000' },
    { ts: '2026-07-08 19:01:00.000000000' },
    { ts: '2026-07-09 09:15:00.000000000' },
    { ts: '' }, // ignored
  ]
  const get = (r) => r.ts
  const none = emptyTimeSelections()

  it('lists only present day buckets, chronologically, with counts', () => {
    const buckets = listConstrainedBuckets(rows, get, 'day', none)
    expect(buckets.map((b) => b.key)).toEqual(['2026-07-08', '2026-07-09'])
    expect(buckets[0].count).toBe(2)
    expect(buckets[1].count).toBe(1)
  })

  it('collapses to a single month bucket', () => {
    const buckets = listConstrainedBuckets(rows, get, 'month', none)
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({ key: '2026-07', count: 3 })
  })

  it('constrains finer options to the selected coarser buckets', () => {
    // Only the Jul 8 day selected → Hour options limited to that day's hours.
    const sel = { ...emptyTimeSelections(), day: ['2026-07-08'] }
    const hours = listConstrainedBuckets(rows, get, 'hour', sel)
    expect(hours.map((b) => b.key)).toEqual(['2026-07-08 18', '2026-07-08 19'])
    // Jul 9's 09:00 hour is excluded because its day isn't selected.
    expect(hours.some((b) => b.key.startsWith('2026-07-09'))).toBe(false)
  })
})

describe('matchesTimeFilter', () => {
  const get = (r) => r.ts
  const row = { ts: '2026-07-08 18:33:46.496000000' }

  it('passes everything when nothing is selected', () => {
    expect(matchesTimeFilter(row, get, emptyTimeSelections())).toBe(true)
  })
  it('matches on a single active level', () => {
    expect(matchesTimeFilter(row, get, { ...emptyTimeSelections(), day: ['2026-07-08'] })).toBe(true)
    expect(matchesTimeFilter(row, get, { ...emptyTimeSelections(), day: ['2026-07-09'] })).toBe(false)
  })
  it('requires a match at EVERY active level (AND)', () => {
    const sel = { ...emptyTimeSelections(), day: ['2026-07-08'], hour: ['2026-07-08 18'] }
    expect(matchesTimeFilter(row, get, sel)).toBe(true)
    const sel2 = { ...emptyTimeSelections(), day: ['2026-07-08'], hour: ['2026-07-08 19'] }
    expect(matchesTimeFilter(row, get, sel2)).toBe(false)
  })
  it('excludes rows with no parseable timestamp when active', () => {
    expect(matchesTimeFilter({ ts: '' }, get, { ...emptyTimeSelections(), day: ['2026-07-08'] })).toBe(false)
  })
})

describe('matchesTimeRange', () => {
  const get = (r) => r.ts
  const row = { ts: '2026-07-08 18:33:46.496000000' }
  // Inclusive window: Jul 8 00:00 → Jul 8 23:59 (local, matching parseTimestamp).
  const range = {
    min: new Date(2026, 6, 8, 0, 0).getTime(),
    max: new Date(2026, 6, 8, 23, 59).getTime(),
  }

  it('passes everything when the range is null', () => {
    expect(matchesTimeRange(row, get, null)).toBe(true)
    expect(matchesTimeRange({ ts: '' }, get, null)).toBe(true)
  })
  it('keeps rows inside the window and drops rows outside it', () => {
    expect(matchesTimeRange(row, get, range)).toBe(true)
    expect(matchesTimeRange({ ts: '2026-07-09 09:15:00.000000000' }, get, range)).toBe(false)
    expect(matchesTimeRange({ ts: '2026-07-07 23:59:00.000000000' }, get, range)).toBe(false)
  })
  it('treats both bounds as inclusive', () => {
    expect(matchesTimeRange({ ts: '2026-07-08 00:00:00.000000000' }, get, range)).toBe(true)
    expect(matchesTimeRange({ ts: '2026-07-08 23:59:00.000000000' }, get, range)).toBe(true)
  })
  it('excludes rows with no parseable timestamp when a range is active', () => {
    expect(matchesTimeRange({ ts: '' }, get, range)).toBe(false)
    expect(matchesTimeRange({ ts: 'not a date' }, get, range)).toBe(false)
  })
})

describe('pruneSelections', () => {
  const rows = [
    { ts: '2026-07-08 18:33:00.000000000' },
    { ts: '2026-07-09 09:15:00.000000000' },
  ]
  const get = (r) => r.ts

  it('drops finer selections that fall outside the coarser ones', () => {
    // Day Jul 8 selected, plus an hour that belongs to Jul 9 (now orphaned).
    const sel = {
      ...emptyTimeSelections(),
      day: ['2026-07-08'],
      hour: ['2026-07-08 18', '2026-07-09 09'],
    }
    const pruned = pruneSelections(rows, get, sel)
    expect(pruned.hour).toEqual(['2026-07-08 18'])
    expect(pruned.day).toEqual(['2026-07-08'])
  })
})

describe('selection helpers', () => {
  it('reports emptiness and counts', () => {
    expect(hasTimeSelection(emptyTimeSelections())).toBe(false)
    const sel = { ...emptyTimeSelections(), week: ['w:2026-07-06'], day: ['2026-07-08', '2026-07-09'] }
    expect(hasTimeSelection(sel)).toBe(true)
    expect(timeSelectionCount(sel)).toBe(3)
  })
})
