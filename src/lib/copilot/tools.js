import { aggregateBySession } from '../sessionAggregate'
import { aggregateByAction } from '../actionAggregate'
import { aggregateByWidget } from '../widgetAggregate'
import { compareEntities } from '../compare'

export const MAX_ROWS_PER_TOOL = 50

// Columns whose values must be stripped before rows are returned to the LLM.
// Empty today because sample data is non-sensitive. When customer data lands,
// add the real column names (e.g. 'USERNAME', 'SESSION_ID', 'BROWSERSESSION_ID')
// and every tool automatically starts redacting — no other files change.
export const PII_COLUMNS = []

export function redactRow(row) {
  if (!row || PII_COLUMNS.length === 0) return row
  const out = { ...row }
  for (const col of PII_COLUMNS) {
    if (col in out) out[col] = '[redacted]'
  }
  return out
}

function requirePayload(payload, label) {
  if (!payload || !Array.isArray(payload.rows) || payload.rows.length === 0) {
    throw new Error(`No ${label} data loaded`)
  }
}

// When the user has only selected a baseline (via the copilot file selector),
// treat the active file as "current" so compare tools work without needing
// the full /compare page flow.
function resolveComparePayloads(ctx) {
  const baseline = ctx.baselinePayload
  const current = ctx.currentPayload ?? ctx.activePayload
  if (!baseline) throw new Error('No baseline file selected. Use the file selector at the top of the copilot drawer to pick a baseline.')
  if (!current) throw new Error('No active file loaded to compare against.')
  return { baseline, current }
}

/* ——— tool implementations ——— */

function describeDataset(_input, ctx) {
  const summarize = (payload, label) => {
    if (!payload || !payload.rows?.length) return { label, present: false }
    return {
      label,
      present: true,
      fileName: payload.fileName || '(unnamed)',
      rowCount: payload.rows.length,
      columns: payload.headers,
    }
  }
  return {
    active: summarize(ctx.activePayload, 'active'),
    baseline: summarize(ctx.baselinePayload, 'baseline'),
    current: summarize(ctx.currentPayload, 'current'),
  }
}

function topRegressions({ kind, n = 10, minPct = 0 }, ctx) {
  const { baseline, current } = resolveComparePayloads(ctx)
  const { matched } = compareEntities(kind, baseline, current)
  const ranked = matched
    .filter((r) => r.deltaPct !== null && r.deltaPct >= minPct)
    .sort((a, b) => (b.deltaPct ?? 0) - (a.deltaPct ?? 0))
  const effectiveLimit = Math.min(n, MAX_ROWS_PER_TOOL)
  return {
    rows: ranked.slice(0, effectiveLimit).map(redactRow),
    total: ranked.length,
    truncated: ranked.length > effectiveLimit,
  }
}

function compareEntity({ kind, name }, ctx) {
  const { baseline, current } = resolveComparePayloads(ctx)
  const { matched, newInCurrent, droppedFromBaseline } = compareEntities(
    kind, baseline, current,
  )
  const needle = String(name).toLowerCase()
  const hit = matched.find((r) => String(r.name).toLowerCase() === needle)
  if (hit) return { status: 'matched', row: redactRow(hit) }
  const isNew = newInCurrent.find((r) => String(r.name).toLowerCase() === needle)
  if (isNew) return { status: 'new_in_current', row: redactRow(isNew) }
  const dropped = droppedFromBaseline.find((r) => String(r.name).toLowerCase() === needle)
  if (dropped) return { status: 'dropped_from_baseline', row: redactRow(dropped) }
  return { status: 'not_found', name }
}

function resolveFilePayload(file, ctx) {
  if (file === 'baseline') {
    if (!ctx.baselinePayload) throw new Error('No baseline file selected.')
    return ctx.baselinePayload
  }
  requirePayload(ctx.activePayload, 'active')
  return ctx.activePayload
}

