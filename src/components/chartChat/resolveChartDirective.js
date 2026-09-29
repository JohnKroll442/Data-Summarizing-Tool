/**
 * resolveChartDirective — turn a `​```chart` directive (parsed JSON from an AI
 * answer) into an ECharts option by reusing the tool's own chart builders, so
 * a chat chart is identical to the one the user sees navigating the tool.
 *
 * The LLM never emits numbers or ECharts JSON — only a chart type + how to
 * configure/select it. Everything is resolved here against data the frontend
 * already holds (passed in via ChartDataContext).
 *
 * Two families:
 *   registry — one of the 24 generic CHART_TYPES; dispatched through
 *              getChartType(id).build(rows, config), exactly like ChartGrid.
 *   bespoke  — a builder not in the registry: the action / widget waterfalls
 *              (entity-selected), or the aggRows-shaped action charts.
 *
 * Returns { ok: true, option, title, height } or
 *         { ok: false, reason, detail? } — never throws.
 */

import { getChartType } from '../charts/registry'
import { augmentRowsWithSyntheticMeasures } from '../../lib/syntheticMeasures'
import { applyActionFilter } from '../../lib/drillDown'
import { buildActionSequenceOption, detectMapping } from '../charts/options/actionSequence'
import { buildWidgetTimingOption } from '../charts/options/widgetTiming'
import { buildActionScatterOption } from '../charts/options/actionScatter'
import { buildActionBoxplotOption } from '../charts/options/actionBoxplot'
import { buildActionParetoOption } from '../charts/options/actionPareto'

const AGG_BESPOKE = {
  action_scatter: { build: buildActionScatterOption, label: 'Action phase scatter' },
  action_boxplot: { build: buildActionBoxplotOption, label: 'Action duration spread' },
  action_pareto:  { build: buildActionParetoOption,  label: 'Action Pareto' },
}

export function resolveChartDirective(directive, ctx) {
  if (!directive || typeof directive !== 'object') {
    return { ok: false, reason: 'malformed' }
  }
  const { aggRows = [], rows = [], headers = [], widgetRows = [] } = ctx || {}
  const family = directive.family ||
    (directive.chart ? 'bespoke' : directive.chartType ? 'registry' : null)

  if (family === 'registry') return resolveRegistry(directive, { aggRows, rows, headers, widgetRows })
  if (family === 'bespoke')  return resolveBespoke(directive, { aggRows, rows, headers })
  return { ok: false, reason: 'malformed' }
}

// ── Registry (generic) charts ───────────────────────────────────────────────

function resolveRegistry(directive, { aggRows, rows, headers, widgetRows }) {
  const type = getChartType(directive.chartType)
  if (!type) return { ok: false, reason: 'unknown_chart_type', detail: directive.chartType }

  const sourceRows = pickSource(directive.data, { aggRows, rows, headers, widgetRows })
  if (!sourceRows.length) return { ok: false, reason: 'no_data' }

  const config = directive.config && typeof directive.config === 'object' ? directive.config : {}
  const cols = new Set(Object.keys(sourceRows[0] || {}))

  // Validate the config against the chart's declared fields: required fields
  // must be present, and every column a field references must exist on the
  // chosen data source. Number fields are settings, not columns — skip them.
  for (const field of type.fields) {
    if (field.role === 'number') continue
    const value = config[field.key]
    const missing = value == null || value === '' || (Array.isArray(value) && value.length === 0)
    if (missing) {
      if (field.required) return { ok: false, reason: 'bad_config', detail: `missing ${field.key}` }
      continue
    }
    const refs = Array.isArray(value) ? value : [value]
    for (const ref of refs) {
      if (!cols.has(ref)) return { ok: false, reason: 'bad_config', detail: `unknown column "${ref}" for ${field.key}` }
    }
  }

  try {
    const option = type.build(sourceRows, config)
    return { ok: true, option, title: directive.title || type.label, height: 300 }
  } catch (_) {
    return { ok: false, reason: 'build_error' }
  }
}

