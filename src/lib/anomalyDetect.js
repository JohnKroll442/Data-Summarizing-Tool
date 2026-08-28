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
 * All types are performance flags (colored symbol + row tint):
 *
 *     slow_action        action_duration ≥ 2m
 *     large_offset       a widget's pre-render offset (wait) ≥ the dataset's terminal duration band (its lower edge)
 *     straggler          a widget ≥ 5× the action's median widget render (and ≥ 5s), ≥3 widgets
 *     frontend_bound     client render is > 50% of summed widget busy time (action ≥ 10s)
 *     network_bound      network ttfb is > 50% of summed widget busy time (action ≥ 10s)
 *     backend_bound      backend is > 50% of summed widget busy time (action ≥ 10s)
 *     fragmented         action ≥ 10s, ≥3 widgets, ≥50% of wall-clock unexplained by the slowest widget
 *     offset_overrun     a widget's offset (pre-render wait) exceeds the whole action duration (impossible timing)
 *     negative_phase     an exclusive phase is negative even at its MAX across widgets — render−network or
 *                        network−backend < 0 (an inner phase outran the one that should contain it)
 *     component_overrun  a single widget's summed phases exceed the whole action duration (impossible timing)
 *
 * frontend/network/backend_bound are mutually exclusive: at most one fires per
 * action (the phase holding a majority of summed widget busy time). They are a
 * SUBCATEGORY — a lens on WHERE the busy time went — shown indented under a
 * sub-header in the panel, and they do NOT count toward the "any anomaly" total:
 * an action flagged ONLY by a phase attribution isn't itself an anomaly (see
 * isAnomalyFlagged). fragmented says HOW MUCH wall-clock wasn't busy work at all
 * (serialization / scheduling / fan-out).
 *
 * Flagging ALL relationship anomalies lights up the majority of actions, which
 * defeats the purpose — so only the performance tier tints rows; the data tier
 * is counted and shown with a muted symbol.
 *
 * Returns { rows, columns, mapping, byActionKey, counts, totalFlagged }.
 */

import { actionEndDuration, actionRenderDuration } from './actionAggregate'
import { detectSessionKey } from './drillDown'
import { computeDurationBands } from './durationBands'
import { stripUserPrefix } from './format'
import { memoizeAggregate3 } from './memoize'
import { detectWidgetMapping, measureMatches } from './widgetAggregate'

/* ——— tunable thresholds (fixed, top-of-file so they're trivial to adjust) ——— */
export const SLOW_ACTION_MS = 120000    // slow_action: total action duration (≥ 2 min)
export const STRAGGLER_RATIO = 5        // straggler: widget vs action-median multiple
export const STRAGGLER_MIN_WIDGETS = 3  // straggler: don't judge a "median" of 1–2 widgets
export const STRAGGLER_MIN_MS = 5000    // straggler: the slow widget must itself be ≥ 5s
export const ATTRIBUTION_MIN_MS = 10000 // *_bound: only attribute actions this slow
export const ATTRIBUTION_DOMINANCE = 0.5 // *_bound: a phase must be a majority of busy time
export const OVERHEAD_MIN_MS = 10000    // fragmented: only judge actions this slow
export const OVERHEAD_SHARE = 0.5       // fragmented: unexplained share of wall-clock
export const OVERHEAD_MIN_WIDGETS = 3   // fragmented: need enough widgets to serialize

