// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { parseCsvFile, validateSchema } from '../parseCsv'

// parseCsvFile uses FileReader.readAsText, a browser API. Node 24 provides File
// and Blob but not FileReader, so this file runs under jsdom.
const makeFile = (text, name = 'test.csv', type = 'text/csv') =>
  new File([text], name, { type })

describe('parseCsvFile', () => {
  it('parses a basic comma-separated CSV into headers + rows', async () => {
    const csv = 'A,B,C\n1,2,3\n4,5,6\n'
    const { headers, rows } = await parseCsvFile(makeFile(csv))
    expect(headers).toEqual(['A', 'B', 'C'])
    expect(rows).toEqual([{ A: 1, B: 2, C: 3 }, { A: 4, B: 5, C: 6 }])
  })

  it('strips a UTF-8 BOM from the first header', async () => {
    const csv = '﻿SESSION_ID,USER_NAME\ns1,alice\n'
    const { headers, rows } = await parseCsvFile(makeFile(csv))
    expect(headers).toEqual(['SESSION_ID', 'USER_NAME'])
    expect(rows[0]).toEqual({ SESSION_ID: 's1', USER_NAME: 'alice' })
  })

  it('trims whitespace from headers', async () => {
    const csv = '  A , B  ,C\n1,2,3\n'
    const { headers } = await parseCsvFile(makeFile(csv))
    expect(headers).toEqual(['A', 'B', 'C'])
  })

  // Regression guard for the mixed line-ending bug flagged in parseCsv.js
  // docstring: CRLF for the first block, LF for the rest -> without
  // normalization Papa would treat every later LF-only row as a continuation
  // of the previous record.
  it('handles mixed CRLF/LF line endings without truncating rows', async () => {
    const csv =
      'A,B\r\n1,2\r\n3,4\r\n5,6\n7,8\n9,10\n'
    const { rows } = await parseCsvFile(makeFile(csv))
    expect(rows).toHaveLength(5)
    expect(rows[4]).toEqual({ A: 9, B: 10 })
  })

  it('auto-detects tab as the delimiter for tab-separated exports', async () => {
    const csv = 'SESSION_ID\tUSER_NAME\ns1\talice\ns2\tbob\n'
    const { headers, rows } = await parseCsvFile(makeFile(csv))
    expect(headers).toEqual(['SESSION_ID', 'USER_NAME'])
    expect(rows).toEqual([
      { SESSION_ID: 's1', USER_NAME: 'alice' },
      { SESSION_ID: 's2', USER_NAME: 'bob' },
    ])
  })

  it('auto-detects semicolon as the delimiter', async () => {
    const csv = 'A;B\n1;2\n'
    const { rows } = await parseCsvFile(makeFile(csv))
    expect(rows).toEqual([{ A: 1, B: 2 }])
  })

  it('coerces numeric strings via dynamicTyping', async () => {
    const csv = 'DURATION\n100\n250.5\n'
    const { rows } = await parseCsvFile(makeFile(csv))
    expect(rows[0].DURATION).toBe(100)
    expect(rows[1].DURATION).toBe(250.5)
    expect(typeof rows[0].DURATION).toBe('number')
  })

  it('drops blank and whitespace-only lines (skipEmptyLines: greedy)', async () => {
    const csv = 'A,B\n1,2\n\n   \n3,4\n'
    const { rows } = await parseCsvFile(makeFile(csv))
    expect(rows).toHaveLength(2)
  })
})

/* ——— validateSchema ——— */

describe('validateSchema', () => {
  it('reports all required labels as available for a fully-shaped CSV', () => {
    const headers = [
      'SESSION_ID', 'USER_NAME', 'STORY_NAME',
      'USER_ACTION', 'ACTION_TIMESTAMP',
      'WIDGET_ID', 'WIDGET_NAME', 'WIDGET_MEASURE',
      'DURATION',
    ]
    const rows = [{
      SESSION_ID: 's1', USER_NAME: 'a', STORY_NAME: 'A',
      USER_ACTION: 'Open', ACTION_TIMESTAMP: 't1',
      WIDGET_ID: 'w1', WIDGET_NAME: 'Bar', WIDGET_MEASURE: 'render',
      DURATION: 100,
    }]
    const result = validateSchema(headers, rows)
    expect(result.missing).toEqual([])
    expect(result.affectedViews).toEqual([])
    expect(result.canProceed).toBe(true)
  })

  it('marks partial-schema files as still proceedable if any label was detected', () => {
    const headers = ['SESSION_ID', 'USER_NAME', 'STORY_NAME', 'DURATION']
    const rows = [{ SESSION_ID: 's1', USER_NAME: 'a', STORY_NAME: 'A', DURATION: 100 }]
    const result = validateSchema(headers, rows)
    expect(result.available).toContain('SESSION_ID')
    expect(result.missing).toContain('USER_ACTION')
    expect(result.affectedViews).toContain('Action view')
    expect(result.canProceed).toBe(true)
  })

  it('reports canProceed: false only when nothing at all was detected', () => {
    const result = validateSchema(['FOO', 'BAR'], [{ FOO: 'x', BAR: 'y' }])
    expect(result.available).toEqual([])
    expect(result.canProceed).toBe(false)
    expect(result.affectedViews.length).toBeGreaterThan(0)
  })

  it('handles empty inputs without throwing', () => {
    const result = validateSchema([], [])
    expect(result.canProceed).toBe(false)
  })
})
