import { useEffect, useMemo, useRef, useState } from 'react'
import ActionSummaryTable from '../../components/ActionSummaryTable'
import ActionWaterfallPanel from '../../components/ActionWaterfallPanel'
import KpiStrip from '../../components/KpiStrip'
import DurationDistribution from '../../components/DurationDistribution'
import AnomalySummaryPanel from '../../components/AnomalySummaryPanel'
import ActionStoryHeatmap from '../../components/ActionStoryHeatmap'
import ActionCellDetail from '../../components/ActionCellDetail'
import { useCsvData } from '../../context/useCsvData'
import { HeaderPortal } from '../../context/HeaderSlot'
import { applySessionFilter, applySessionMultiFilter } from '../../lib/drillDown'
import { aggregateByAction } from '../../lib/actionAggregate'
import { actionKpisFromAgg } from '../../lib/kpis'
import { bucketKeyOf } from '../../lib/durationBands'
import { detectAnomalies, summarizeActionFlags, rankAnomalyTiers } from '../../lib/anomalyDetect'
import { buildStoryActionMatrix, cellKeyOf } from '../../lib/storyActionMatrix'
import './ActionView.css'

/**
 * ActionView — a left rail (headline KPIs · duration histogram · anomaly
 * summary) beside the one-row-per-action table and, below it, user-added
 * charts. The manager's ask lives here: surface fixed-threshold, eyeball-
 * verifiable anomalies scoped to the Action view.
 *
 * Data flow, kept one-directional to avoid double aggregation:
 *   - ActionView scopes rows once, runs the (memoized) detector, and owns the
 *     two pieces of anomaly UI state: `hoveredActionKey` and `anomalyTypeFilter`.
 *   - It passes `byActionKey` / `anomalyTypeFilter` DOWN to the table (for
 *     inline badges, the row tint, and click-to-filter) and hover flows back UP
 *     via `onHoverAction`.
 *   - The table publishes its fully filtered + sorted rows UP
 *     (`filteredActionRows`); the rail's KPIs, histogram AND anomaly-panel counts
 *     all summarize exactly that visible set, so filtering the table reshapes the
 *     whole rail. `byActionKey` (all scoped actions) is the flag lookup; the
 *     panel just re-tallies over the visible keys via summarizeActionFlags.
 */
