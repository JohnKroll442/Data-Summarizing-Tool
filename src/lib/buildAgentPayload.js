import { aggregateByWidget } from './widgetAggregate'
import { findActionNameKey, findActionTimestampKey } from './drillDown'
import { buildTimeOfDayTrend } from './timeOfDayTrend'
import { buildStoryActionMatrix } from './storyActionMatrix'

/**
 * buildAgentPayload — serializes the tool's computed state into the structured
 * JSON payload read by AI Core agents.
 *
 * Schema version 1.0 — matches the Orchestrator skill's "How Context Arrives"
 * section and the individual agent input contracts.
 *
 * ─── Usage ────────────────────────────────────────────────────────────────────
 *
 *   import { buildAgentPayload } from '../lib/buildAgentPayload'
 *
 *   // Inside ActionView (all inputs already computed as useMemo values):
 *   const payload = buildAgentPayload({
 *     aggRows,      // aggregateByAction(scopedRows, headers).rows
 *     mapping,      // aggregateByAction(scopedRows, headers).mapping
 *     anomalies,    // detectAnomalies(scopedRows, headers, thresholds)
 *     kpis,         // actionKpisFromAgg(aggRows, mapping, thresholds)
 *     thresholds,   // from useCsvData()
 *     fileName,     // from useCsvData()
 *   })
 *
 * ─── Payload structure ────────────────────────────────────────────────────────
 *
 *   {
 *     schema_version  "1.0"
 *     meta            { file_name, generated_at, scope, slow_action_threshold_ms }
 *     kpis            [ { key, label, value } ]
 *     anomalies       { total_actions, total_flagged, counts, flagged_actions, flagged_by_type }
 *     data_summary    { total_actions, total_unique_users, total_unique_stories,
 *                       total_unique_action_types, by_user[], by_story[], by_action[] }
 *   }
 *
 * ─── data_summary note ───────────────────────────────────────────────────────
 *
 *   by_user[], by_story[], by_action[] are COMPLETE lists — all entities, no
 *   top-N cap. Arrays are sorted by action_count descending so the Explorer
 *   Agent can read rankings directly without re-sorting.
 *
 *   For row-level detail (specific user's actions, duration-filtered rows), the
 *   Explorer Agent calls GET /api/actions on the backend. That endpoint is the
 *   companion to this payload — it serves filtered aggRows on demand so large
 *   datasets never need to travel inside the LLM context.
 */

/**
 * Build the full agent payload from already-computed aggregation outputs.
 *
 * @param {object}   params
 * @param {object[]} params.aggRows    aggRows from aggregateByAction().rows
 * @param {object}   params.mapping    mapping from aggregateByAction()
 * @param {object}   params.anomalies  result of detectAnomalies()
 * @param {object[]} params.kpis       result of actionKpisFromAgg()
 * @param {object}   params.thresholds { slowActionMs, healthyCeilingMs }
 * @param {string}   params.fileName   name of the uploaded CSV file
 * @returns {object} Serializable payload object (JSON-safe)
 */
export function buildAgentPayload({
  aggRows, mapping, anomalies, kpis, thresholds, fileName,
  // Session View
  sessionAggRows, sessionKpis,
  // Widget View
  widgetAggRows, widgetKpis,
  // Summary View
  rankings, busiest,
  // Insights panel
  insights,
  // Chart-parity summaries (time-of-day trend, story×action, offset vs duration)
  offsetDuration,
}) {
  return {
    schema_version: '1.1',
    meta:            buildMeta(fileName, thresholds),
    kpis:            buildKpis(kpis),
    anomalies:       buildAnomalies(anomalies),
    data_summary:    buildDataSummary(aggRows, thresholds),
    session_summary: buildSessionSummary(sessionAggRows, sessionKpis, thresholds),
    widget_summary:  buildWidgetSummary(widgetAggRows, widgetKpis),
    summary_view:    buildSummaryView(rankings, busiest),
    insights:        buildInsights(insights),
    time_summary:        buildTimeSummary(aggRows),
    story_action_matrix: buildStoryActionMatrixSummary(aggRows),
    offset_summary:      buildOffsetSummary(offsetDuration),
  }
}

/* ─── meta ──────────────────────────────────────────────────────────────────── */

