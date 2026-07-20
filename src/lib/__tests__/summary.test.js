import { describe, it, expect } from 'vitest'
import { computeRankings, computeBusiest } from '../summary'

/* ——— slowest / fastest rankings ——— */

const W_HEADERS = ['SESSION_ID', 'WIDGET_ID', 'WIDGET_NAME', 'WIDGET_MEASURE', 'DURATION']
const wrow = (wid, name, measure, dur) => ({
  SESSION_ID: 'S1', WIDGET_ID: wid, WIDGET_NAME: name, WIDGET_MEASURE: measure, DURATION: dur,
})

// Three widgets, each with a different winner per phase.
const W_ROWS = [
  wrow('W1', 'Chart 1', 'render', 300), wrow('W1', 'Chart 1', 'network', 100), wrow('W1', 'Chart 1', 'backend', 50),  wrow('W1', 'Chart 1', 'offset', 10),
  wrow('W2', 'Chart 2', 'render', 200), wrow('W2', 'Chart 2', 'network', 400), wrow('W2', 'Chart 2', 'backend', 90),  wrow('W2', 'Chart 2', 'offset', 5),
  wrow('W3', 'Chart 3', 'render', 100), wrow('W3', 'Chart 3', 'network', 50),  wrow('W3', 'Chart 3', 'backend', 500), wrow('W3', 'Chart 3', 'offset', 20),
]

describe('computeRankings', () => {
  it('returns slowest and fastest, each with the four lists in order', () => {
    const { slowest, fastest } = computeRankings(W_ROWS, W_HEADERS)
    const ids = ['render', 'network', 'backend', 'action']
    expect(slowest.map((l) => l.id)).toEqual(ids)
    expect(fastest.map((l) => l.id)).toEqual(ids)
  })

  it('ranks widgets slowest-first (desc) with name + id', () => {
    const byId = Object.fromEntries(computeRankings(W_ROWS, W_HEADERS).slowest.map((l) => [l.id, l]))
    expect(byId.render.items.map((i) => i.value)).toEqual([300, 200, 100])
    expect(byId.render.items[0]).toMatchObject({ label: 'Chart 1', sublabel: 'W1', value: 300 })
    expect(byId.backend.items[0].label).toBe('Chart 3')
  })

  it('gives each widget row a nav payload targeting its widget id', () => {
    const byId = Object.fromEntries(computeRankings(W_ROWS, W_HEADERS).slowest.map((l) => [l.id, l]))
    expect(byId.render.items[0].nav).toEqual({ view: 'widget', columns: { widget_id: ['W1'] } })
  })

  it('gives action rows a nav payload for the action + its story', () => {
    const headers = ['SESSION_ID', 'USER_ACTION', 'ACTION_TIMESTAMP', 'STORY_NAME', 'WIDGET_ID', 'WIDGET_MEASURE', 'DURATION']
    const rows = [
      { SESSION_ID: 'S1', USER_ACTION: 'Open', ACTION_TIMESTAMP: '2026-07-01 10:00:00', STORY_NAME: 'Sales', WIDGET_ID: 'W1', WIDGET_MEASURE: 'render', DURATION: 500 },
    ]
    const action = computeRankings(rows, headers).slowest.find((l) => l.id === 'action')
    expect(action.items[0].nav).toEqual({
      view: 'action',
      columns: {
        action_name: ['Open'],
        _action_timestamp: ['2026-07-01 10:00:00'],
        story_name: ['Sales'],
      },
    })
  })

  it('ranks fastest-first (asc) — the reverse of slowest', () => {
    const byId = Object.fromEntries(computeRankings(W_ROWS, W_HEADERS).fastest.map((l) => [l.id, l]))
    expect(byId.render.items.map((i) => i.value)).toEqual([100, 200, 300])
    expect(byId.render.items[0].label).toBe('Chart 3')
    expect(byId.backend.items[0].label).toBe('Chart 1') // 50 is the fastest backend
  })

  it('caps each list at 10', () => {
    const rows = []
    for (let i = 1; i <= 12; i++) {
      rows.push({ SESSION_ID: 'S1', WIDGET_ID: `W${i}`, WIDGET_NAME: `C${i}`, WIDGET_MEASURE: 'render', DURATION: i * 10 })
    }
    const { slowest, fastest } = computeRankings(rows, W_HEADERS)
    expect(slowest.find((l) => l.id === 'render').items).toHaveLength(10)
    expect(slowest.find((l) => l.id === 'render').items[0].value).toBe(120) // W12 slowest
    expect(fastest.find((l) => l.id === 'render').items[0].value).toBe(10) // W1 fastest
  })

  it('returns an empty list for a metric with no data (missing measure)', () => {
    const rows = [{ WIDGET_ID: 'W1', WIDGET_NAME: 'Chart 1' }]
    const { slowest } = computeRankings(rows, ['WIDGET_ID', 'WIDGET_NAME'])
    expect(slowest.find((l) => l.id === 'render').items).toEqual([])
  })

  it('returns empty rankings when there are no rows', () => {
    expect(computeRankings([], W_HEADERS)).toEqual({ slowest: [], fastest: [] })
  })

  it('scopes rankings to a timeline range — only in-window entities rank', () => {
    const headers = ['SESSION_ID', 'USER_ACTION', 'ACTION_TIMESTAMP', 'WIDGET_ID', 'WIDGET_MEASURE', 'DURATION']
    const row = (action, ts, dur) => ({
      SESSION_ID: 'S1', USER_ACTION: action, ACTION_TIMESTAMP: ts,
      WIDGET_ID: 'W1', WIDGET_MEASURE: 'render', DURATION: dur,
    })
    const rows = [
      row('In1', '2026-06-01 10:00:00', 500),
      row('In2', '2026-06-01 11:00:00', 300),
      row('Out', '2026-07-15 10:00:00', 900), // slowest overall, but outside the window
    ]
    // Window covering only Jun 1.
    const range = { min: new Date(2026, 5, 1).getTime(), max: new Date(2026, 5, 2).getTime() }
    const action = computeRankings(rows, headers, { range }).slowest.find((l) => l.id === 'action')
    const names = action.items.map((i) => i.label)
    expect(names).toEqual(['In1', 'In2']) // 500, 300 — the out-of-window 900 is dropped
    expect(names).not.toContain('Out')
  })
})