function ActionView() {
  const { rows, headers, sessionFilter, sessionMultiFilter, viewUi, setViewUi } = useCsvData()

  // Scope KPIs + charts + detection to match the table. The multiselect
  // Sessions filter, when active, takes over the row scope; otherwise the
  // single-session drill-down from Session View applies. memoizeFilter returns a
  // STABLE ref, so the memoized aggregate/detector below hit their caches.
  const scopedRows = useMemo(() => {
    if (sessionMultiFilter.length > 0) {
      return applySessionMultiFilter(rows, headers, sessionMultiFilter)
    }
    return applySessionFilter(rows, headers, sessionFilter)
  }, [rows, headers, sessionFilter, sessionMultiFilter])

  // Global anomaly detection over the whole scope (independent of the table's
  // local filters) — the panel's "N (X%)" counts and the byActionKey lookup the
  // table reads for badges / tint / click-to-filter.
  const anomalies = useMemo(
    () => detectAnomalies(scopedRows, headers),
    [scopedRows, headers],
  )

  // The canonical duration bands the detector computed over the full scope — the
  // single source of truth shared by the histogram, the table's bucket filter,
  // and the large_offset threshold. Edges stay stable while the table filters.
  const bands = anomalies.bands

  // Column mapping for the KPI helper — a cache hit on the table's own
  // aggregateByAction(scopedRows, headers) call. We also take `.rows` (the
  // one-row-per-action-instance set) to feed the Story × Action heatmap.
  const { mapping, rows: aggRows } = useMemo(
    () => aggregateByAction(scopedRows, headers),
    [scopedRows, headers],
  )

  // The p95 crosstab behind the "Story × Action heatmap" chart tab. Scoped to
  // the session (like the rail), independent of the table's column filters.
  const storyActionMatrix = useMemo(
    () => buildStoryActionMatrix(aggRows),
    [aggRows],
  )

  // The heatmap cell whose drill-down detail is open, as { story, action }, or
  // null when none is selected. Reset if it points at a combo the current matrix
  // no longer has (e.g. after the scope changes).
  const [selectedCell, setSelectedCell] = useState(null)
  const selectedCellKey = selectedCell
    ? cellKeyOf(selectedCell.story, selectedCell.action)
    : null
  const selectedCellData = selectedCellKey
    ? storyActionMatrix.cells.get(selectedCellKey) ?? null
    : null
  useEffect(() => {
    if (selectedCell && !storyActionMatrix.cells.has(cellKeyOf(selectedCell.story, selectedCell.action))) {
      setSelectedCell(null)
    }
  }, [storyActionMatrix, selectedCell])

  const [waterfallOpen, setWaterfallOpen] = useState(false)
  const [waterfallInitialKey, setWaterfallInitialKey] = useState(null)
  // The fully filtered + sorted action rows, published up by the table so the
  // waterfall picker, the KPIs and the histogram all reflect exactly what the
  // table shows (every column / search / time / timeline / anomaly filter).
  const [filteredActionRows, setFilteredActionRows] = useState([])

  // The action currently hovered in the table (or null) → the anomaly panel
  // switches to "this action" mode and shows just its flags.
  const [hoveredActionKey, setHoveredActionKey] = useState(null)
  // The active click-to-filter selection: an anomaly type key, '__total__', or
  // null. Toggling the same value clears it. Seeded from (and persisted to)
  // viewUi.action so the selection survives drilling to Widget view + Back —
  // pushNavSnapshot captures viewUi, and restoreDrillState puts it back before
  // this view re-mounts (mirrors the table's search / filters / sort).
  const [anomalyTypeFilter, setAnomalyTypeFilter] = useState(
    () => viewUi.action.anomalyTypeFilter ?? null,
  )
  const selectAnomalyType = (type) =>
    setAnomalyTypeFilter((prev) => (prev === type ? null : type))

  // The active duration-histogram bucket selection (a DURATION_BUCKETS key, or
  // null). Toggling the same bucket clears it. Clicking a bar reshapes the whole
  // rail + table to that duration range; only the histogram itself stays on the
  // full distribution (it's the control being clicked). Persisted like the
  // anomaly filter above so it survives Back.
  const [durationBucket, setDurationBucket] = useState(
    () => viewUi.action.durationBucket ?? null,
  )
  const selectDurationBucket = (key) =>
    setDurationBucket((prev) => (prev === key ? null : key))

  // Persist the two rail selections into viewUi so the nav snapshot captures
  // them (setViewUi merges, so this leaves the table's own keys untouched).
  useEffect(() => {
    setViewUi('action', { anomalyTypeFilter, durationBucket })
  }, [anomalyTypeFilter, durationBucket, setViewUi])

  const durationBucketFilter = durationBucket
    ? bands.find((b) => b.key === durationBucket) ?? null
    : null

  // The visible action set narrowed to the selected duration bucket. This feeds
  // the KPI strip, the anomaly-summary counts and the waterfall picker so they
  // recompute to the chosen range — matching the table below (which applies the
  // same predicate). The histogram itself stays on the pre-bucket
  // `filteredActionRows` so its bars keep the full distribution.
  const bucketedRows = useMemo(
    () =>
      durationBucket
        ? filteredActionRows.filter((r) => bucketKeyOf(r.action_duration, bands) === durationBucket)
        : filteredActionRows,
    [filteredActionRows, durationBucket, bands],
  )

  // Rail KPIs track the visible (filtered) action set, matching the old header
  // strip. The ">30s actions" tile is a pure headline count: timeframe
  // drill-down lives in the duration histogram (click a 30s–1m / 1–2m / >2m bar
  // to filter the table to that band), so the tile no longer doubles as a filter
  // — its ≥30s count and the slow_action anomaly (≥2m) are now different sets.
  const kpis = useMemo(
    () => actionKpisFromAgg(bucketedRows, mapping),
    [bucketedRows, mapping],
  )

  const durations = useMemo(
    () => filteredActionRows.map((r) => r.action_duration),
    [filteredActionRows],
  )

  // Re-tally the anomaly panel over exactly the rows the table currently shows,
  // so every column / search / time / anomaly filter reshapes the panel counts
  // (not just the KPIs + histogram). byActionKey covers the whole scope; we only
  // narrow the denominator + numerators to the visible action keys.
  const filteredSummary = useMemo(() => {
    const keys = bucketedRows.map(
      (r) => `${r.action_name}::${r._action_timestamp ?? ''}`,
    )
    return summarizeActionFlags(keys, anomalies.byActionKey)
  }, [bucketedRows, anomalies.byActionKey])

  // Rank the visible anomaly types into T1/T2/T3 by prevalence (highest share of
  // actions = T1). Derived from the SAME counts the panel shows, so its badges
  // and the table's per-row badges agree, and both re-tier as the view filters.
  const tierByType = useMemo(
    () => rankAnomalyTiers(filteredSummary.counts),
    [filteredSummary.counts],
  )

  const hoveredFlags = hoveredActionKey
    ? anomalies.byActionKey.get(hoveredActionKey) ?? []
    : null

  // When a row is hovered, the histogram collapses to just that action's
  // placement — its bucket fills, every other bucket reads 0 — mirroring the
  // panel's "this action" mode. null → the normal full distribution.
  const hoveredDuration = useMemo(() => {
    if (!hoveredActionKey) return null
    const hit = bucketedRows.find(
      (r) => `${r.action_name}::${r._action_timestamp ?? ''}` === hoveredActionKey,
    )
    return hit ? hit.action_duration : null
  }, [hoveredActionKey, bucketedRows])

  // The picker list for the Action Waterfall panel mirrors the table's filtered
  // + sorted rows, so the panel's "N / total" and its arrow navigation always
  // match the count shown above the table. EVERY filter flows through
  // `filteredActionRows` — the Session/User/Story/Page dropdowns, the Time
  // menu, the Activity Timeline range, AND the anomaly filter — so all stay
  // consistent.
  const waterfallActions = useMemo(
    () =>
      bucketedRows.map((r) => ({
        name: r.action_name,
        timestamp: r._action_timestamp ?? '',
        label: r._action_timestamp
          ? `${r.action_name} — ${r._action_timestamp}`
          : String(r.action_name),
        story: r.story_name,
        user: r.user,
        durationMs: r.action_duration,
      })),
    [bucketedRows],
  )

  const openWaterfallFor = ({ name, timestamp }) => {
    setWaterfallInitialKey(`${name}::${timestamp ?? ''}`)
    setWaterfallOpen(true)
  }

  // Scroll the inline waterfall panel into view when it opens (or when a
  // per-row icon retargets it to a different action while already open). Keyed
  // on open + initialKey, NOT on the picker index, so stepping through actions
  // doesn't yank the page. Respects reduced-motion.
  const panelRef = useRef(null)
  useEffect(() => {
    if (!waterfallOpen) return
    const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth'
    panelRef.current?.scrollIntoView({ behavior, block: 'start' })
  }, [waterfallOpen, waterfallInitialKey])

  // Chart-shortcut header tabs above the table. Each reveals its chart panel
  // below the table (charts are placeholders for now) and scrolls down to it —
  // only ONE shows at a time, and none show until a tab is clicked. Clicking the
  // active tab again collapses it. The scroll runs in an effect (not the click
  // handler) because the panel only mounts once `activeChartTab` is set.
  const [activeChartTab, setActiveChartTab] = useState(null)
  const chartPanelRef = useRef(null)
  const toggleChart = (key) =>
    setActiveChartTab((prev) => (prev === key ? null : key))
  useEffect(() => {
    if (!activeChartTab) return
    const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth'
    chartPanelRef.current?.scrollIntoView({ behavior, block: 'start' })
  }, [activeChartTab])

  return (
    <>
      <HeaderPortal>
        <KpiStrip variant="action" kpis={kpis} columns={kpis.length} />
      </HeaderPortal>

      <div className="action-view">
        <aside className="action-view__rail" aria-label="Action anomaly summary">
          <DurationDistribution
            durations={durations}
            bands={bands}
            highlightDuration={hoveredDuration}
            activeBucketKey={durationBucket}
            onSelectBucket={selectDurationBucket}
          />
          <AnomalySummaryPanel
            counts={filteredSummary.counts}
            totalFlagged={filteredSummary.totalFlagged}
            totalActions={filteredSummary.totalActions}
            hoveredFlags={hoveredFlags}
            activeType={anomalyTypeFilter}
            onSelectType={selectAnomalyType}
            tierByType={tierByType}
          />
        </aside>

        <div className="action-view__main">
          <nav className="action-chart-tabs" aria-label="Jump to chart">
            <button
              type="button"
              className={`action-chart-tab${activeChartTab === 'offset' ? ' is-active' : ''}`}
              onClick={() => toggleChart('offset')}
            >
              Offset vs Duration
            </button>
            <button
              type="button"
              className={`action-chart-tab${activeChartTab === 'heatmap' ? ' is-active' : ''}`}
              onClick={() => toggleChart('heatmap')}
            >
              Story × Action Heatmap
            </button>
          </nav>

          <ActionSummaryTable
            rows={rows}
            headers={headers}
            onOpenWaterfall={openWaterfallFor}
            onFilteredActionsChange={setFilteredActionRows}
            byActionKey={anomalies.byActionKey}
            anomalyTypeFilter={anomalyTypeFilter}
            onHoverAction={setHoveredActionKey}
            onClearAnomalyFilter={() => setAnomalyTypeFilter(null)}
            durationBucketFilter={durationBucketFilter}
            onClearDurationBucket={() => setDurationBucket(null)}
            bands={bands}
            tierByType={tierByType}
          />

          {waterfallOpen && (
            <div ref={panelRef}>
              <ActionWaterfallPanel
                open={waterfallOpen}
                onClose={() => setWaterfallOpen(false)}
                rows={scopedRows}
                headers={headers}
                actions={waterfallActions}
                initialKey={waterfallInitialKey}
              />
            </div>
          )}
          {activeChartTab && (
            <section ref={chartPanelRef} className="action-chart-placeholder">
              <div className="action-chart-placeholder__title">
                {activeChartTab === 'offset'
                  ? 'Offset vs Duration'
                  : 'Story × Action Heatmap'}
              </div>
              {activeChartTab === 'heatmap' ? (
                <>
                  <ActionStoryHeatmap
                    matrix={storyActionMatrix}
                    selectedKey={selectedCellKey}
                    onSelectCell={(story, action) =>
                      setSelectedCell((prev) =>
                        prev && prev.story === story && prev.action === action
                          ? null
                          : { story, action },
                      )
                    }
                  />
                  {selectedCell && selectedCellData && (
                    <ActionCellDetail
                      story={selectedCell.story}
                      action={selectedCell.action}
                      cell={selectedCellData}
                      rows={scopedRows}
                      headers={headers}
                      byActionKey={anomalies.byActionKey}
                      tierByType={tierByType}
                      onClose={() => setSelectedCell(null)}
                    />
                  )}
                </>
              ) : (
                <div className="action-chart-placeholder__empty">Chart coming soon</div>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  )
}

export default ActionView