function buildMeta(fileName, thresholds) {
  return {
    file_name:                fileName ?? 'unknown',
    generated_at:             new Date().toISOString(),
    scope:                    'all_views',
    slow_action_threshold_ms: thresholds?.slowActionMs ?? 120000,
    healthy_ceiling_ms:       thresholds?.healthyCeilingMs ?? 5000,
  }
}

/* ─── kpis ──────────────────────────────────────────────────────────────────── */

/**
 * Pass the kpis array from actionKpisFromAgg() directly — keys come from the
 * KPI builder (e.g. 'total_actions', 'median_duration', 'p90_duration').
 * We add a slugified fallback key for any tile that was added without one.
 */
function buildKpis(kpis) {
  if (!Array.isArray(kpis)) return []
  return kpis.map((k) => ({
    key:   k.key   ?? slugify(k.label),
    label: k.label ?? '',
    value: k.value ?? '',
  }))
}

/* ─── anomalies ─────────────────────────────────────────────────────────────── */

/**
 * Serialize detectAnomalies() output into the payload anomalies block.
 *
 * Input shape (from anomalyDetect.js):
 *   anomalies.rows          — one row per flagged action instance
 *   anomalies.counts        — { <type_key>: { actions, pct } }
 *   anomalies.totalFlagged  — { actions, pct }
 *   anomalies.totalActions  — total action count before flagging
 *
 * Output shape:
 *   anomalies.counts        — same, with pcts rounded to 1 decimal %
 *   anomalies.flagged_actions — serialized flagged rows
 *   anomalies.flagged_by_type — flagged rows grouped by anomaly type key
 */
function buildAnomalies(anomalies) {
  if (!anomalies) {
    return {
      total_actions:   0,
      total_flagged:   { actions: 0, pct: 0 },
      counts:          {},
      flagged_actions: [],
      flagged_by_type: {},
    }
  }

  const { rows = [], counts = {}, totalFlagged, totalActions = 0 } = anomalies

  // counts — same structure, pct converted to rounded % value (0.0756 → 7.6)
  const countsOut = {}
  for (const [key, val] of Object.entries(counts)) {
    countsOut[key] = {
      actions: val.actions ?? 0,
      pct:     roundPct(val.pct),
    }
  }

  // flagged_actions — one entry per flagged action
  const flaggedActions = rows.map((r) => ({
    session_id:         r.session_id         ?? '',
    user:               r.user               ?? '',
    story_name:         r.story_name         ?? '',
    action_name:        r.action_name        ?? '',
    action_duration_ms: toMs(r.action_duration),
    action_timestamp:   r.action_timestamp   ?? r._action_timestamp ?? '',
    anomaly_types:      Array.isArray(r.flags) ? r.flags.map((f) => f.type) : [],
  }))

  // flagged_by_type — index flagged_actions by each anomaly type key
  // Enables agents to look up "all straggler actions" directly.
  const flaggedByType = {}
  for (const action of flaggedActions) {
    for (const type of action.anomaly_types) {
      if (!flaggedByType[type]) flaggedByType[type] = []
      flaggedByType[type].push({
        user:               action.user,
        action_name:        action.action_name,
        story_name:         action.story_name,
        session_id:         action.session_id,
        action_duration_ms: action.action_duration_ms,
        action_timestamp:   action.action_timestamp,
      })
    }
  }

  return {
    total_actions: totalActions,
    total_flagged: {
      actions: totalFlagged?.actions ?? 0,
      pct:     roundPct(totalFlagged?.pct),
    },
    counts:          countsOut,
    flagged_actions: flaggedActions,
    flagged_by_type: flaggedByType,
  }
}

/* ─── data_summary ──────────────────────────────────────────────────────────── */

/**
 * Build the full-dataset frequency summary from aggRows.
 *
 * All entities are included — no top-N cap. The Explorer Agent reads these
 * arrays directly for ranking answers. For row-level detail it calls the
 * backend's GET /api/actions endpoint instead.
 *
 * by_user[], by_story[], by_action[] are sorted by action_count descending
 * so the Explorer Agent can read [0] as the most frequent without re-sorting.
 */
