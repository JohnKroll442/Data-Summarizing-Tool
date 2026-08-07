import { describe, it, expect } from 'vitest'
import {
  filterAggRows,
  computeSummaryScope,
  activeDurationBounds,
  visibleSessionRows,
  SESSION_TS,
} from '../viewFilters'
import { aggregateBySession } from '../sessionAggregate'
import { computeRankings } from '../summary'
import { emptyTimeSelections } from '../timeBuckets'
import { matchesAllMultiFilters } from '../multiFilter'
import { matchesDurationFilter } from '../durationFilter'
import { matchesTimeFilter, matchesTimeRange } from '../timeBuckets'

/**
 * Fixture: two sessions, each with a single action + single widget.
 *   S1 — action A1 renders in 30s  → total duration 30_000ms  (under 2 min)
 *   S2 — action A2 renders in 5min → total duration 300_000ms (over 2 min)
 * Each raw row is one WIDGET_MEASURE sample.
 */
const HEADERS = [
  'SESSION_ID',
  'USER_NAME',
  'STORY_NAME',
  'USER_ACTION',
  'ACTION_TIMESTAMP',
  'WIDGET_ID',
  'WIDGET_NAME',
  'WIDGET_MEASURE',
  'DURATION',
  'WIDGET_RENDER_TIMESTAMP',
  'WIDGET_RENDER_TIMESTAMP_START',
]

const ROWS = [
  {
    SESSION_ID: 'S1', USER_NAME: 'alice', STORY_NAME: 'Story A',
    USER_ACTION: 'Open story', ACTION_TIMESTAMP: '2026-01-01 00:00:00',
    WIDGET_ID: 'W1', WIDGET_NAME: 'Chart', WIDGET_MEASURE: 'render',
    DURATION: '30000', WIDGET_RENDER_TIMESTAMP: '2026-01-01 00:00:30',
    WIDGET_RENDER_TIMESTAMP_START: '2026-01-01 00:00:00',
  },
  {
    SESSION_ID: 'S2', USER_NAME: 'bob', STORY_NAME: 'Story B',
    USER_ACTION: 'Filter changed', ACTION_TIMESTAMP: '2026-01-01 01:00:00',
    WIDGET_ID: 'W2', WIDGET_NAME: 'Table', WIDGET_MEASURE: 'render',
    DURATION: '300000', WIDGET_RENDER_TIMESTAMP: '2026-01-01 01:05:00',
    WIDGET_RENDER_TIMESTAMP_START: '2026-01-01 01:00:00',
  },
]

// A "no filters set" context bundle — the shape computeSummaryScope reads.
function emptyState(overrides = {}) {
  return {
    viewUi: {
      session: { search: '', filters: {}, sort: null, durationFilter: null },
      action: { search: '', filters: {}, sort: null, durationFilter: null },
      widget: { search: '', filters: {}, sort: null, durationFilter: null },
    },
    sessionFilter: null,
    actionFilter: null,
    sessionMultiFilter: [],
    actionMultiFilter: [],
    actionInvocationFilter: [],
    widgetMultiFilter: [],
    timeSelections: emptyTimeSelections(),
    timelineRange: null,
    ...overrides,
  }
}

describe('filterAggRows', () => {
  const { rows: aggRows, columns } = aggregateBySession(ROWS, HEADERS)

  it('parity: reproduces the inline session predicate for a duration filter', () => {
    const opts = {
      tsAccessor: SESSION_TS,
      timeFilter: emptyTimeSelections(),
      timelineRange: null,
      filters: {},
      durationKey: 'total_action_duration',
      durationFilter: { minMs: null, maxMs: 120_000 },
      search: '',
    }
    // Hand-run the same pipeline the tables used before the refactor.
    const inline = aggRows.filter((row) =>
      matchesAllMultiFilters(row, opts.filters) &&
      matchesTimeFilter(row, SESSION_TS, opts.timeFilter) &&
      matchesTimeRange(row, SESSION_TS, opts.timelineRange) &&
      matchesDurationFilter(row, 'total_action_duration', opts.durationFilter))

    expect(filterAggRows(aggRows, columns, opts)).toEqual(inline)
  })

  it('search matches via startsWith over display columns', () => {
    const out = filterAggRows(aggRows, columns, { search: 'alice' })
    expect(out).toHaveLength(1)
    expect(out[0].session).toBe('S1')
  })

  it('empty options is a pass-through (no active predicates)', () => {
    expect(filterAggRows(aggRows, columns, {})).toEqual(aggRows)
  })
})

