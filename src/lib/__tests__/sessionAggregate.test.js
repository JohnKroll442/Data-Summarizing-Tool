import { describe, it, expect } from 'vitest'
import { aggregateBySession } from '../sessionAggregate'

const HEADERS = ['SESSION_ID', 'USER_NAME', 'STORY_NAME', 'DURATION']

const makeRows = (specs) =>
  specs.map(([SESSION_ID, USER_NAME, STORY_NAME, DURATION]) => ({
    SESSION_ID,
    USER_NAME,
    STORY_NAME,
    DURATION,
  }))

describe('aggregateBySession', () => {
  it('returns empty rows and intact columns for empty input', () => {
    const r1 = aggregateBySession([], HEADERS)
    const r2 = aggregateBySession(null, HEADERS)
    expect(r1.rows).toEqual([])
    expect(r2.rows).toEqual([])
    expect(r1.columns.map((c) => c.key)).toEqual([
      'session', 'user', 'story', 'timestamp_range', 'total_action_duration', 'action_count', 'max_action_duration',
    ])
  })

  it('returns empty rows when no session-shaped column exists', () => {
    const rows = [{ FOO: 'x', BAR: 'y' }]
    const result = aggregateBySession(rows, ['FOO', 'BAR'])
    expect(result.rows).toEqual([])
    expect(result.sessionKey).toBe('')
  })

  it('groups rows by session id preserving first-seen order', () => {
    const rows = makeRows([
      ['s1', 'alice', 'Story A', 100],
      ['s2', 'bob',   'Story B', 200],
      ['s1', 'alice', 'Story A', 300],
      ['s2', 'bob',   'Story B', 50],
    ])
    const { rows: out } = aggregateBySession(rows, HEADERS)
    expect(out.map((r) => r.session)).toEqual(['s1', 's2'])
  })

  it('computes action_count and max_action_duration per session', () => {
    const rows = makeRows([
      ['s1', 'alice', 'A', 100],
      ['s1', 'alice', 'A', 300],
      ['s1', 'alice', 'A', 250],
      ['s2', 'bob',   'B', 60],
    ])
    const { rows: out } = aggregateBySession(rows, HEADERS)
    const s1 = out.find((r) => r.session === 's1')
    const s2 = out.find((r) => r.session === 's2')
    expect(s1.action_count).toBe(3)
    expect(s1.max_action_duration).toBe(300)
    expect(s2.action_count).toBe(1)
    expect(s2.max_action_duration).toBe(60)
  })

  it('skips non-numeric durations when computing max', () => {
    const rows = makeRows([
      ['s1', 'a', 'A', 'oops'],
      ['s1', 'a', 'A', 500],
      ['s1', 'a', 'A', null],
    ])
    const { rows: out } = aggregateBySession(rows, HEADERS)
    expect(out[0].max_action_duration).toBe(500)
  })

  it('leaves max_action_duration empty when no rows have a finite duration', () => {
    const rows = [
      makeRows([['s1', 'a', 'A', 'oops']])[0],
      makeRows([['s1', 'a', 'A', undefined]])[0],
    ]
    const { rows: out } = aggregateBySession(rows, HEADERS)
    expect(out[0].max_action_duration).toBe('')
  })

  it('detects the session column across common casings/separators', () => {
    const variants = ['session_id', 'Session ID', 'SESSION_ID', 'sessionid']
    for (const h of variants) {
      const rows = [{ [h]: 's1', USER_NAME: 'a', STORY_NAME: 'S', DURATION: 100 }]
      const result = aggregateBySession(rows, [h, 'USER_NAME', 'STORY_NAME', 'DURATION'])
      expect(result.sessionKey).toBe(h)
      expect(result.rows).toHaveLength(1)
    }
  })

  // Regression guard: some SAP exports leave SESSION_ID blank on every row but
  // fully populate BROWSERSESSION_ID — we must pick the populated column.
  it('picks the more-populated session-ish column when multiple candidates exist', () => {
    const rows = [
      { SESSION_ID: '', BROWSERSESSION_ID: 'b1', USER_NAME: 'a', STORY_NAME: 'S', DURATION: 10 },
      { SESSION_ID: '', BROWSERSESSION_ID: 'b1', USER_NAME: 'a', STORY_NAME: 'S', DURATION: 20 },
      { SESSION_ID: '', BROWSERSESSION_ID: 'b2', USER_NAME: 'b', STORY_NAME: 'S', DURATION: 30 },
    ]
    const headers = ['SESSION_ID', 'BROWSERSESSION_ID', 'USER_NAME', 'STORY_NAME', 'DURATION']
    const result = aggregateBySession(rows, headers)
    expect(result.sessionKey).toBe('BROWSERSESSION_ID')
    expect(result.rows.map((r) => r.session).sort()).toEqual(['b1', 'b2'])
  })

  // Story detector must not pick timestamp/id/page/type/mode variants.
  it('rejects STORY_TIMESTAMP / STORY_ID as the story column', () => {
    const rows = [{
      SESSION_ID: 's1',
      USER_NAME: 'a',
      STORY_TIMESTAMP: 'when',
      STORY_ID: 'sid',
      DURATION: 10,
    }]
    const { mapping } = aggregateBySession(rows, ['SESSION_ID', 'USER_NAME', 'STORY_TIMESTAMP', 'STORY_ID', 'DURATION'])
    expect(mapping.story).toBe('')
  })

  it('picks first non-empty user/story per session group', () => {
    const rows = [
      { SESSION_ID: 's1', USER_NAME: '',     STORY_NAME: '',        DURATION: 10 },
      { SESSION_ID: 's1', USER_NAME: 'alice', STORY_NAME: 'Story A', DURATION: 20 },
    ]
    const { rows: out } = aggregateBySession(rows, HEADERS)
    expect(out[0].user).toBe('alice')
    expect(out[0].story).toBe('Story A')
  })

  it('rejects WIDGET_DURATION as the duration column', () => {
    const rows = [{
      SESSION_ID: 's1',
      WIDGET_DURATION: 500,
      DURATION: 100,
    }]
    const { mapping } = aggregateBySession(rows, ['SESSION_ID', 'WIDGET_DURATION', 'DURATION'])
    expect(mapping.duration).toBe('DURATION')
  })
})