function buildDataSummary(aggRows, thresholds) {
  const slowMs = thresholds?.slowActionMs ?? 120000

  if (!Array.isArray(aggRows) || aggRows.length === 0) {
    return {
      total_actions:              0,
      total_unique_users:         0,
      total_unique_stories:       0,
      total_unique_action_types:  0,
      actions_over_threshold:     0,
      slow_action_threshold_ms:   slowMs,
      by_user:   [],
      by_story:  [],
      by_action: [],
    }
  }

  const total = aggRows.length

  // Each map entry accumulates { count, totalMs, maxMs, overThreshold }
  // so we can derive avg, max and over-threshold counts in one pass.
  const userStats   = new Map()
  const storyStats  = new Map()
  const actionStats = new Map()
  let datasetOverThreshold = 0

  const inc = (map, key, durMs) => {
    if (!map.has(key)) map.set(key, { count: 0, totalMs: 0, maxMs: 0, overThreshold: 0 })
    const s = map.get(key)
    s.count += 1
    if (Number.isFinite(durMs)) {
      s.totalMs += durMs
      if (durMs > s.maxMs) s.maxMs = durMs
      if (durMs >= slowMs) s.overThreshold += 1
    }
  }

  for (const r of aggRows) {
    const u   = r.user        ?? ''
    const s   = r.story_name  ?? ''
    const a   = r.action_name ?? ''
    const dur = toMs(r.action_duration)   // ms; 0 for missing/unparseable
    const durMs = Number.isFinite(Number(r.action_duration)) ? dur : NaN
    if (durMs >= slowMs) datasetOverThreshold += 1
    inc(userStats,   u, durMs)
    inc(storyStats,  s, durMs)
    inc(actionStats, a, durMs)
  }

  /**
   * Convert a stats Map → sorted array with frequency and duration metrics.
   * @param {Map<string,{count,totalMs,maxMs,overThreshold}>} map
   * @param {string} entityKey  field name for the entity value
   */
  const toSortedArray = (map, entityKey) =>
    [...map.entries()]
      .map(([val, s]) => ({
        [entityKey]:          val,
        action_count:         s.count,
        pct_of_total:         roundPct(s.count / total),
        total_duration_ms:    s.totalMs,
        avg_duration_ms:      s.count > 0 ? Math.round(s.totalMs / s.count) : 0,
        max_duration_ms:      s.maxMs,
        actions_over_threshold: s.overThreshold,
      }))
      .sort((a, b) => b.action_count - a.action_count)

  return {
    total_actions:             total,
    total_unique_users:        userStats.size,
    total_unique_stories:      storyStats.size,
    total_unique_action_types: actionStats.size,
    actions_over_threshold:    datasetOverThreshold,
    slow_action_threshold_ms:  slowMs,
    by_user:   toSortedArray(userStats,   'user'),
    by_story:  toSortedArray(storyStats,  'story_name'),
    by_action: toSortedArray(actionStats, 'action_name'),
  }
}

/* ─── helpers ───────────────────────────────────────────────────────────────── */

/**
 * Convert a raw duration value (ms, possibly a string) to a rounded integer.
 * Returns 0 for non-finite values so the payload stays clean JSON.
 */
function toMs(val) {
  const n = Number(val)
  return Number.isFinite(n) ? Math.round(n) : 0
}

/**
 * Convert a fraction (0–1) to a rounded percentage with one decimal place.
 * Example: 0.0756 → 7.6,  0.1 → 10.0,  undefined → 0
 */
function roundPct(val) {
  const n = Number(val)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 1000) / 10
}

/* ─── session_summary ────────────────────────────────────────────────────── */

/**
 * Serialize aggregateBySession() rows into the payload session_summary block.
 * Includes session-level KPIs and per-user / per-story session statistics.
 */