/* ——— busiest periods ——— */

const A_HEADERS = ['SESSION_ID', 'USER_NAME', 'USER_ACTION', 'ACTION_TIMESTAMP']
const arow = (name, ts) => ({ SESSION_ID: 'S1', USER_NAME: 'U', USER_ACTION: name, ACTION_TIMESTAMP: ts })

describe('computeBusiest', () => {
  it('reports the busiest day, week and month when the data spans them', () => {
    const rows = [
      arow('A', '2026-06-01 10:00:00'),
      arow('B', '2026-06-01 11:00:00'), // Jun 1 → 2 actions (busiest day)
      arow('C', '2026-06-02 10:00:00'), // same week/month as Jun 1
      arow('D', '2026-07-15 10:00:00'), // different week AND month
    ]
    const b = computeBusiest(rows, A_HEADERS)
    expect(b.day.count).toBe(2)
    expect(b.day.label).toContain('Jun 1')
    expect(b.week.count).toBe(3) // busiest 7-day stretch holds A, B, C
    // Busiest 30-day stretch is now a rolling window with a range label
    // (anchored at Jun 1; A, B, C fall inside, D is 44 days later).
    expect(b.month).toMatchObject({ label: 'Jun 1 – Jul 1, 2026', count: 3 })
  })

  it('omits week and month when the data is a single day', () => {
    const b = computeBusiest(
      [arow('A', '2026-07-01 10:00:00'), arow('B', '2026-07-01 11:00:00')],
      A_HEADERS,
    )
    expect(b.day.count).toBe(2)
    expect(b.week).toBeUndefined()
    expect(b.month).toBeUndefined()
  })

  it('drops the 30-day card for a sub-30-day span even across a month boundary', () => {
    // Jun 29 → Jul 1 crosses the Jun/Jul boundary but is only ~2 days — the
    // 30-day card must NOT appear (it used to, when gated on calendar months).
    const b = computeBusiest(
      [arow('A', '2026-06-29 10:00:00'), arow('B', '2026-07-01 10:00:00')],
      A_HEADERS,
    )
    expect(b.day).toBeTruthy()
    expect(b.week).toBeUndefined()
    expect(b.month).toBeUndefined()
  })

  it('returns null when there are no dated actions', () => {
    expect(computeBusiest([], A_HEADERS)).toBeNull()
  })

  it('scopes the tally to a timeline range and adapts which cards appear', () => {
    const rows = [
      arow('A', '2026-06-01 10:00:00'),
      arow('B', '2026-06-01 11:00:00'), // Jun 1 → 2 actions
      arow('C', '2026-06-02 10:00:00'),
      arow('D', '2026-07-15 10:00:00'), // outside the window
    ]
    // Window covering only Jun 1–2.
    const range = { min: new Date(2026, 5, 1).getTime(), max: new Date(2026, 5, 3).getTime() }
    const b = computeBusiest(rows, A_HEADERS, { range })
    expect(b.day.count).toBe(2) // Jun 1 (A,B); D is excluded by the range
    expect(b.day.label).toContain('Jun 1')
    expect(b.week).toBeUndefined() // windowed span is ~1 day (<7d)
    expect(b.month).toBeUndefined() // single month within the window
  })

  it('returns null when the range excludes every action', () => {
    const range = { min: new Date(2026, 0, 1).getTime(), max: new Date(2026, 0, 2).getTime() }
    expect(computeBusiest([arow('A', '2026-06-01 10:00:00')], A_HEADERS, { range })).toBeNull()
  })
})