/**
 * The anomaly types, in display order. Single source of truth driving
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
    description: 'Action took ≥ 2m end-to-end.',
  },
  {
    // Data-integrity-adjacent, but loud: a widget's pre-render offset (the wait
    // before it starts rendering) was as long as the dataset's slowest actions —
    // ≥ the lower edge of the terminal duration band (computeDurationBands),
    // capped at 2m. Relative threshold, so it stays meaningful on any dataset.
    key: 'large_offset',
    tier: 'performance',
    label: 'Large offset',
    icon: 'history',
    color: '#e76500',
    description: 'A widget waited (pre-render) as long as the slowest actions in view — ≥ the top duration band.',
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
    label: 'Offset > Duration',
    icon: 'alert',
    color: '#5b738b',
    description: 'A widget’s offset (pre-render wait) exceeds the whole action’s duration — the source timestamps are inconsistent.',
  },
  {
    // Data-integrity: an exclusive phase is negative even at its MAX across the
    // action's widgets — render−network or network−backend < 0 — so an inner
    // phase measured LONGER than the phase that should contain it (phases nest:
    // render ⊇ network ⊇ backend). Max-based, so every widget's slice is negative,
    // not just one. Corrupts the busy-time math behind frontend/network_bound.
    key: 'negative_phase',
    tier: 'performance',
    label: 'Negative phase',
    icon: 'less',
    color: '#5b738b',
    description: 'An exclusive phase (render−network or network−backend) is negative for every widget — an inner phase outran the one that contains it.',
  },
  {
    // Data-integrity: a single widget's summed phases (its total wall-clock)
    // exceed the whole action's duration — impossible, since the widget runs
    // inside the action. Signals inconsistent action-vs-widget timestamps.
    key: 'component_overrun',
    tier: 'performance',
    label: 'Component overrun',
    icon: 'overflow',
    color: '#5b738b',
    description: 'A widget’s summed phases exceed the whole action’s duration — the source timestamps are inconsistent.',
  },
]

const TYPE_BY_KEY = new Map(ANOMALY_TYPES.map((t) => [t.key, t]))
const tierOf = (key) => TYPE_BY_KEY.get(key)?.tier ?? 'performance'

// The HEADLINE anomaly types — every type NOT in a subgroup. The phase-
// attribution subgroup (frontend/network/backend-bound) is a lens on WHERE a
// slow-ish action's time went, not an anomaly in itself, so it never adds an
// action to the "Any anomaly" union.
const HEADLINE_KEYS = new Set(ANOMALY_TYPES.filter((t) => !t.subgroup).map((t) => t.key))

/**
 * Human-readable blurb for the slow_action anomaly, reflecting the current
 * threshold. Used by AnomalySummaryPanel so the tooltip updates live when the
 * user changes the threshold in the settings dialog.
 */
export function getSlowActionBlurb(thresholds = {}) {
  const ms = thresholds.slowActionMs ?? SLOW_ACTION_MS
  let label
  if (ms < 60000) {
    label = `${ms / 1000} seconds`
  } else if (ms % 60000 === 0) {
    label = `${ms / 60000} minutes`
  } else {
    label = `${(ms / 1000).toFixed(0)} seconds`
  }
  return `This action took ${label} or longer from start to finish.`
}

/**
 * Whether an action counts toward the "Any anomaly" total. True iff it carries
 * at least one HEADLINE flag — an action flagged ONLY by the phase-attribution
 * subgroup is not itself an anomaly, so it doesn't. Shared by the detector, the
 * panel re-tally, and the table's `__total__` filter so all three agree.
 */
export function isAnomalyFlagged(flags) {
  return Array.isArray(flags) && flags.some((f) => HEADLINE_KEYS.has(f.type))
}

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
    for (const f of flags) if (counts[f.type]) counts[f.type].actions++
    // "Any anomaly" = actions with a HEADLINE flag; a phase-only action is
    // counted in its phase row but not in the union (see isAnomalyFlagged).
    if (isAnomalyFlagged(flags)) totalFlagged++
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

export const detectAnomalies = memoizeAggregate3(
  detectAnomaliesImpl,
  (t) => `${t?.slowActionMs ?? SLOW_ACTION_MS}:${t?.healthyCeilingMs ?? 5000}`,
)

