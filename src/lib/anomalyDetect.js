/**
 * Action-level anomaly detection for the Action View.
 *
 * One "finding" per FLAGGED action — keyed by USER_ACTION + ACTION_TIMESTAMP,
 * the same composite key Action View groups on (see actionAggregate /
 * ActionSummaryTable.actionKey), so the panel/table can look flags up by the
 * exact key a table row carries.
 *
 * Every anomaly is a FIXED-THRESHOLD, eyeball-verifiable two-value comparison
 * (no black-box scores): the reader can locate both numbers in the raw data.
 * All eight types are performance flags (colored symbol + row tint):
 *
 *     slow_action        action_duration ≥ 30s
 *     first_paint        firstRender − ACTION_TIMESTAMP ≥ 20s
 *     straggler          a widget ≥ 5× the action's median widget render (and ≥ 5s), ≥3 widgets
 *     frontend_bound     client render is > 50% of summed widget busy time (action ≥ 10s)
 *     network_bound      network ttfb is > 50% of summed widget busy time (action ≥ 10s)
 *     backend_bound      backend is > 50% of summed widget busy time (action ≥ 10s)
 *     fragmented         action ≥ 10s, ≥3 widgets, ≥50% of wall-clock unexplained by the slowest widget
 *     offset_overrun     a widget's offset (pre-render wait) exceeds the whole action duration (impossible timing)
 *
 * frontend/network/backend_bound are mutually exclusive: at most one fires per
 * action (the phase holding a majority of summed widget busy time). They are a
 * SUBCATEGORY — a lens on WHERE the busy time went — shown indented under a
 * sub-header in the panel, but like every other flag they DO count toward the
 * "any anomaly" total (an action carrying any flag is a flagged action).
 * fragmented says HOW MUCH wall-clock wasn't busy work at all (serialization /
 * scheduling / fan-out).
 *
 * Flagging ALL relationship anomalies lights up the majority of actions, which
 * defeats the purpose — so only the performance tier tints rows; the data tier
 * is counted and shown with a muted symbol.
 *
 * Returns { rows, columns, mapping, byActionKey, counts, totalFlagged }.
 */

import { actionEndDuration, actionRenderDuration } from './actionAggregate'
import { detectSessionKey } from './drillDown'
import { stripUserPrefix } from './format'
import { memoizeAggregate } from './memoize'
import { parseStrictTimestamp } from './timeBuckets'
import { detectWidgetMapping, measureMatches } from './widgetAggregate'

/* ——— tunable thresholds (fixed, top-of-file so they're trivial to adjust) ——— */
export const SLOW_ACTION_MS = 30000     // slow_action: total action duration
export const FIRST_PAINT_MS = 20000     // first_paint: time to the first widget render
export const STRAGGLER_RATIO = 5        // straggler: widget vs action-median multiple
export const STRAGGLER_MIN_WIDGETS = 3  // straggler: don't judge a "median" of 1–2 widgets
export const STRAGGLER_MIN_MS = 5000    // straggler: the slow widget must itself be ≥ 5s
export const ATTRIBUTION_MIN_MS = 10000 // *_bound: only attribute actions this slow
export const ATTRIBUTION_DOMINANCE = 0.5 // *_bound: a phase must be a majority of busy time
export const OVERHEAD_MIN_MS = 10000    // fragmented: only judge actions this slow
export const OVERHEAD_SHARE = 0.5       // fragmented: unexplained share of wall-clock
export const OVERHEAD_MIN_WIDGETS = 3   // fragmented: need enough widgets to serialize

/**
 * The eight anomaly types, in display order. Single source of truth driving
 * the detector, the summary panel rows, the inline badge, and any legend. The
 * three phase-attribution types carry `subgroup: 'phase'` — the panel indents
 * them under a sub-header and they're excluded from the headline total.
 *   key         stable id, also the flag `type`
 *   tier        'performance' (all types are loud today)
 *   subgroup    optional id grouping a run of related types (e.g. 'phase')
 *   label       short human label
 *   icon        SAP UI5 icon name (<ui5-icon name=…>)
 *   color       accent color for the symbol (rendered as a color-coded dot)
 *   description one-line rule, shown in the badge tooltip / panel
 */
