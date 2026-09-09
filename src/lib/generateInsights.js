/**
 * generateInsights — pure, dependency-free function that turns raw anomaly /
 * KPI data into plain-language sentences for the ActionInsightSummary card
 * and the exported PDF report.
 *
 * Deliberately kept out of React so it can be called from both a component
 * and the report-export utility without triggering re-render cycles.
 */

import { ANOMALY_TYPES } from './anomalyDetect'
import { formatDurationMs, formatCount } from './format'

// The 7 headline types (excludes the 3 phase-attribution sub-types that are
// deliberately excluded from the "any anomaly" total).
const HEADLINE_TYPES = ANOMALY_TYPES.filter((t) => !t.subgroup)

/**
 * @param {object} opts
 * @param {object} opts.anomalies        Full detectAnomalies() output (for .rows, .byActionKey)
 * @param {object} opts.filteredSummary  summarizeActionFlags() over the current view (for counts)
 * @param {Array}  opts.kpis             actionKpisFromAgg() output
 * @param {object} [opts.thresholds]     { slowActionMs, … }
 *
 * @returns {{
 *   headline:       string,
 *   topIssues:      Array<{ key, label, count, pct }>,
 *   kpiLine:        string,
 *   worstOffender:  { actionName, story, duration, flagLabels } | null,
 *   recommendation: string,
 * }}
 */
export function generateInsights({ anomalies, filteredSummary, filteredAnomalyRows, kpis, thresholds }) {
  // Prefer the filtered/visible summary for counts; fall back to full scope.
  const summary = filteredSummary ?? anomalies
  const { totalFlagged, totalActions, counts } = summary ?? {}

  // ── Headline ─────────────────────────────────────────────────────────────
  const flaggedCount = totalFlagged?.actions ?? 0
  const pct = Math.round((totalFlagged?.pct ?? 0) * 100)

  let headline
  if (!totalActions || totalActions === 0) {
    headline = 'No actions in the current view.'
  } else if (flaggedCount === 0) {
    headline = `No performance anomalies detected across ${formatCount(totalActions)} action${totalActions === 1 ? '' : 's'}.`
  } else {
    headline = `${formatCount(flaggedCount)} of ${formatCount(totalActions)} action${totalActions === 1 ? '' : 's'} (${pct}%) had performance anomalies.`
  }

  // ── Top issues (sorted by count, top 3) ──────────────────────────────────
  const topIssues = HEADLINE_TYPES
    .map((t) => ({
      key:   t.key,
      label: t.label,
      count: counts?.[t.key]?.actions ?? 0,
      pct:   Math.round((counts?.[t.key]?.pct ?? 0) * 100),
    }))
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)

  // ── KPI summary line ─────────────────────────────────────────────────────
  const medianKpi = kpis?.find((k) => k.label?.toLowerCase().includes('median'))
  const p90Kpi    = kpis?.find((k) => k.label?.startsWith('p90'))
  const p95Kpi    = kpis?.find((k) => k.label?.startsWith('p95'))
  const parts = []
  if (medianKpi?.value && medianKpi.value !== '—') parts.push(`median ${medianKpi.value}`)
  if (p90Kpi?.value    && p90Kpi.value    !== '—') parts.push(`p90 ${p90Kpi.value}`)
  if (p95Kpi?.value    && p95Kpi.value    !== '—') parts.push(`p95 ${p95Kpi.value}`)
  const kpiLine = parts.length > 0 ? `Action durations: ${parts.join(' · ')}.` : ''

  // ── Worst offender (slowest anomalous action in the current filtered view) ──
  // Prefer filteredAnomalyRows (scoped to active filters) so the worst offender
  // always matches what the user is currently looking at.
  const rowPool = (filteredAnomalyRows?.length ? filteredAnomalyRows : anomalies?.rows) ?? []
  const worstRow = rowPool
    .filter((r) => Number.isFinite(r.action_duration) && r.action_duration > 0)
    .sort((a, b) => b.action_duration - a.action_duration)[0]

  let worstOffender = null
  if (worstRow) {
    const flagLabels = (worstRow.flags ?? [])
      .filter((f) => !ANOMALY_TYPES.find((t) => t.key === f.type)?.subgroup)
      .map((f) => ANOMALY_TYPES.find((t) => t.key === f.type)?.label ?? f.type)
      .slice(0, 3)
    worstOffender = {
      actionName: worstRow.action_name,
      story:      worstRow.story_name,
      duration:   formatDurationMs(worstRow.action_duration),
      flagLabels,
    }
  }

  // ── Recommendation ────────────────────────────────────────────────────────
  let recommendation = ''
  if (topIssues.length > 0) {
    const top = topIssues[0]
    const map = {
      slow_action:
        `Optimising the ${top.count} slow action${top.count === 1 ? '' : 's'} would have the most direct impact — ` +
        `each took ${thresholds?.slowActionMs ? formatDurationMs(thresholds.slowActionMs) : '2 minutes'} or longer to complete.`,
      large_offset:
        `${top.count} action${top.count === 1 ? ' had a widget' : 's had widgets'} waiting an unusually long time before ` +
        `rendering — reducing server or network latency upstream should help.`,
      straggler:
        `${top.count} action${top.count === 1 ? '' : 's'} ${top.count === 1 ? 'has' : 'have'} one widget that is ` +
        `significantly slower than the rest — investigate those individual components.`,
      fragmented:
        `${top.count} action${top.count === 1 ? '' : 's'} spread slowness across many widgets with no single culprit — ` +
        `look for sequential rendering, layout thrashing, or resource contention.`,
      offset_overrun:
        `${top.count} action${top.count === 1 ? '' : 's'} ${top.count === 1 ? 'has' : 'have'} a widget whose pre-render wait ` +
        `exceeds the whole action duration, which usually indicates a timing instrumentation issue.`,
    }
    recommendation = map[top.key] ??
      `${top.label} is the most common issue (${top.count} action${top.count === 1 ? '' : 's'}, ${top.pct}%) — focus here for the biggest gain.`
  }

  return { headline, topIssues, kpiLine, worstOffender, recommendation }
}