function detectAnomaliesImpl(rows, headers, thresholds = {}) {
  const slowActionMs = thresholds.slowActionMs ?? SLOW_ACTION_MS
  const ceilMs = slowActionMs // DURATION_CEIL_MS tracks the slow-action threshold
  const goodMaxMs = thresholds.healthyCeilingMs ?? 5000
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
      bands: computeDurationBands([], { ceilMs, goodMaxMs }),
      slowActionMs,
    }
  }

  // Group rows by action (name + timestamp) — same key Action View uses.
  const groups = groupByAction(rows, mapping)

  const totalActions = groups.size

  // Canonical duration bands over the FULL scope — the single source of truth
  // shared by the histogram, the table's bucket filter, and the large_offset
  // threshold. Computed once here (not per visible/filtered set) so the band
  // edges — and thus the flags — stay stable regardless of table filtering.
  const durationByKey = new Map()
  for (const [actionKey, groupRows] of groups) {
    durationByKey.set(actionKey, computeActionDuration(groupRows, mapping))
  }
  const bands = computeDurationBands([...durationByKey.values()], { ceilMs, goodMaxMs })
  // large_offset fires at the terminal band's lower edge (≤ ceilMs by construction).
  const largeOffsetMs = bands[bands.length - 1].min

  const counts = emptyCounts()
  const byActionKey = new Map()
  const outRows = []
  let totalFlaggedActions = 0

  for (const [actionKey, groupRows] of groups) {
    const flags = detectActionFlags(groupRows, mapping, largeOffsetMs, slowActionMs)
    byActionKey.set(actionKey, flags)
    if (!flags.length) continue

    // Per-type counts include every flag (the panel shows the phase subgroup's
    // own counts); the "Any anomaly" total counts an action only if it has a
    // HEADLINE flag, so a phase-attribution-only action isn't in the union.
    for (const f of flags) counts[f.type].actions++
    if (!isAnomalyFlagged(flags)) continue
    totalFlaggedActions++

    const actionTs = mapping.actionTimestamp ? firstNonEmpty(groupRows, mapping.actionTimestamp) : ''
    outRows.push({
      action_key: actionKey,
      session_id: firstNonEmpty(groupRows, mapping.session),
      user: stripUserPrefix(firstNonEmpty(groupRows, mapping.user)),
      story_name: firstNonEmpty(groupRows, mapping.storyName),
      action_name: firstNonEmpty(groupRows, mapping.actionName),
      action_timestamp: actionTs,
      action_duration: durationByKey.get(actionKey),
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
    bands,
    slowActionMs,
  }
}

/* ——— offset vs duration scatter data ——— */

// Group rows into action instances by the composite USER_ACTION + ACTION_TIMESTAMP
// key — the same key Action View, the table, and the detector all group on.
function groupByAction(rows, mapping) {
  const groups = new Map()
  if (!mapping.actionName || !rows?.length) return groups
  for (const row of rows) {
    const name = row?.[mapping.actionName]
    if (name === undefined || name === null || name === '') continue
    const ts = mapping.actionTimestamp ? (row?.[mapping.actionTimestamp] ?? '') : ''
    const key = `${name}::${ts}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return groups
}

/**
 * Bucket one action's (maxOffset, duration) into the scatter's three classes,
 * mirroring the detector's offset flags exactly:
 *   overrun  offset > duration        (offset_overrun — impossible timing)
 *   large    offset ≥ largeOffsetMs    (large_offset — waited as long as the slowest actions)
 *   ok       otherwise
 * overrun outranks large when both apply.
 */
export function classifyOffsetPoint(maxOffset, duration, largeOffsetMs) {
  if (Number.isFinite(duration) && maxOffset > duration) return 'overrun'
  if (maxOffset >= largeOffsetMs) return 'large'
  return 'ok'
}

/**
 * One (duration, max-widget-offset) point per action instance, for the Offset
 * vs Duration scatter. Reuses the SAME primitives as detectAnomalies — the
 * grouping key, computeActionDuration, widgetStats, and the terminal duration
 * band — so the scatter's classes match the table's offset flags exactly.
 *
 * Only actions with a finite duration > 0 AND at least one finite widget offset
 * are emitted (a scatter point needs both coordinates). offset === 0 is kept —
 * a legit "no pre-render wait"; the chart handles the log-axis floor.
 *
 * Returns { points, largeOffsetMs, counts: { ok, large, overrun } } where each
 * point is { actionKey, action, story, user, timestamp, duration, maxOffset, klass }.
 */
export const buildOffsetDurationPoints = memoizeAggregate3(
  buildOffsetDurationPointsImpl,
  (t) => String(t?.slowActionMs ?? SLOW_ACTION_MS),
)

function buildOffsetDurationPointsImpl(rows, headers, thresholds = {}) {
  const slowActionMs = thresholds.slowActionMs ?? SLOW_ACTION_MS
  const ceilMs = slowActionMs
  const mapping = detectMapping(headers, rows)
  const empty = { points: [], largeOffsetMs: Infinity, counts: { ok: 0, large: 0, overrun: 0 } }
  if (!mapping.actionName || !rows?.length) return empty

  const groups = groupByAction(rows, mapping)
  if (!groups.size) return empty

  // Terminal duration band edge — the SAME large_offset threshold the detector
  // uses (see detectAnomaliesImpl), computed over the full scope's durations.
  const durationByKey = new Map()
  for (const [key, groupRows] of groups) {
    durationByKey.set(key, computeActionDuration(groupRows, mapping))
  }
  const bands = computeDurationBands([...durationByKey.values()], { ceilMs })
  const largeOffsetMs = bands[bands.length - 1].min

  const points = []
  const counts = { ok: 0, large: 0, overrun: 0 }
  for (const [key, groupRows] of groups) {
    const duration = durationByKey.get(key)
    if (!(Number.isFinite(duration) && duration > 0)) continue
    const offsets = widgetStats(groupRows, mapping).map((w) => w.offset).filter(Number.isFinite)
    if (!offsets.length) continue
    const maxOffset = Math.max(...offsets)
    const klass = classifyOffsetPoint(maxOffset, duration, largeOffsetMs)
    counts[klass]++
    points.push({
      actionKey: key,
      action: firstNonEmpty(groupRows, mapping.actionName),
      story: firstNonEmpty(groupRows, mapping.storyName),
      user: stripUserPrefix(firstNonEmpty(groupRows, mapping.user)),
      timestamp: mapping.actionTimestamp ? firstNonEmpty(groupRows, mapping.actionTimestamp) : '',
      duration,
      maxOffset,
      klass,
    })
  }
  return { points, largeOffsetMs, counts }
}

/* ——— per-action detection ——— */

/**
 * All anomaly flags for one action's rows. Each flag is
 * `{ type, tier, value, detail }` where `value` is the compared number and
 * `detail` is a short human string for the badge tooltip. Performance flags
 * come first (matching ANOMALY_TYPES order) so the badge renders loud symbols
 * ahead of quiet ones.
 */
function detectActionFlags(groupRows, mapping, largeOffsetMs = Infinity, slowActionMs = SLOW_ACTION_MS) {
  const flags = []
  const add = (type, value, detail) => flags.push({ type, tier: tierOf(type), value, detail })

  // 1. slow_action — total action duration ≥ slowActionMs.
  const duration = computeActionDuration(groupRows, mapping)
  if (Number.isFinite(duration) && duration >= slowActionMs) {
    add('slow_action', duration, `Action took ${fmtMs(duration)} (≥ ${fmtMs(slowActionMs)}).`)
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

  // 5. Offset anomalies — both keyed off the MAX widget offset (pre-render wait;
  // one widget alone is proof, so max not sum):
  //   offset_overrun (data-integrity) — the offset exceeds the whole action's
  //     duration, which is impossible (the offset window is contained in the
  //     action), so the timestamps are internally inconsistent.
  //   large_offset (magnitude) — the offset alone is ≥ the dataset's terminal
  //     duration band (its lower edge, ≤ 2m): a widget waited as long as the
  //     slowest actions before it even started rendering. Relative threshold, so
  //     it stays meaningful across datasets.
  const offsets = widgets.map((w) => w.offset).filter(Number.isFinite)
  if (offsets.length) {
    const maxOffset = Math.max(...offsets)
    if (Number.isFinite(duration) && maxOffset > duration) {
      add('offset_overrun', maxOffset,
        `Max widget offset ${fmtMs(maxOffset)} exceeds the ${fmtMs(duration)} action duration — timestamps are inconsistent.`)
    }
    if (maxOffset >= largeOffsetMs) {
      add('large_offset', maxOffset,
        `A widget waited ${fmtMs(maxOffset)} before rendering (≥ ${fmtMs(largeOffsetMs)}, the top duration band) — as long as the slowest actions.`)
    }
  }

  // 6. negative_phase — data-integrity: an exclusive phase is negative even at
  // its MAX across widgets. Phases nest (render ⊇ network ⊇ backend), so the
  // exclusive slices are render−network (frontend) and network−backend. If the
  // LARGEST such slice across the action's widgets is still < 0, an inner phase
  // outran its container for every widget. Un-clamped (the *_bound block above
  // clamps with Math.max(…,0); here the negative is exactly the signal).
  let maxFrontendExcl = -Infinity
  let maxNetworkExcl = -Infinity
  for (const w of widgets) {
    if (Number.isFinite(w.render)) {
      const fe = w.render - (Number.isFinite(w.network) ? w.network : 0)
      if (fe > maxFrontendExcl) maxFrontendExcl = fe
    }
    if (Number.isFinite(w.network)) {
      const ne = w.network - (Number.isFinite(w.backend) ? w.backend : 0)
      if (ne > maxNetworkExcl) maxNetworkExcl = ne
    }
  }
  const negFrontend = maxFrontendExcl !== -Infinity && maxFrontendExcl < 0
  const negNetwork = maxNetworkExcl !== -Infinity && maxNetworkExcl < 0
  if (negFrontend || negNetwork) {
    const worst = negFrontend ? maxFrontendExcl : maxNetworkExcl
    const which = negFrontend ? 'frontend (render − network)' : 'network (network − backend)'
    add('negative_phase', worst,
      `Max exclusive ${which} is ${fmtMs(worst)} (< 0) — an inner phase outran the one that contains it.`)
  }

  // 7. component_overrun — data-integrity: a single widget's summed phases (its
  // total wall-clock = the exclusive slices added back together) exceed the whole
  // action's duration. A widget can't outlast the action that contains it, so the
  // action-vs-widget timestamps are inconsistent. Compare the MAX widget total.
  if (Number.isFinite(duration)) {
    let maxWidgetTotalPhases = -Infinity
    for (const w of widgets) {
      const fe = Number.isFinite(w.render) ? w.render - (Number.isFinite(w.network) ? w.network : 0) : NaN
      const ne = Number.isFinite(w.network) ? w.network - (Number.isFinite(w.backend) ? w.backend : 0) : NaN
      const be = Number.isFinite(w.backend) ? w.backend : NaN
      let total = 0
      let any = false
      for (const v of [fe, ne, be]) if (Number.isFinite(v)) { total += v; any = true }
      if (any && total > maxWidgetTotalPhases) maxWidgetTotalPhases = total
    }
    if (maxWidgetTotalPhases !== -Infinity && maxWidgetTotalPhases > duration) {
      add('component_overrun', maxWidgetTotalPhases,
        `A widget’s phases total ${fmtMs(maxWidgetTotalPhases)}, exceeding the ${fmtMs(duration)} action duration — timestamps are inconsistent.`)
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