export const ANOMALY_TYPES = [
  {
    key: 'slow_action',
    tier: 'performance',
    label: 'Slow action',
    icon: 'fob-watch',
    color: '#bb0000',
    description: 'Action took ≥ 30s end-to-end.',
  },
  {
    key: 'first_paint',
    tier: 'performance',
    label: 'Slow first paint',
    icon: 'history',
    color: '#e76500',
    description: 'First widget rendered ≥ 20s after the action started.',
  },
  {
    key: 'straggler',
    tier: 'performance',
    label: 'Straggler widget',
    icon: 'physical-activity',
    color: '#c35500',
    description: 'A widget rendered ≥ 5× the action’s median widget (≥3 widgets).',
  },
  {
    key: 'frontend_bound',
    tier: 'performance',
    subgroup: 'phase',
    label: 'Frontend',
    icon: 'palette',
    color: '#0070f2',
    description: 'Client render was the majority of the action’s widget busy time (action ≥ 10s).',
  },
  {
    key: 'network_bound',
    tier: 'performance',
    subgroup: 'phase',
    label: 'Network',
    icon: 'connected',
    color: '#0a6ed1',
    description: 'Network ttfb was the majority of the action’s widget busy time (action ≥ 10s).',
  },
  {
    key: 'backend_bound',
    tier: 'performance',
    subgroup: 'phase',
    label: 'Backend',
    icon: 'database',
    color: '#7858a8',
    description: 'Backend was the majority of the action’s widget busy time (action ≥ 10s).',
  },
  {
    key: 'fragmented',
    tier: 'performance',
    label: 'Fragmented',
    icon: 'puzzle',
    color: '#d04343',
    description: 'Action ≥ 10s with ≥3 widgets, but ≥50% of wall-clock isn’t explained by the slowest widget.',
  },
  {
    // Data-integrity, not slowness: a widget's offset (pre-render wait) can't
    // exceed the whole action's duration — the offset window is contained in the
    // action. When it does, the source timestamps are inconsistent. Kept loud
    // (no subgroup) so it counts toward the headline total and is filterable.
    key: 'offset_overrun',
    tier: 'performance',
    label: 'Impossible timing',
    icon: 'alert',
    color: '#5b738b',
    description: 'A widget’s offset (pre-render wait) exceeds the whole action’s duration — the source timestamps are inconsistent.',
  },
]

const TYPE_BY_KEY = new Map(ANOMALY_TYPES.map((t) => [t.key, t]))
const tierOf = (key) => TYPE_BY_KEY.get(key)?.tier ?? 'performance'

/**
 * Re-tally anomaly counts over an arbitrary SUBSET of actions — used to keep the
 * summary panel in sync with whatever the table currently shows. Given the
 * action keys currently visible (each `name::timestamp`, matching
 * ActionSummaryTable.actionKey) and the detector's `byActionKey` map, returns
 * the same `{ counts, totalFlagged, totalActions }` shape detectAnomalies does,
 * but scoped to those keys. O(visible actions) — no re-detection.
 */
export function summarizeActionFlags(actionKeys, byActionKey) {
  const counts = {}
  for (const t of ANOMALY_TYPES) counts[t.key] = { actions: 0, pct: 0 }
  let totalFlagged = 0
  const totalActions = actionKeys?.length ?? 0

  for (const key of actionKeys || []) {
    const flags = byActionKey?.get(key)
    if (!flags || !flags.length) continue
    totalFlagged++
    for (const f of flags) if (counts[f.type]) counts[f.type].actions++
  }

  for (const key of Object.keys(counts)) {
    counts[key].pct = totalActions ? counts[key].actions / totalActions : 0
  }
  return {
    counts,
    totalFlagged: { actions: totalFlagged, pct: totalActions ? totalFlagged / totalActions : 0 },
    totalActions,
  }
}

/**
 * Rank the anomaly TYPES into three severity tiers by how prevalent each is —
 * the share of actions it flags. Highest percentage = T1 (loudest / most
 * widespread), the middle band = T2, the lowest = T3. Only types that actually
 * flagged an action are ranked; a type with zero actions gets no tier (so it
 * carries no badge).
 *
 * The split is over DISTINCT percentages, not raw rank position, so types that
 * SHARE a percentage share a tier: the distinct values are sorted high→low and
 * cut into three even groups (`floor(i * 3 / n) + 1`). With one distinct value
 * everything is T1; with two, T1/T2; with three or more the band widens evenly.
 *
 * Returns a `Map<typeKey, 1 | 2 | 3>`. Feeds the T1/T2/T3 badges in the summary
 * panel and the table (where a row shows its most-severe tier — the LOWEST
 * number among its flags).
 */