function listSlow({ kind, phase = 'total', threshold = 0, limit = 20, file = 'active' }, ctx) {
  const payload = resolveFilePayload(file, ctx)
  const { rows, headers } = payload
  let entities
  if (kind === 'action') {
    const { rows: agg } = aggregateByAction(rows, headers)
    entities = agg.map((r) => ({
      name: r.action_name,
      user: r.user,
      frontend: numOrNull(r.max_frontend),
      network: numOrNull(r.max_network),
      backend: numOrNull(r.max_backend),
      total: maxFinite([r.max_frontend, r.max_network, r.max_backend]),
    }))
  } else if (kind === 'widget') {
    const { rows: agg } = aggregateByWidget(rows, headers)
    entities = agg.map((r) => ({
      name: r.widget_name || r.widget_id,
      widget_id: r.widget_id,
      render: numOrNull(r.render),
      network: numOrNull(r.network),
      backend: numOrNull(r.backend),
      total: maxFinite([r.render, r.network, r.backend]),
    }))
  } else if (kind === 'session') {
    const { rows: agg } = aggregateBySession(rows, headers)
    entities = agg.map((r) => ({
      session: r.session,
      user: r.user,
      action_count: r.action_count,
      max_action_duration: numOrNull(r.max_action_duration),
      total: numOrNull(r.max_action_duration),
    }))
  } else {
    throw new Error(`Unknown kind: ${kind}`)
  }
  const phaseKey = phase === 'frontend' ? 'frontend'
    : phase === 'network' ? 'network'
    : phase === 'backend' ? 'backend'
    : phase === 'render' ? 'render'
    : 'total'
  const filtered = entities
    .filter((e) => Number.isFinite(e[phaseKey]) && e[phaseKey] >= threshold)
    .sort((a, b) => (b[phaseKey] ?? 0) - (a[phaseKey] ?? 0))
  const effectiveLimit = Math.min(limit, MAX_ROWS_PER_TOOL)
  return {
    rows: filtered.slice(0, effectiveLimit).map(redactRow),
    total: filtered.length,
    truncated: filtered.length > effectiveLimit,
  }
}

function getSessionActions({ sessionId, limit = 20 }, ctx) {
  requirePayload(ctx.activePayload, 'active')
  const { rows, headers } = ctx.activePayload
  const { mapping, sessionKey } = aggregateBySession(rows, headers)
  if (!sessionKey) throw new Error('No session id column detected in the active file')
  const matchingRows = rows.filter((r) => String(r?.[sessionKey] ?? '') === String(sessionId))
  if (matchingRows.length === 0) return { rows: [], total: 0, truncated: false }
  const { rows: actionAgg } = aggregateByAction(matchingRows, headers)
  const sorted = actionAgg.map((r) => ({
    action_name: r.action_name,
    user: r.user,
    max_frontend: numOrNull(r.max_frontend),
    max_network: numOrNull(r.max_network),
    max_backend: numOrNull(r.max_backend),
  })).sort((a, b) =>
    maxFinite([b.max_frontend, b.max_network, b.max_backend]) -
    maxFinite([a.max_frontend, a.max_network, a.max_backend]),
  )
  const effectiveLimit = Math.min(limit, MAX_ROWS_PER_TOOL)
  return {
    rows: sorted.slice(0, effectiveLimit).map(redactRow),
    total: sorted.length,
    truncated: sorted.length > effectiveLimit,
    sessionId,
    mapping: { user: mapping.user, action: mapping.actionName },
  }
}

function filterRows({ kind, where = [], limit = 20, file = 'active' }, ctx) {
  const payload = resolveFilePayload(file, ctx)
  const { rows, headers } = payload
  let source
  if (kind === 'action') source = aggregateByAction(rows, headers).rows
  else if (kind === 'widget') source = aggregateByWidget(rows, headers).rows
  else if (kind === 'session') source = aggregateBySession(rows, headers).rows
  else if (kind === 'raw') source = rows
  else throw new Error(`Unknown kind: ${kind}`)

  const filtered = source.filter((r) => where.every((clause) => matchClause(r, clause)))
  const effectiveLimit = Math.min(limit, MAX_ROWS_PER_TOOL)
  const capped = filtered.slice(0, effectiveLimit).map(redactRow)
  return { rows: capped, total: filtered.length, truncated: filtered.length > effectiveLimit }
}

function phaseBreakdown({ kind, name, file = 'active' }, ctx) {
  const payload = resolveFilePayload(file, ctx)
  const { rows, headers } = payload
  const needle = String(name).toLowerCase()
  if (kind === 'action') {
    const { rows: agg } = aggregateByAction(rows, headers)
    const hit = agg.find((r) => String(r.action_name).toLowerCase() === needle)
    if (!hit) return { status: 'not_found', kind, name }
    return {
      status: 'found', kind, name,
      frontend: numOrNull(hit.max_frontend),
      network: numOrNull(hit.max_network),
      backend: numOrNull(hit.max_backend),
    }
  }
  if (kind === 'widget') {
    const { rows: agg } = aggregateByWidget(rows, headers)
    const hit = agg.find((r) =>
      String(r.widget_name).toLowerCase() === needle ||
      String(r.widget_id).toLowerCase() === needle,
    )
    if (!hit) return { status: 'not_found', kind, name }
    return {
      status: 'found', kind, name,
      render: numOrNull(hit.render),
      network: numOrNull(hit.network),
      backend: numOrNull(hit.backend),
      offset: numOrNull(hit.offset),
    }
  }
  throw new Error(`phase_breakdown does not support kind: ${kind}`)
}