describe('computeSummaryScope', () => {
  it('no active filters → scopedRows is the original rows (referential identity)', () => {
    const { scopedRows } = computeSummaryScope(ROWS, HEADERS, emptyState())
    expect(scopedRows).toBe(ROWS)
  })

  it('a Session duration filter does NOT gate raw rows by session membership', () => {
    // The duration threshold is applied per-ranking by value (see the rankings
    // test below), not by dropping whole sessions — so scopedRows stays whole.
    const state = emptyState({
      viewUi: {
        session: { search: '', filters: {}, sort: null, durationFilter: { minMs: null, maxMs: 120_000 } },
        action: { search: '', filters: {}, sort: null, durationFilter: null },
        widget: { search: '', filters: {}, sort: null, durationFilter: null },
      },
    })

    // The session view itself still narrows (it honors its own duration filter)…
    const { visibleRows } = visibleSessionRows(ROWS, HEADERS, state)
    expect(visibleRows.map((r) => r.session)).toEqual(['S1'])

    // …but the Summary's membership scope ignores duration, so no rows are cut.
    const { scopedRows } = computeSummaryScope(ROWS, HEADERS, state)
    expect(scopedRows).toBe(ROWS)
  })

  it('an undetectable entity (no widget_id column) builds no gate → no accidental zeroing', () => {
    const headers = HEADERS.filter((h) => h !== 'WIDGET_ID')
    const rows = ROWS.map(({ WIDGET_ID: _WIDGET_ID, ...rest }) => rest)
    const { scopedRows } = computeSummaryScope(rows, headers, emptyState())
    expect(scopedRows).toBe(rows)
  })
})

describe('duration threshold on the Summary rankings', () => {
  const boundsFor = (durationFilter) =>
    activeDurationBounds({ viewUi: { session: { durationFilter }, action: {} } })

  it("'< 2 min' hides entities longer than that in every category (by own value)", () => {
    // S1's action renders in 30s; S2's renders in 5 min.
    const bounds = boundsFor({ minMs: null, maxMs: 120_000 })
    const rankings = computeRankings(ROWS, HEADERS, { range: null, durationBounds: bounds })
    const labels = [...rankings.slowest, ...rankings.fastest]
      .flatMap((list) => list.items.map((it) => it.label))
    expect(labels).toContain('Chart')       // 30s render — under 2 min
    expect(labels).not.toContain('Table')   // 5 min render — over 2 min, hidden
    expect(labels).not.toContain('Filter changed')
  })

  it("'> 2 min' surfaces ONLY the long (ttfb/incomplete) entities", () => {
    const bounds = boundsFor({ minMs: 120_000, maxMs: null })
    const rankings = computeRankings(ROWS, HEADERS, { range: null, durationBounds: bounds })
    const labels = [...rankings.slowest, ...rankings.fastest]
      .flatMap((list) => list.items.map((it) => it.label))
    expect(labels).toContain('Table')          // 5 min render — over 2 min
    expect(labels).not.toContain('Chart')      // 30s — under 2 min, hidden
  })

  it('null bounds ranks everything (no threshold)', () => {
    const rankings = computeRankings(ROWS, HEADERS, { range: null, durationBounds: null })
    const labels = rankings.slowest.flatMap((list) => list.items.map((it) => it.label))
    expect(labels).toContain('Chart')
    expect(labels).toContain('Table')
  })
})

describe('activeDurationBounds', () => {
  it('returns null when no view has a duration filter', () => {
    expect(activeDurationBounds({ viewUi: { session: {}, action: {} } })).toBeNull()
  })

  it('intersects bounds across Session and Action filters (tightest wins)', () => {
    const bounds = activeDurationBounds({
      viewUi: {
        session: { durationFilter: { minMs: 10_000, maxMs: 300_000 } },
        action: { durationFilter: { minMs: 50_000, maxMs: 120_000 } },
      },
    })
    expect(bounds).toEqual({ minMs: 50_000, maxMs: 120_000 })
  })

  it("includes the Widget view's Total duration filter in the intersection", () => {
    const bounds = activeDurationBounds({
      viewUi: {
        session: {},
        action: {},
        widget: { durationFilter: { minMs: 90_000, maxMs: 240_000 } },
      },
    })
    expect(bounds).toEqual({ minMs: 90_000, maxMs: 240_000 })
  })
})