export function rankAnomalyTiers(counts) {
  const tiers = new Map()
  if (!counts) return tiers

  // Only types present in the (possibly filtered) view participate in the rank.
  // The phase-attribution subcategory (frontend/network/backend) is excluded —
  // it's a lens on where time went, not a severity we rank, so it carries no
  // T1/T2/T3 badge.
  const present = ANOMALY_TYPES
    .filter((t) => !t.subgroup)
    .map((t) => ({ key: t.key, pct: counts[t.key]?.pct ?? 0, actions: counts[t.key]?.actions ?? 0 }))
    .filter((e) => e.actions > 0)
  if (!present.length) return tiers

  // Distinct percentages, highest first — equal shares fall in the same tier.
  const distinct = [...new Set(present.map((e) => e.pct))].sort((a, b) => b - a)
  const n = distinct.length
  const tierOfPct = new Map(distinct.map((p, i) => [p, Math.floor((i * 3) / n) + 1]))
  for (const e of present) tiers.set(e.key, tierOfPct.get(e.pct))
  return tiers
}

export const detectAnomalies = memoizeAggregate(detectAnomaliesImpl)

function detectAnomaliesImpl(rows, headers) {
  const mapping = detectMapping(headers, rows)

  const columns = [
    { key: 'session_id',      label: 'Session ID' },
    { key: 'user',            label: 'User' },
    { key: 'story_name',      label: 'Story name' },
    { key: 'action_name',     label: 'Action name' },
    { key: 'action_timestamp', label: 'Action timestamp' },
    { key: 'action_duration', label: 'Action duration', sortType: 'duration' },
    { key: 'flags',           label: 'Anomalies' },
  ]

  const emptyCounts = () => {
    const c = {}
    for (const t of ANOMALY_TYPES) c[t.key] = { actions: 0, pct: 0 }
    return c
  }

  if (!mapping.actionName || !rows?.length) {
    return {
      rows: [],
      columns,
      mapping,
      byActionKey: new Map(),
      counts: emptyCounts(),
      totalFlagged: { actions: 0, pct: 0 },
      totalActions: 0,
    }
  }

  // Group rows by action (name + timestamp) — same key Action View uses.
  const groups = new Map()
  for (const row of rows) {
    const name = row?.[mapping.actionName]
    if (name === undefined || name === null || name === '') continue
    const ts = mapping.actionTimestamp ? (row?.[mapping.actionTimestamp] ?? '') : ''
    const key = `${name}::${ts}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  const totalActions = groups.size
  const counts = emptyCounts()
  const byActionKey = new Map()
  const outRows = []
  let totalFlaggedActions = 0

  for (const [actionKey, groupRows] of groups) {
    const flags = detectActionFlags(groupRows, mapping)
    byActionKey.set(actionKey, flags)
    if (!flags.length) continue

    totalFlaggedActions++
    for (const f of flags) counts[f.type].actions++

    const actionTs = mapping.actionTimestamp ? firstNonEmpty(groupRows, mapping.actionTimestamp) : ''
    outRows.push({
      action_key: actionKey,
      session_id: firstNonEmpty(groupRows, mapping.session),
      user: stripUserPrefix(firstNonEmpty(groupRows, mapping.user)),
      story_name: firstNonEmpty(groupRows, mapping.storyName),
      action_name: firstNonEmpty(groupRows, mapping.actionName),
      action_timestamp: actionTs,
      action_duration: computeActionDuration(groupRows, mapping),
      flags,
    })
  }

  // Percentages are "% of ALL actions flagged for this type" — the denominator
  // is every action, so the panel reads "N (X%)" against the whole view.
  for (const key of Object.keys(counts)) {
    counts[key].pct = totalActions ? counts[key].actions / totalActions : 0
  }

  // Findings sorted so the loudest actions surface first: performance-flagged
  // (and more-flagged) actions before data-only ones.
  outRows.sort((a, b) => flagRank(b.flags) - flagRank(a.flags))

  return {
    rows: outRows,
    columns,
    mapping,
    byActionKey,
    counts,
    totalFlagged: {
      actions: totalFlaggedActions,
      pct: totalActions ? totalFlaggedActions / totalActions : 0,
    },
    totalActions,
  }
}

/* ——— per-action detection ——— */

/**
 * All anomaly flags for one action's rows. Each flag is
 * `{ type, tier, value, detail }` where `value` is the compared number and
 * `detail` is a short human string for the badge tooltip. Performance flags
 * come first (matching ANOMALY_TYPES order) so the badge renders loud symbols
 * ahead of quiet ones.
 */
function detectActionFlags(groupRows, mapping) {
  const flags = []
  const add = (type, value, detail) => flags.push({ type, tier: tierOf(type), value, detail })

  // 1. slow_action — total action duration ≥ 30s.
  const duration = computeActionDuration(groupRows, mapping)
  if (Number.isFinite(duration) && duration >= SLOW_ACTION_MS) {
    add('slow_action', duration, `Action took ${fmtMs(duration)} (≥ ${fmtMs(SLOW_ACTION_MS)}).`)
  }

  // 2. first_paint — first widget render ≥ 20s after the action started.
  const startMs = actionStartMs(groupRows, mapping)
  const firstMs = firstRenderMs(groupRows, mapping)
  if (startMs !== null && firstMs !== null) {
    const gap = firstMs - startMs
    if (gap >= FIRST_PAINT_MS) {
      add('first_paint', gap, `First paint ${fmtMs(gap)} after start (≥ ${fmtMs(FIRST_PAINT_MS)}).`)
    }
  }

  // Per-widget stats — the remaining rules compare values WITHIN a widget or a
  // widget against the action's median widget.
  const widgets = widgetStats(groupRows, mapping)

  // 3. straggler — a widget rendered ≥ 5× the action's median widget render,
  // is itself ≥ 5s (a trivial 5× on tiny renders isn't a real straggler), and
  // there are enough widgets for a "median" to be meaningful.
  const renders = widgets.map((w) => w.render).filter((v) => Number.isFinite(v) && v > 0)
  if (renders.length >= STRAGGLER_MIN_WIDGETS) {
    const med = median(renders)
    if (med > 0) {
      const slowest = Math.max(...renders)
      if (slowest >= STRAGGLER_MIN_MS && slowest >= STRAGGLER_RATIO * med) {
        add('straggler', slowest, `A widget rendered ${fmtMs(slowest)} vs a ${fmtMs(med)} median (≥ ${STRAGGLER_RATIO}×).`)
      }
    }
  }

  // 4. Phase attribution + fragmentation — reason about WHERE an action's time
  // went. Phases NEST (render ⊇ network ⊇ backend), so per widget derive the
  // EXCLUSIVE slice of each phase and sum across widgets to get the action's
  // busy-time split. Only judged for slow-ish actions (≥ 10s).
  if (Number.isFinite(duration) && duration >= ATTRIBUTION_MIN_MS) {
    let sumFrontend = 0
    let sumNetwork = 0
    let sumBackend = 0
    let maxWidgetTotal = 0
    let widgetCount = 0
    for (const w of widgets) {
      const r = Number.isFinite(w.render) ? w.render : 0
      const n = Number.isFinite(w.network) ? w.network : 0
      const b = Number.isFinite(w.backend) ? w.backend : 0
      if (r <= 0 && n <= 0 && b <= 0) continue
      widgetCount++
      sumFrontend += Math.max(r - n, 0) // pure client render (render minus its network)
      sumNetwork += Math.max(n - b, 0)  // pure transport / ttfb wait (network minus backend)
      sumBackend += Math.max(b, 0)      // innermost server time
      // Widget wall-clock ≈ inclusive render; fall back to the largest phase.
      const wall = r > 0 ? r : Math.max(n, b)
      if (wall > maxWidgetTotal) maxWidgetTotal = wall
    }

    const busy = sumFrontend + sumNetwork + sumBackend
    if (busy > 0) {
      // Exactly one *_bound fires: the phase holding a majority of busy time.
      const phases = [
        { type: 'frontend_bound', ms: sumFrontend, label: 'Frontend' },
        { type: 'network_bound', ms: sumNetwork, label: 'Network' },
        { type: 'backend_bound', ms: sumBackend, label: 'Backend' },
      ]
      const top = phases.reduce((a, p) => (p.ms > a.ms ? p : a), phases[0])
      if (top.ms / busy > ATTRIBUTION_DOMINANCE) {
        const share = Math.round((top.ms / busy) * 100)
        add(top.type, share,
          `${top.label} ${fmtMs(top.ms)} of ${fmtMs(busy)} widget time (${share}%) — ` +
          `frontend ${fmtMs(sumFrontend)} / network ${fmtMs(sumNetwork)} / backend ${fmtMs(sumBackend)}.`)
      }
    }

    // fragmented — the action's wall-clock far exceeds its slowest single widget,
    // so most of the time went to serialization / scheduling / fan-out, not any
    // one widget's work.
    if (widgetCount >= OVERHEAD_MIN_WIDGETS && maxWidgetTotal > 0) {
      const overhead = duration - maxWidgetTotal
      if (overhead >= OVERHEAD_SHARE * duration) {
        const share = Math.round((overhead / duration) * 100)
        add('fragmented', share,
          `${widgetCount} widgets; slowest ran ${fmtMs(maxWidgetTotal)} but the action took ` +
          `${fmtMs(duration)} — ${share}% went to scheduling/serialization, not any single widget.`)
      }
    }
  }

  // 5. offset_overrun — data-integrity: a single widget's offset (pre-render
  // wait) can't exceed the whole action's duration, since the offset window is
  // contained in the action. Compare MAX offset across widgets (one widget alone
  // exceeding the total is proof), NOT the sum. When it trips, the action's
  // timestamps are internally inconsistent and its durations can't be trusted.
  const offsets = widgets.map((w) => w.offset).filter(Number.isFinite)
  if (offsets.length && Number.isFinite(duration)) {
    const maxOffset = Math.max(...offsets)
    if (maxOffset > duration) {
      add('offset_overrun', maxOffset,
        `Max widget offset ${fmtMs(maxOffset)} exceeds the ${fmtMs(duration)} action duration — timestamps are inconsistent.`)
    }
  }

  // Keep ANOMALY_TYPES order (performance first) regardless of detection order.
  flags.sort((a, b) => typeOrder(a.type) - typeOrder(b.type))
  return flags
}

/* ——— per-widget stats ——— */

/**
 * Reduce one action's rows to per-widget stats: inclusive render / network
 * (ttfb) / backend / offset maxes and the ttfb round-trip count. Network counts
 * the ttfb sub-measure only when a submeasure column exists (matching the widget
 * table); otherwise it's the max across all network rows.
 */
function widgetStats(groupRows, mapping) {
  if (!mapping.measure || !mapping.duration) return []
  const useTtfb = Boolean(mapping.submeasure)
  const byWidget = new Map()
  const widKey = (r) => {
    if (!mapping.widgetId) return '*'
    const w = r?.[mapping.widgetId]
    return (w === undefined || w === null || w === '') ? null : String(w)
  }
  for (const r of groupRows) {
    const wid = widKey(r)
    if (wid === null) continue
    let stat = byWidget.get(wid)
    if (!stat) {
      stat = { render: NaN, network: NaN, backend: NaN, offset: NaN, ttfbCount: 0 }
      byWidget.set(wid, stat)
    }
    const mv = String(r?.[mapping.measure] ?? '').toLowerCase()
    const n = Number(r?.[mapping.duration])
    const finite = Number.isFinite(n)
    if (measureMatches(mv, ['render', 'frontend'])) {
      if (finite && (Number.isNaN(stat.render) || n > stat.render)) stat.render = n
    } else if (measureMatches(mv, ['network'])) {
      const ttfb = !useTtfb || isTtfb(r, mapping, mv)
      if (ttfb) {
        if (finite && (Number.isNaN(stat.network) || n > stat.network)) stat.network = n
        stat.ttfbCount++
      }
    } else if (measureMatches(mv, ['backend'])) {
      if (finite && (Number.isNaN(stat.backend) || n > stat.backend)) stat.backend = n
    } else if (measureMatches(mv, ['offset'])) {
      if (finite && (Number.isNaN(stat.offset) || n > stat.offset)) stat.offset = n
    }
  }
  return Array.from(byWidget.values())
}

// Does a network row belong to the ttfb round-trip? Mirrors widgetAggregate's
// subMatches: either WIDGET_SUBMEASURE contains 'ttfb', or the marker is folded
// into WIDGET_MEASURE as `network_ttfb`.
function isTtfb(row, mapping, measureValLower) {
  const sub = normSub(row?.[mapping.submeasure])
  if (sub && sub.includes('ttfb')) return true
  const idx = measureValLower.indexOf('_')
  if (idx >= 0 && normSub(measureValLower.slice(idx + 1)).includes('ttfb')) return true
  return false
}

/* ——— duration / timing helpers (consistent with actionAggregate) ——— */

// Same source chain as actionAggregate.actionDuration: ACTION_TIMESTAMP_END −
// ACTION_TIMESTAMP, else MAX(WIDGET_RENDER_TIMESTAMP) − ACTION_TIMESTAMP, else
// max(DURATION). Returns a number, or '' when nothing is computable.
function computeActionDuration(groupRows, mapping) {
  if (mapping.actionTimestampEnd) {
    const d = actionEndDuration(groupRows, mapping.actionTimestampEnd, mapping.actionTimestamp)
    if (d !== '') return d
  }
  if (mapping.renderTimestamp) {
    return actionRenderDuration(groupRows, mapping.renderTimestamp, mapping.actionTimestamp)
  }
  return maxNumeric(groupRows, mapping.duration)
}

// Epoch-ms of the action's start (its ACTION_TIMESTAMP), or null.
function actionStartMs(groupRows, mapping) {
  if (!mapping.actionTimestamp) return null
  for (const r of groupRows) {
    const d = parseStrictTimestamp(r?.[mapping.actionTimestamp])
    if (d) return d.getTime()
  }
  return null
}

// Epoch-ms of the EARLIEST widget render in the action (the first paint), or
// null when there's no render-timestamp column / no parseable render.
function firstRenderMs(groupRows, mapping) {
  if (!mapping.renderTimestamp) return null
  let min = Infinity
  for (const r of groupRows) {
    const d = parseStrictTimestamp(r?.[mapping.renderTimestamp])
    if (d) { const t = d.getTime(); if (t < min) min = t }
  }
  return min === Infinity ? null : min
}

/* ——— small utilities ——— */

function firstNonEmpty(rows, key) {
  if (!key) return ''
  for (const r of rows) {
    const v = r?.[key]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return ''
}

function maxNumeric(rows, key) {
  if (!key) return ''
  let max = -Infinity
  let found = false
  for (const r of rows) {
    const n = Number(r?.[key])
    if (Number.isFinite(n)) { if (n > max) max = n; found = true }
  }
  return found ? max : ''
}

function median(nums) {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function normSub(s) {
  return String(s ?? '').toLowerCase().replace(/[\s_\-.]+/g, '')
}

function fmtMs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return ''
  if (Math.abs(n) < 1000) return `${Math.round(n)} ms`
  return `${(n / 1000).toFixed(1)}s`
}

// Position of a type in ANOMALY_TYPES (performance tier first). Used to order
// a single action's flags.
function typeOrder(key) {
  const i = ANOMALY_TYPES.findIndex((t) => t.key === key)
  return i === -1 ? ANOMALY_TYPES.length : i
}

// Rank a flag set for the findings sort: performance flags weigh more than data
// flags, and more flags outrank fewer. Purely for display ordering.
function flagRank(flags) {
  let rank = 0
  for (const f of flags) rank += f.tier === 'performance' ? 10 : 1
  return rank
}

/* ——— column mapping ——— */

// Merge the widget-phase mapping (widget id, measure, submeasure, duration,
// render timestamps, action timestamp) with the action-level fields (name,
// end timestamp, story, user, session) — reusing the same detectors the Action
// and Widget views use so every view agrees on which column is which.
function detectMapping(headers, rows) {
  const widget = detectWidgetMapping(headers || [])
  const norm = (s) => String(s).trim().toLowerCase().replace(/[\s_\-.]+/g, '')

  const find = (exacts, substrings, reject = () => false) => {
    for (const h of headers || []) {
      if (reject(h)) continue
      if (exacts.includes(norm(h))) return h
    }
    for (const h of headers || []) {
      if (reject(h)) continue
      const n = norm(h)
      if (substrings.some((s) => n.includes(s))) return h
    }
    return ''
  }

  const actionName = find(
    ['useraction', 'actionname'],
    ['useraction'],
    (h) => {
      const n = norm(h)
      return n.includes('id') || n.includes('timestamp') ||
             n.includes('details') || n.includes('end')
    },
  ) || find(['action'], ['action'], (h) => {
    const n = norm(h)
    return n.includes('id') || n.includes('timestamp') ||
           n.includes('details') || n.includes('count') || n.includes('end')
  })

  const actionTimestampEnd = find(['actiontimestampend'], ['actiontimestampend'])

  return {
    ...widget,
    actionName,
    actionTimestampEnd,
    storyName: find(['storyname'], ['storyname']),
    user: find(['username', 'user'], ['user']),
    session: detectSessionKey(headers, rows),
  }
}