/**
 * Build a flat list of the top N anomalous action rows for use in tables.
 * Returns rows from anomalies.rows sorted slowest-first, deduped by action name
 * so each unique action appears only once (its worst instance).
 */
/**
 * @param {object|Array} anomaliesOrRows  Either the full detectAnomalies() output
 *   OR a pre-filtered array of anomaly rows (e.g. filteredAnomalyRows from ActionView).
 *   When an array is passed it is used directly so the table is filter-aware.
 */
export function topAnomalousActions(anomaliesOrRows, limit = 20) {
  const rows = Array.isArray(anomaliesOrRows) ? anomaliesOrRows : (anomaliesOrRows?.rows ?? [])
  const seen = new Set()
  return rows
    .filter((r) => Number.isFinite(r.action_duration) && r.action_duration > 0)
    .sort((a, b) => b.action_duration - a.action_duration)
    .filter((r) => {
      if (seen.has(r.action_name)) return false
      seen.add(r.action_name)
      return true
    })
    .slice(0, limit)
    .map((r) => ({
      action:    r.action_name,
      story:     r.story_name ?? '—',
      duration:  formatDurationMs(r.action_duration),
      durationMs: r.action_duration,
      issues:    (r.flags ?? [])
        .filter((f) => !ANOMALY_TYPES.find((t) => t.key === f.type)?.subgroup)
        .map((f) => ANOMALY_TYPES.find((t) => t.key === f.type)?.label ?? f.type)
        .join(', '),
    }))
}

/**
 * Aggregate aggRows by action_name and return top N by total duration.
 * Used for the "Duration Profile" section of the report.
 */
export function durationProfile(aggRows, limit = 15) {
  const map = new Map()
  for (const r of aggRows ?? []) {
    const name = r.action_name ?? '(unknown)'
    const dur  = Number.isFinite(r.action_duration) ? r.action_duration : 0
    if (!map.has(name)) map.set(name, { count: 0, total: 0, max: 0 })
    const e = map.get(name)
    e.count++
    e.total += dur
    if (dur > e.max) e.max = dur
  }
  return Array.from(map.entries())
    .map(([name, s]) => ({
      action:  name,
      count:   s.count,
      max:     formatDurationMs(s.max),
      avg:     formatDurationMs(Math.round(s.total / s.count)),
      total:   formatDurationMs(s.total),
      totalMs: s.total,
    }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, limit)
}