function buildSessionSummary(sessionAggRows, sessionKpis, thresholds) {
  const empty = {
    total_sessions:      0,
    total_unique_users:  0,
    total_unique_stories: 0,
    kpis:                [],
    by_user:             [],
    by_story:            [],
    slowest_sessions:    [],
  }
  if (!Array.isArray(sessionAggRows) || sessionAggRows.length === 0) return empty

  const slowMs = thresholds?.slowActionMs ?? 120000

  // Per-user stats
  const userMap = new Map()
  const storyMap = new Map()
  for (const s of sessionAggRows) {
    const u = s.user  ?? ''
    const st = s.story ?? ''
    const dur = toMs(s.total_action_duration)
    if (!userMap.has(u)) userMap.set(u, { count: 0, totalMs: 0, maxMs: 0, overThreshold: 0 })
    if (!storyMap.has(st)) storyMap.set(st, { count: 0, totalMs: 0, maxMs: 0, overThreshold: 0 })
    const ue = userMap.get(u);  ue.count++; ue.totalMs += dur; if (dur > ue.maxMs) ue.maxMs = dur; if (dur >= slowMs) ue.overThreshold++
    const se = storyMap.get(st); se.count++; se.totalMs += dur; if (dur > se.maxMs) se.maxMs = dur; if (dur >= slowMs) se.overThreshold++
  }

  const toArr = (map, key) =>
    [...map.entries()]
      .map(([val, s]) => ({
        [key]:              val,
        session_count:      s.count,
        total_duration_ms:  s.totalMs,
        avg_duration_ms:    s.count > 0 ? Math.round(s.totalMs / s.count) : 0,
        max_duration_ms:    s.maxMs,
        slow_sessions:      s.overThreshold,
      }))
      .sort((a, b) => b.session_count - a.session_count)

  // Top 20 slowest individual sessions
  const slowest = [...sessionAggRows]
    .map((s) => ({
      session_id:         s.session   ?? '',
      user:               s.user      ?? '',
      story:              s.story     ?? '',
      total_duration_ms:  toMs(s.total_action_duration),
      max_action_ms:      toMs(s.max_action_duration),
      action_count:       s.action_count ?? 0,
      timestamp:          s.timestamp_range ?? '',
    }))
    .sort((a, b) => b.total_duration_ms - a.total_duration_ms)
    .slice(0, 20)

  const uniqueStories = new Set(sessionAggRows.map((s) => s.story ?? ''))

  return {
    total_sessions:       sessionAggRows.length,
    total_unique_users:   userMap.size,
    total_unique_stories: uniqueStories.size,
    kpis:                 Array.isArray(sessionKpis) ? sessionKpis.map((k) => ({ label: k.label ?? '', value: k.value ?? '' })) : [],
    by_user:              toArr(userMap,  'user'),
    by_story:             toArr(storyMap, 'story'),
    slowest_sessions:     slowest,
  }
}

/* ─── widget_summary ─────────────────────────────────────────────────────── */

/**
 * Serialize aggregateByWidget() rows into the payload widget_summary block.
 * Includes widget-level KPIs, top-10 widgets per phase, and dataset-wide phase stats.
 */
function buildWidgetSummary(widgetAggRows, widgetKpis) {
  const empty = {
    total_unique_widgets: 0,
    kpis:                 [],
    phase_stats:          {},
    top_by_render:        [],
    top_by_backend:       [],
    top_by_network:       [],
    top_by_total:         [],
  }
  if (!Array.isArray(widgetAggRows) || widgetAggRows.length === 0) return empty

  const phaseKeys = ['render', 'network', 'backend', 'offset', 'total']
  const phaseStats = {}
  for (const p of phaseKeys) {
    const vals = widgetAggRows.map((w) => toMs(w[p])).filter((v) => v > 0)
    if (!vals.length) { phaseStats[p] = { avg_ms: 0, max_ms: 0, p95_ms: 0 }; continue }
    vals.sort((a, b) => a - b)
    phaseStats[p] = {
      avg_ms: Math.round(vals.reduce((s, v) => s + v, 0) / vals.length),
      max_ms: vals[vals.length - 1],
      p95_ms: vals[Math.floor(vals.length * 0.95)] ?? vals[vals.length - 1],
    }
  }

  const widgetRow = (w) => ({
    widget_id:   w.widget_id   ?? '',
    widget_name: w.widget_name ?? '',
    render_ms:   toMs(w.render),
    network_ms:  toMs(w.network),
    backend_ms:  toMs(w.backend),
    offset_ms:   toMs(w.offset),
    total_ms:    toMs(w.total),
  })

  const top = (phase) =>
    [...widgetAggRows]
      .filter((w) => toMs(w[phase]) > 0)
      .sort((a, b) => toMs(b[phase]) - toMs(a[phase]))
      .slice(0, 10)
      .map(widgetRow)

  return {
    total_unique_widgets: widgetAggRows.length,
    kpis:                 Array.isArray(widgetKpis) ? widgetKpis.map((k) => ({ label: k.label ?? '', value: k.value ?? '' })) : [],
    phase_stats:          phaseStats,
    top_by_render:        top('render'),
    top_by_backend:       top('backend'),
    top_by_network:       top('network'),
    top_by_total:         top('total'),
  }
}

