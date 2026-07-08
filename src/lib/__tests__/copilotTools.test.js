import { describe, it, expect } from 'vitest'
import { tools, findTool, redactRow, PII_COLUMNS, MAX_ROWS_PER_TOOL } from '../copilot/tools'

const ACTION_HEADERS = [
  'USER_NAME', 'USER_ACTION', 'ACTION_TIMESTAMP',
  'WIDGET_ID', 'WIDGET_MEASURE', 'DURATION',
]
const WIDGET_HEADERS = ['WIDGET_ID', 'WIDGET_NAME', 'WIDGET_MEASURE', 'DURATION']

function actionRow(over) {
  return {
    USER_NAME: 'alice',
    USER_ACTION: 'Open story',
    ACTION_TIMESTAMP: 't1',
    WIDGET_ID: 'w1',
    WIDGET_MEASURE: 'render',
    DURATION: 100,
    ...over,
  }
}

function widgetRow(over) {
  return {
    WIDGET_ID: 'w1',
    WIDGET_NAME: 'Chart',
    WIDGET_MEASURE: 'render',
    DURATION: 100,
    ...over,
  }
}

const payload = (rows, headers) => ({ rows, headers, fileName: 'test.csv' })

describe('copilot/tools', () => {
  it('registry names are unique and match tool schemas', () => {
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const t of tools) {
      expect(t.input_schema.type).toBe('object')
      expect(typeof t.run).toBe('function')
    }
  })

  it('top_regressions ranks matched action entities by deltaPct desc', () => {
    const baseline = payload([
      actionRow({ USER_ACTION: 'Fast', DURATION: 100 }),
      actionRow({ USER_ACTION: 'Slow', DURATION: 100 }),
    ], ACTION_HEADERS)
    const current = payload([
      actionRow({ USER_ACTION: 'Fast', DURATION: 110 }),
      actionRow({ USER_ACTION: 'Slow', DURATION: 300 }),
    ], ACTION_HEADERS)
    const ctx = { activePayload: current, baselinePayload: baseline, currentPayload: current }
    const out = findTool('top_regressions').run({ kind: 'action', n: 5 }, ctx)
    expect(out.rows[0].name).toBe('Slow')
    expect(out.rows[0].deltaPct).toBeGreaterThan(out.rows[1].deltaPct)
  })

  it('top_regressions throws when compare payloads missing', () => {
    const ctx = { activePayload: null, baselinePayload: null, currentPayload: null }
    expect(() => findTool('top_regressions').run({ kind: 'action' }, ctx)).toThrow()
  })

  it('filter_rows applies predicates against aggregated entities', () => {
    const rows = [
      widgetRow({ WIDGET_ID: 'w1', WIDGET_NAME: 'Fast', DURATION: 50 }),
      widgetRow({ WIDGET_ID: 'w2', WIDGET_NAME: 'Slow', DURATION: 900 }),
    ]
    const ctx = { activePayload: payload(rows, WIDGET_HEADERS), baselinePayload: null, currentPayload: null }
    const out = findTool('filter_rows').run(
      { kind: 'widget', where: [{ col: 'render', op: '>', value: 100 }] },
      ctx,
    )
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0].widget_id).toBe('w2')
  })

  it('list_slow returns backend-phase actions above threshold', () => {
    const rows = [
      actionRow({ USER_ACTION: 'A', WIDGET_MEASURE: 'backend', DURATION: 50, ACTION_TIMESTAMP: 't1' }),
      actionRow({ USER_ACTION: 'B', WIDGET_MEASURE: 'backend', DURATION: 800, ACTION_TIMESTAMP: 't2' }),
    ]
    const ctx = { activePayload: payload(rows, ACTION_HEADERS), baselinePayload: null, currentPayload: null }
    const out = findTool('list_slow').run(
      { kind: 'action', phase: 'backend', threshold: 100 }, ctx,
    )
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0].name).toBe('B')
  })

  it('phase_breakdown finds an action and returns its phases', () => {
    const rows = [
      actionRow({ USER_ACTION: 'Load', WIDGET_MEASURE: 'render',  DURATION: 40, ACTION_TIMESTAMP: 't1' }),
      actionRow({ USER_ACTION: 'Load', WIDGET_MEASURE: 'network', DURATION: 120, ACTION_TIMESTAMP: 't1' }),
      actionRow({ USER_ACTION: 'Load', WIDGET_MEASURE: 'backend', DURATION: 80, ACTION_TIMESTAMP: 't1' }),
    ]
    const ctx = { activePayload: payload(rows, ACTION_HEADERS), baselinePayload: null, currentPayload: null }
    const out = findTool('phase_breakdown').run({ kind: 'action', name: 'Load' }, ctx)
    expect(out.status).toBe('found')
    expect(out.network).toBe(120)
    expect(out.backend).toBe(80)
  })

  it('redactRow is identity while PII_COLUMNS is empty', () => {
    expect(PII_COLUMNS).toEqual([])
    const row = { USER_NAME: 'alice', DURATION: 100 }
    expect(redactRow(row)).toEqual(row)
  })

  it('caps results at MAX_ROWS_PER_TOOL and reports truncation', () => {
    const many = Array.from({ length: MAX_ROWS_PER_TOOL + 5 }, (_, i) =>
      widgetRow({ WIDGET_ID: `w${i}`, WIDGET_NAME: `W${i}`, DURATION: i + 1 }),
    )
    const ctx = { activePayload: payload(many, WIDGET_HEADERS), baselinePayload: null, currentPayload: null }
    const out = findTool('filter_rows').run({ kind: 'widget', where: [], limit: 999 }, ctx)
    expect(out.rows.length).toBeLessThanOrEqual(MAX_ROWS_PER_TOOL)
    expect(out.truncated).toBe(true)
    expect(out.total).toBeGreaterThan(MAX_ROWS_PER_TOOL)
  })

  it('describe_dataset reports which payloads are present', () => {
    const rows = [actionRow({})]
    const ctx = { activePayload: payload(rows, ACTION_HEADERS), baselinePayload: null, currentPayload: null }
    const out = findTool('describe_dataset').run({}, ctx)
    expect(out.active.present).toBe(true)
    expect(out.baseline.present).toBe(false)
    expect(out.current.present).toBe(false)
    expect(out.active.columns).toEqual(ACTION_HEADERS)
  })
})