/* ——— helpers ——— */

function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function maxFinite(values) {
  let max = -Infinity
  for (const v of values) {
    const n = Number(v)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max === -Infinity ? 0 : max
}

function matchClause(row, { col, op, value }) {
  const v = row?.[col]
  if (v === undefined) return false
  const s = String(v).toLowerCase()
  const t = String(value).toLowerCase()
  const n = Number(v)
  const tn = Number(value)
  switch (op) {
    case '=':  return s === t
    case '!=': return s !== t
    case 'contains': return s.includes(t)
    case '>':  return Number.isFinite(n) && Number.isFinite(tn) && n > tn
    case '>=': return Number.isFinite(n) && Number.isFinite(tn) && n >= tn
    case '<':  return Number.isFinite(n) && Number.isFinite(tn) && n < tn
    case '<=': return Number.isFinite(n) && Number.isFinite(tn) && n <= tn
    default: return false
  }
}

/* ——— registry ——— */

export const tools = [
  {
    name: 'describe_dataset',
    description: 'Returns the loaded files (active, baseline, current) with row counts and column names. Call this FIRST at the start of a conversation so you know which columns exist before writing filters.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: describeDataset,
  },
  {
    name: 'top_regressions',
    description: 'Returns the top N entities whose duration got worse between baseline and current (or active when no dedicated current file is set). Requires a baseline file to be selected.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['action', 'widget', 'session'] },
        n: { type: 'number', description: 'How many to return (max 50).' },
        minPct: { type: 'number', description: 'Minimum delta % to include (e.g. 10 = only ≥10% regressions).' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    run: topRegressions,
  },
  {
    name: 'compare_entity',
    description: 'Returns baseline/current/delta for a single named entity across the two files. Uses active as "current" when no dedicated current file is selected. Requires a baseline file. Case-insensitive name match.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['action', 'widget', 'session'] },
        name: { type: 'string' },
      },
      required: ['kind', 'name'],
      additionalProperties: false,
    },
    run: compareEntity,
  },
  {
    name: 'list_slow',
    description: 'Returns the slowest entities in a file. Use file="active" (default) for the active file or file="baseline" to query the baseline. Filter by phase to find e.g. slow backend actions.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['action', 'widget', 'session'] },
        phase: { type: 'string', enum: ['frontend', 'network', 'backend', 'render', 'total'] },
        threshold: { type: 'number', description: 'Minimum duration (ms) to include.' },
        limit: { type: 'number' },
        file: { type: 'string', enum: ['active', 'baseline'], description: 'Which file to query. Defaults to "active".' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    run: listSlow,
  },
  {
    name: 'get_session_actions',
    description: 'Returns the actions that occurred within a specific session, sorted by max duration. Use when the user asks what a session did or why a session regressed.',
    input_schema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    run: getSessionActions,
  },
  {
    name: 'filter_rows',
    description: 'Generic filter over aggregated entities of a given kind (action|widget|session) or raw rows. Each `where` clause is {col, op, value} where op is =, !=, contains, >, >=, <, <=. Use column names from describe_dataset. Use file="baseline" to query the baseline file instead of active.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['action', 'widget', 'session', 'raw'] },
        where: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              col: { type: 'string' },
              op: { type: 'string', enum: ['=', '!=', 'contains', '>', '>=', '<', '<='] },
              value: {},
            },
            required: ['col', 'op', 'value'],
          },
        },
        limit: { type: 'number' },
        file: { type: 'string', enum: ['active', 'baseline'], description: 'Which file to query. Defaults to "active".' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    run: filterRows,
  },
  {
    name: 'phase_breakdown',
    description: 'Returns the frontend/network/backend (and render/offset for widgets) split for a single named entity. Use file="baseline" to look up the entity in the baseline file.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['action', 'widget'] },
        name: { type: 'string' },
        file: { type: 'string', enum: ['active', 'baseline'], description: 'Which file to query. Defaults to "active".' },
      },
      required: ['kind', 'name'],
      additionalProperties: false,
    },
    run: phaseBreakdown,
  },
]

export function toolsForClaude() {
  return tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }))
}

export function findTool(name) {
  return tools.find((t) => t.name === name)
}