/* ─── summary_view ───────────────────────────────────────────────────────── */

/**
 * Serialize computeRankings() + computeBusiest() into the payload summary_view block.
 */
function buildSummaryView(rankings, busiest) {
  const empty = { rankings: { slowest: [], fastest: [] }, busiest: null }
  if (!rankings && !busiest) return empty

  const serializeCategory = (cat) => ({
    id:    cat.id    ?? '',
    title: cat.title ?? '',
    view:  cat.view  ?? '',
    items: (cat.items ?? []).slice(0, 10).map((item) => ({
      label:    item.label    ?? '',
      sublabel: item.sublabel ?? '',
      value_ms: toMs(item.value),
    })),
  })

  const slowest = (rankings?.slowest ?? []).map(serializeCategory)
  const fastest = (rankings?.fastest ?? []).map(serializeCategory)

  const serializePeriod = (p) => p ? { label: p.label, count: p.count } : null

  return {
    rankings: { slowest, fastest },
    busiest: busiest ? {
      day:   serializePeriod(busiest.day),
      week:  serializePeriod(busiest.week),
      month: serializePeriod(busiest.month),
    } : null,
  }
}

/* ─── insights ───────────────────────────────────────────────────────────── */

/**
 * Serialize generateInsights() output into the payload insights block.
 */
function buildInsights(insights) {
  if (!insights) return null
  return {
    headline:      insights.headline      ?? '',
    kpi_line:      insights.kpiLine       ?? '',
    recommendation: insights.recommendation ?? '',
    top_issues:    (insights.topIssues ?? []).map((i) => ({
      key:   i.key   ?? '',
      label: i.label ?? '',
      count: i.count ?? 0,
      pct:   i.pct   ?? 0,
    })),
    worst_offender: insights.worstOffender ? {
      action_name:  insights.worstOffender.actionName  ?? '',
      story:        insights.worstOffender.story        ?? '',
      duration_ms:  toMs(insights.worstOffender.duration),
      flag_labels:  insights.worstOffender.flagLabels  ?? [],
    } : null,
  }
}

/* ─── per-action widget rows for trace agent ─────────────────────────────── */

/**
 * Build per-action widget rows for the trace agent.
 *
 * aggregateByWidget() merges widgets GLOBALLY across the dataset — a widget_id
 * appearing in 5 actions becomes ONE row with max values. The trace agent needs
 * per-action data: what each widget did within a SPECIFIC action.
 *
 * This function groups raw rows by action key (name::timestamp), runs
 * aggregateByWidget on each group, and tags every widget row with its parent
 * action_key so GET /api/widgets can filter by action.
 *
 * @param {object[]} rows     Raw scoped CSV rows (NOT aggRows)
 * @param {string[]} headers  CSV header names
 * @returns {object[]}        Flat array of widget rows, each with action_key
 */
