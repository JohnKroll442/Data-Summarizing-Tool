/**
 * groundtruth_gen.mjs — freeze a bit-exact payload + ground truth from the tool.
 *
 * Runs the REAL src/lib pipeline (the same recipe ActionView.buildPayload uses,
 * with NO filters so scopedRows === rows) over the source CSV that produced the
 * fixed eval dataset. Emits:
 *   - payload.json      : the exact buildAgentPayload output an agent receives
 *   - ground_truth.json : numeric/categorical truths computed from the tool's
 *                         own functions (echo-fields) and from the mesh rows
 *                         (trace/explorer/busiest).
 *
 * Run:  node --import ./backend/skilleval/viteResolveShim.mjs \
 *            backend/skilleval/groundtruth_gen.mjs "<path-to-source.csv>"
 *
 * Faithfulness: the CSV is parsed with the SAME papaparse config as the app
 * (src/lib/parseCsv.js), including header cleaning and trailing-\r strip.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as pathResolve } from 'node:path'
import Papa from 'papaparse'

import { aggregateByAction } from '../../src/lib/actionAggregate.js'
import {
  detectAnomalies,
  buildOffsetDurationPoints,
  summarizeActionFlags,
  ANOMALY_TYPES,
} from '../../src/lib/anomalyDetect.js'

// HEADLINE_KEYS is module-private in anomalyDetect.js; reconstruct it exactly:
// every type NOT in a phase-attribution subgroup (matches isAnomalyFlagged).
const HEADLINE_KEYS = ANOMALY_TYPES.filter((t) => !t.subgroup).map((t) => t.key)
import { actionKpisFromAgg, percentile, sessionKpisFromAgg, widgetKpisFromAgg } from '../../src/lib/kpis.js'
import { aggregateBySession } from '../../src/lib/sessionAggregate.js'
import { aggregateByWidget } from '../../src/lib/widgetAggregate.js'
import { computeRankings, computeBusiest } from '../../src/lib/summary.js'
import { generateInsights } from '../../src/lib/generateInsights.js'
import { buildAgentPayload, buildPerActionWidgetRows } from '../../src/lib/buildAgentPayload.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const THRESHOLDS = { slowActionMs: 120000, healthyCeilingMs: 5000 }
const DATASET_ID = '021587a2-59bf-4e73-a85e-97905f790841'
const FINGERPRINT = { actions: 2070, widgetRows: 14496, worstAction: 'Open story', worstDur: 10368063 }

// ── 1. Parse CSV exactly like src/lib/parseCsv.js (single-pass string parse) ──
function parseCsv(csvPath) {
  const text = readFileSync(csvPath, 'utf8')
  const cleanName = (h) => String(h).replace(/^﻿/, '').replace(/\r$/, '').trim()
  const res = Papa.parse(text, {
    header: true,
    skipEmptyLines: 'greedy',
    dynamicTyping: true,
    delimitersToGuess: [',', '\t', ';', '|'],
    newline: '\n',
  })
  const fields = (res.meta?.fields || []).filter(Boolean)
  const headers = fields.map(cleanName)
  const renames = []
  for (let i = 0; i < fields.length; i++) {
    if (fields[i] !== headers[i]) renames.push([fields[i], headers[i]])
  }
  const rows = res.data || []
  if (renames.length) {
    for (const row of rows) {
      for (const [raw, clean] of renames) {
        const v = row[raw]
        row[clean] = typeof v === 'string' && v.endsWith('\r') ? v.slice(0, -1) : v
        delete row[raw]
      }
    }
  }
  return { headers, rows }
}

// ── 2. Run the full ActionView pipeline (no filters → scopedRows === rows) ────
function runPipeline(rows, headers, fileName) {
  const anomalies = detectAnomalies(rows, headers, THRESHOLDS)
  const { mapping, rows: aggRows } = aggregateByAction(rows, headers)

  const { rows: sessionAggRows, mapping: sessionMapping } = aggregateBySession(rows, headers)
  const sessionKpis = sessionKpisFromAgg(sessionAggRows, sessionMapping)

  const { rows: widgetAggRows, mapping: widgetMapping } = aggregateByWidget(rows, headers)
  const widgetKpis = widgetKpisFromAgg(widgetAggRows, widgetMapping)

  const rankings = computeRankings(rows, headers)
  const busiest = computeBusiest(rows, headers)

  const actionKpis = actionKpisFromAgg(aggRows, mapping, THRESHOLDS)

  const keys = aggRows.map((r) => `${r.action_name}::${r._action_timestamp ?? ''}`)
  const filteredSummary = summarizeActionFlags(keys, anomalies.byActionKey)
  const filteredAnomalyRows = anomalies.rows ?? []
  const insights = generateInsights({
    anomalies, filteredSummary, filteredAnomalyRows, kpis: actionKpis, thresholds: THRESHOLDS,
  })

  const offsetDuration = buildOffsetDurationPoints(rows, headers, THRESHOLDS)
  const widgetRows = buildPerActionWidgetRows(rows, headers)

  const payload = buildAgentPayload({
    aggRows, mapping, anomalies, kpis: actionKpis, thresholds: THRESHOLDS, fileName,
    sessionAggRows, sessionKpis,
    widgetAggRows, widgetKpis,
    rankings, busiest,
    insights,
    offsetDuration,
  })

  return { anomalies, mapping, aggRows, filteredSummary, actionKpis, widgetRows, payload }
}

// ── 3. Derive ground truth from the tool's own outputs + mesh rows ────────────
function deriveGroundTruth({ anomalies, aggRows, filteredSummary, widgetRows }) {
  const durations = aggRows.map((r) => r.action_duration)
  const finite = durations.filter((d) => Number.isFinite(Number(d))).map(Number)

  // stats (echo-fields): the tool's own percentile + threshold count
  const kpi_p90 = percentile(durations, 0.9)
  const kpi_p95 = percentile(durations, 0.95)
  const kpi_median = percentile(durations, 0.5)
  const kpi_over_threshold = finite.filter((d) => d >= THRESHOLDS.slowActionMs).length

  // anomaly (echo-fields) — summarizeActionFlags already tallied the subset
  const counts = filteredSummary?.counts ?? {}
  const anomaly_headline_types = HEADLINE_KEYS.filter((k) => (counts[k]?.actions ?? 0) > 0)
  const anomaly_flagged_count = filteredSummary?.totalFlagged?.actions ?? 0
  const anomaly_flagged_pct = Math.round((filteredSummary?.totalFlagged?.pct ?? 0) * 100)

  // explorer: top user by frequency (one aggRow == one action instance)
  const userCounts = new Map()
  for (const r of aggRows) {
    const u = r.user ?? r.user_name ?? ''
    if (u === '' || u == null) continue
    userCounts.set(u, (userCounts.get(u) ?? 0) + 1)
  }
  const top_user_by_frequency = [...userCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([group, count]) => ({ group, count }))

  // explorer: busiest absolute hour (per README: tool buckets by absolute hour)
  const hourCounts = new Map()
  for (const r of aggRows) {
    const ts = r.action_timestamp ?? r._action_timestamp
    if (!ts) continue
    const d = new Date(ts)
    if (Number.isNaN(d.getTime())) continue
    const hourKey = ts.slice(0, 13) // "YYYY-MM-DDTHH" style prefix
    hourCounts.set(hourKey, (hourCounts.get(hourKey) ?? 0) + 1)
  }
  const busiest_hour = [...hourCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  // trace: bottleneck widget in the worst (max-duration) action
  const worst = aggRows.reduce((m, r) =>
    (Number(r.action_duration) > Number(m?.action_duration ?? -Infinity) ? r : m), null)
  const worstKey = worst ? `${worst.action_name}::${worst._action_timestamp ?? ''}` : null
  const worstWidgets = widgetRows.filter((w) => w.action_key === worstKey)
  const bottleneck = worstWidgets.reduce((m, w) =>
    (Number(w.total) > Number(m?.total ?? -Infinity) ? w : m), null)
  let dominant_phase = null
  if (bottleneck) {
    const phases = { render: Number(bottleneck.render) || 0, network: Number(bottleneck.network) || 0, backend: Number(bottleneck.backend) || 0 }
    dominant_phase = Object.entries(phases).sort((a, b) => b[1] - a[1])[0][0]
  }

  return {
    dataset_id: DATASET_ID,
    kpi_p90, kpi_p95, kpi_median, kpi_over_threshold,
    anomaly_flagged_count, anomaly_flagged_pct, anomaly_headline_types,
    root_cause_categories: anomaly_headline_types, // proxy; prose is judge-scored
    top_user_by_frequency,
    busiest_hour,
    bottleneck_widget_worst_action: bottleneck?.widget_name ?? null,
    bottleneck_dominant_phase: dominant_phase,
    worst_action: { name: worst?.action_name ?? null, action_key: worstKey, duration_ms: Number(worst?.action_duration) },
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
const csvPath = process.argv[2]
if (!csvPath) {
  console.error('Usage: groundtruth_gen.mjs <path-to-source.csv>')
  process.exit(1)
}
console.error(`[gen] parsing ${csvPath} …`)
const { headers, rows } = parseCsv(csvPath)
console.error(`[gen] parsed: ${rows.length} raw rows, ${headers.length} columns`)

const fileName = csvPath.split(/[\\/]/).pop()
const { anomalies, mapping, aggRows, filteredSummary, actionKpis, widgetRows, payload } =
  runPipeline(rows, headers, fileName)

// ── debug dump (first run: verify shapes before trusting the truth) ──
console.error('[gen] SHAPES:')
console.error('  aggRows:', aggRows.length, '| widgetRows:', widgetRows.length)
console.error('  filteredSummary keys:', Object.keys(filteredSummary || {}))
console.error('  filteredSummary.counts:', JSON.stringify(filteredSummary?.counts))
console.error('  actionKpis:', JSON.stringify(actionKpis))
console.error('  payload top keys:', Object.keys(payload || {}))
console.error('  HEADLINE_KEYS:', JSON.stringify(HEADLINE_KEYS))

// ── fingerprint check ──
const worst = aggRows.reduce((m, r) =>
  (Number(r.action_duration) > Number(m?.action_duration ?? -Infinity) ? r : m), null)
console.error('[gen] worst action:', worst?.action_name, Number(worst?.action_duration))
const fpOk =
  aggRows.length === FINGERPRINT.actions &&
  widgetRows.length === FINGERPRINT.widgetRows &&
  worst?.action_name === FINGERPRINT.worstAction &&
  Math.round(Number(worst?.action_duration)) === FINGERPRINT.worstDur
console.error(`[gen] fingerprint ${fpOk ? 'MATCH ✓' : 'MISMATCH ✗'} (expected ${FINGERPRINT.actions}/${FINGERPRINT.widgetRows}/${FINGERPRINT.worstAction}/${FINGERPRINT.worstDur})`)

const groundTruth = deriveGroundTruth({ anomalies, aggRows, filteredSummary, widgetRows })
console.error('[gen] GROUND TRUTH:', JSON.stringify(groundTruth, null, 2))

// ── write outputs (into a real payload the rollout will POST) ──
const payloadOut = { schema_version: payload.schema_version, dataset_id: DATASET_ID, ...payload }
writeFileSync(pathResolve(__dirname, 'payload.json'), JSON.stringify(payloadOut, null, 2))
writeFileSync(pathResolve(__dirname, 'ground_truth.json'), JSON.stringify(groundTruth, null, 2))
writeFileSync(pathResolve(__dirname, 'mesh_widget_rows.json'), JSON.stringify(widgetRows))
console.error('[gen] wrote payload.json, ground_truth.json, mesh_widget_rows.json')