function pickSource(data, { aggRows, rows, headers, widgetRows }) {
  if (data === 'raw') return augmentRowsWithSyntheticMeasures(rows, headers).rows
  if (data === 'widgets') return widgetRows
  return aggRows // 'actions' and default
}

// ── Bespoke builders ────────────────────────────────────────────────────────

function resolveBespoke(directive, { aggRows, rows, headers }) {
  const chart = directive.chart

  // aggRows-shaped charts — no selector, they aggregate internally.
  if (AGG_BESPOKE[chart]) {
    if (!aggRows.length) return { ok: false, reason: 'no_data' }
    try {
      const option = AGG_BESPOKE[chart].build(aggRows)
      return { ok: true, option, title: directive.title || AGG_BESPOKE[chart].label, height: 340 }
    } catch (_) {
      return { ok: false, reason: 'build_error' }
    }
  }

  if (chart === 'action_waterfall' || chart === 'widget_waterfall') {
    const aggRow = resolveActionRow(directive.selector, aggRows)
    if (!aggRow) return { ok: false, reason: 'no_action_match', detail: selectorName(directive.selector) }

    const actionRows = applyActionFilter(rows, headers, {
      name: aggRow.action_name,
      timestamp: aggRow._action_timestamp ?? '',
    })
    if (!actionRows.length) return { ok: false, reason: 'no_action_match', detail: aggRow.action_name }

    try {
      if (chart === 'action_waterfall') {
        const option = buildActionSequenceOption(actionRows, { actionDurationMs: aggRow.action_duration })
        return { ok: true, option, title: directive.title || `Action waterfall — ${aggRow.action_name}`, height: waterfallHeight(option) }
      }

      // widget_waterfall — narrow the action's rows to one widget by name.
      const widgetName = directive.selector?.widget_name
      const nameCol = detectMapping(headers).widgetName
      if (!widgetName || !nameCol) return { ok: false, reason: 'no_widget_match', detail: widgetName }
      const widgetRows = actionRows.filter((r) => String(r?.[nameCol] ?? '') === String(widgetName))
      if (!widgetRows.length) return { ok: false, reason: 'no_widget_match', detail: widgetName }
      const option = buildWidgetTimingOption(widgetRows, actionRows)
      return { ok: true, option, title: directive.title || `Widget timing — ${widgetName}`, height: 360 }
    } catch (_) {
      return { ok: false, reason: 'build_error' }
    }
  }

  return { ok: false, reason: 'unknown_chart_type', detail: chart }
}

// Pick the target action's aggregated row from a selector. 'worst_offender'
// (or a { worst_offender: true } object) picks the slowest action; otherwise
// match on action_name, disambiguating by timestamp when given and tie-breaking
// on the longest duration.
function resolveActionRow(selector, aggRows) {
  if (!aggRows.length) return null
  const worst = selector === 'worst_offender' || selector?.worst_offender === true
  if (worst || !selector) {
    return aggRows.reduce((a, b) => (Number(b.action_duration) > Number(a.action_duration) ? b : a))
  }
  const name = selector.action_name
  if (!name) return null
  let matches = aggRows.filter((r) => String(r.action_name) === String(name))
  if (selector.action_timestamp) {
    const exact = matches.filter((r) => String(r._action_timestamp ?? '') === String(selector.action_timestamp))
    if (exact.length) matches = exact
  }
  if (!matches.length) return null
  return matches.reduce((a, b) => (Number(b.action_duration) > Number(a.action_duration) ? b : a))
}

function selectorName(selector) {
  if (!selector || selector === 'worst_offender') return ''
  return selector.action_name || ''
}

// Waterfalls grow a row per phase bar — size the card to the row count so
// bars aren't crushed, within sensible bounds.
function waterfallHeight(option) {
  const count = Array.isArray(option?.yAxis?.data) ? option.yAxis.data.length : 0
  return Math.max(280, Math.min(720, count * 34 + 120))
}
