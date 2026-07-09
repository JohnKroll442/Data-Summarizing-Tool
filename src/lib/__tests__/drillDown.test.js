import { describe, it, expect } from 'vitest'
import {
  detectSessionKey,
  applySessionFilter,
  applyActionFilter,
  applySessionMultiFilter,
  applyActionMultiFilter,
} from '../drillDown'

describe('detectSessionKey', () => {
  it('returns empty when headers are empty', () => {
    expect(detectSessionKey([], [])).toBe('')
    expect(detectSessionKey(null, null)).toBe('')
  })

  it('picks SESSION_ID for the plain case', () => {
    const rows = [{ SESSION_ID: 's1' }]
    expect(detectSessionKey(['SESSION_ID', 'USER_NAME'], rows)).toBe('SESSION_ID')
  })

  it('picks the more-populated column when SESSION_ID is blank on every row', () => {
    const rows = [
      { SESSION_ID: '', BROWSERSESSION_ID: 'b1' },
      { SESSION_ID: '', BROWSERSESSION_ID: 'b2' },
    ]
    expect(detectSessionKey(['SESSION_ID', 'BROWSERSESSION_ID'], rows))
      .toBe('BROWSERSESSION_ID')
  })

  it('accepts case- and separator-variants', () => {
    expect(detectSessionKey(['session id'], [{ 'session id': 's1' }])).toBe('session id')
  })
})

describe('applySessionFilter', () => {
  const rows = [
    { SESSION_ID: 's1', X: 1 },
    { SESSION_ID: 's2', X: 2 },
    { SESSION_ID: 's1', X: 3 },
  ]
  const headers = ['SESSION_ID', 'X']

  it('is a no-op when filter is null', () => {
    expect(applySessionFilter(rows, headers, null)).toBe(rows)
  })

  it('filters rows down to a specific session id', () => {
    const filtered = applySessionFilter(rows, headers, 's1')
    expect(filtered).toHaveLength(2)
    expect(filtered.every((r) => r.SESSION_ID === 's1')).toBe(true)
  })

  it('returns the rows unchanged when no session column can be detected', () => {
    const noSessionRows = [{ FOO: 1 }]
    expect(applySessionFilter(noSessionRows, ['FOO'], 's1')).toBe(noSessionRows)
  })
})

describe('applyActionFilter', () => {
  const rows = [
    { USER_ACTION: 'A', ACTION_TIMESTAMP: 't1', X: 1 },
    { USER_ACTION: 'A', ACTION_TIMESTAMP: 't2', X: 2 },
    { USER_ACTION: 'B', ACTION_TIMESTAMP: 't1', X: 3 },
  ]
  const headers = ['USER_ACTION', 'ACTION_TIMESTAMP', 'X']

  it('is a no-op when filter is null', () => {
    expect(applyActionFilter(rows, headers, null)).toBe(rows)
  })

  it('matches on both name and timestamp when both are provided', () => {
    const filtered = applyActionFilter(rows, headers, { name: 'A', timestamp: 't1' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].X).toBe(1)
  })

  it('matches on name only when timestamp is empty', () => {
    const filtered = applyActionFilter(rows, headers, { name: 'A', timestamp: '' })
    expect(filtered).toHaveLength(2)
    expect(filtered.every((r) => r.USER_ACTION === 'A')).toBe(true)
  })

  it('returns original rows when no action-name column can be found', () => {
    const noNameRows = [{ FOO: 1 }]
    expect(applyActionFilter(noNameRows, ['FOO'], { name: 'A', timestamp: '' }))
      .toBe(noNameRows)
  })
})

describe('applySessionMultiFilter', () => {
  const rows = [
    { SESSION_ID: 's1', X: 1 },
    { SESSION_ID: 's2', X: 2 },
    { SESSION_ID: 's3', X: 3 },
  ]
  const headers = ['SESSION_ID', 'X']

  it('is a no-op when the id list is empty', () => {
    expect(applySessionMultiFilter(rows, headers, [])).toBe(rows)
  })

  it('is a no-op when the id list is not an array', () => {
    expect(applySessionMultiFilter(rows, headers, null)).toBe(rows)
  })

  it('keeps rows whose session id is in the selected set', () => {
    const filtered = applySessionMultiFilter(rows, headers, ['s1', 's3'])
    expect(filtered).toHaveLength(2)
    expect(filtered.map((r) => r.X)).toEqual([1, 3])
  })

  it('coerces numeric ids to strings when matching', () => {
    const numRows = [{ SESSION_ID: 1 }, { SESSION_ID: 2 }]
    const filtered = applySessionMultiFilter(numRows, ['SESSION_ID'], ['1'])
    expect(filtered).toHaveLength(1)
    expect(filtered[0].SESSION_ID).toBe(1)
  })

  it('returns original rows when no session column can be detected', () => {
    const noSessionRows = [{ FOO: 1 }]
    expect(applySessionMultiFilter(noSessionRows, ['FOO'], ['s1'])).toBe(noSessionRows)
  })
})

describe('applyActionMultiFilter', () => {
  const rows = [
    { USER_ACTION: 'A', X: 1 },
    { USER_ACTION: 'B', X: 2 },
    { USER_ACTION: 'C', X: 3 },
  ]
  const headers = ['USER_ACTION', 'X']

  it('is a no-op when the name list is empty', () => {
    expect(applyActionMultiFilter(rows, headers, [])).toBe(rows)
  })

  it('keeps rows whose action name is in the selected set (every invocation)', () => {
    const multiRows = [
      { USER_ACTION: 'A', X: 1 },
      { USER_ACTION: 'A', X: 2 },
      { USER_ACTION: 'B', X: 3 },
    ]
    const filtered = applyActionMultiFilter(multiRows, headers, ['A'])
    expect(filtered).toHaveLength(2)
    expect(filtered.every((r) => r.USER_ACTION === 'A')).toBe(true)
  })

  it('matches multiple selected names', () => {
    const filtered = applyActionMultiFilter(rows, headers, ['A', 'C'])
    expect(filtered.map((r) => r.X)).toEqual([1, 3])
  })

  it('returns original rows when no action-name column can be found', () => {
    const noNameRows = [{ FOO: 1 }]
    expect(applyActionMultiFilter(noNameRows, ['FOO'], ['A'])).toBe(noNameRows)
  })
})