export function buildPerActionWidgetRows(rows, headers) {
  if (!rows?.length || !headers?.length) return []

  const actionNameKey = findActionNameKey(headers)
  const actionTsKey   = findActionTimestampKey(headers)
  if (!actionNameKey) return []

  // Group raw rows by action key — same composite key the detector uses
  const groups = new Map()
  for (const row of rows) {
    const name = row?.[actionNameKey]
    if (name === undefined || name === null || name === '') continue
    const ts = actionTsKey ? (row?.[actionTsKey] ?? '') : ''
    const key = `${name}::${ts}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  // For each action, aggregate its widgets and tag with action_key
  const out = []
  for (const [actionKey, groupRows] of groups) {
    const { rows: widgetRows } = aggregateByWidget(groupRows, headers)
    for (const w of widgetRows) {
      out.push({
        action_key:    actionKey,
        widget_id:     w.widget_id     ?? '',
        widget_name:   w.widget_name   ?? '',
        session_id:    w.session_id    ?? '',
        render:        w.render,
        network:       w.network,
        backend:       w.backend,
        offset:        w.offset,
        total:         w.total,
        render_start:  w.render_start  ?? '',
        render_end:    w.render_end    ?? '',
        network_start: w.network_start ?? '',
        network_end:   w.network_end   ?? '',
        backend_start: w.backend_start ?? '',
        backend_end:   w.backend_end   ?? '',
      })
    }
  }
  return out
}

/* ─── time_summary (time-of-day / activity trend) ─────────────────────────── */

/**
 * Per-bucket action counts with p50/p90, from buildTimeOfDayTrend(aggRows) —
 * the same computation behind the "time of day trend" chart. The chart's heavy
 * per-bucket `instances` arrays are stripped; the agent gets one compact row
 * per time bucket. Precise hour-by-hour / per-day drilldowns for a specific
 * user/story/date are answered on demand by the backend query_engine.
 */
function buildTimeSummary(aggRows) {
  const trend = buildTimeOfDayTrend(aggRows)
  if (!trend?.hasData) return { has_data: false, buckets: [] }
  return {
    has_data:      true,
    granularity:   trend.granularity ?? null,
    total_actions: trend.totalActions ?? 0,
    buckets: (trend.buckets ?? []).slice(0, 60).map((b) => ({
      label:     b.fullLabel ?? b.label ?? '',
      count:     b.count ?? 0,
      p50_ms:    b.p50 != null ? Math.round(b.p50) : null,
      p90_ms:    b.p90 != null ? Math.round(b.p90) : null,
    })),
  }
}

/* ─── story_action_matrix (story × action durations) ──────────────────────── */

/**
 * Top story×action cells by duration, from buildStoryActionMatrix(aggRows) —
 * the data behind the story × action heatmap. Flattened to a ranked list so
 * the agent can answer "which story/action combinations are slowest" without
 * the full stories × actions grid.
 */
function buildStoryActionMatrixSummary(aggRows) {
  const matrix = buildStoryActionMatrix(aggRows)
  const cells = []
  for (const cell of matrix.cells?.values?.() ?? []) {
    const first = cell.instances?.[0]
    if (!first) continue
    cells.push({
      story:       first.story_name ?? '',
      action:      first.action_name ?? '',
      duration_ms: cell.duration != null ? Math.round(cell.duration) : null,
      count:       cell.count ?? 0,
    })
  }
  cells.sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))
  return {
    total_stories: matrix.stories?.length ?? 0,
    total_actions: matrix.actions?.length ?? 0,
    top_cells:     cells.slice(0, 30),
  }
}

/* ─── offset_summary (offset vs duration) ─────────────────────────────────── */

/**
 * Offset-vs-duration classification counts + the worst overruns, from the
 * buildOffsetDurationPoints() result already computed by the view. Gives the
 * agent the offset outlier picture (ok / large / overrun) and the specific
 * actions whose widget offset is large relative to their duration.
 */
function buildOffsetSummary(offsetDuration) {
  if (!offsetDuration?.points?.length) {
    return { counts: { ok: 0, large: 0, overrun: 0 }, top_overruns: [] }
  }
  const outliers = offsetDuration.points
    .filter((p) => p.klass && p.klass !== 'ok')
    .sort((a, b) => (b.maxOffset ?? 0) - (a.maxOffset ?? 0))
    .slice(0, 15)
    .map((p) => ({
      action:        p.action ?? '',
      story:         p.story ?? '',
      user:          p.user ?? '',
      duration_ms:   p.duration != null ? Math.round(p.duration) : null,
      max_offset_ms: p.maxOffset != null ? Math.round(p.maxOffset) : null,
      klass:         p.klass,
    }))
  return {
    counts:          offsetDuration.counts ?? { ok: 0, large: 0, overrun: 0 },
    large_offset_ms: Number.isFinite(offsetDuration.largeOffsetMs) ? Math.round(offsetDuration.largeOffsetMs) : null,
    top_overruns:    outliers,
  }
}

/**
 * Turn a human label into a snake_case key, e.g.
 * "Median duration" → "median_duration"
 * Used only when a kpi tile was added without an explicit `key` field.
 */
function slugify(label) {
  return (label ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
}
