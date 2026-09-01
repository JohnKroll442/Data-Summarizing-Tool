import { useEffect, useMemo, useRef, useState } from 'react'
import { scrollFast } from '../../lib/scrollFast'
import KpiStrip from '../../components/KpiStrip'
import ActionViewSwitcher from '../../components/ActionViewSwitcher'
import ActionDataTablePanel from '../../components/ActionDataTablePanel'
import ActionHeatmapPanel from '../../components/ActionHeatmapPanel'
import ActionOffsetPanel from '../../components/ActionOffsetPanel'
import ActivityTimeline from '../../components/ActivityTimeline'
import { useCsvData } from '../../context/useCsvData'
import { HeaderPortal } from '../../context/HeaderSlot'
import { applySessionFilter, applySessionMultiFilter } from '../../lib/drillDown'
import { aggregateByAction } from '../../lib/actionAggregate'
import { actionKpisFromAgg } from '../../lib/kpis'
import { bucketKeyOf } from '../../lib/durationBands'
import { matchesTimeRange } from '../../lib/timeBuckets'
import { ACTION_TS } from '../../lib/viewFilters'
import { detectAnomalies, summarizeActionFlags, rankAnomalyTiers, buildOffsetDurationPoints } from '../../lib/anomalyDetect'
import { OFFSET_CLASS_LEGEND, OFFSET_LEGEND_DEFAULT } from '../../components/charts/options/offsetDuration'
import { buildStoryActionMatrix, cellKeyOf } from '../../lib/storyActionMatrix'
import { resolveActiveView } from '../../lib/actionViews'
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
  const { rows, headers, sessionFilter, sessionMultiFilter, viewUi, setViewUi, timelineRange, thresholds } = useCsvData()

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
    () => detectAnomalies(scopedRows, headers, thresholds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopedRows, headers, thresholds.slowActionMs, thresholds.healthyCeilingMs],
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

  // The max-duration crosstab behind the "Story × Action heatmap" chart tab. Scoped to
  // the session (like the rail), independent of the table's column filters.
  const storyActionMatrix = useMemo(
    () => buildStoryActionMatrix(aggRows),
    [aggRows],
  )

  // One (duration, max widget offset) point per action instance for the Offset
  // vs Duration scatter — reuses the detector's exact offset/duration math (same
  // scope as the rail; a cache hit shares detectAnomalies' grouping).
  const offsetDuration = useMemo(
    () => buildOffsetDurationPoints(scopedRows, headers, thresholds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopedRows, headers, thresholds.slowActionMs],
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
  // The action name, story, and timestamp of the row whose waterfall icon was
  // clicked. Used to build the ActionCellDetail instance list (all visible
  // instances of that action name) and to pre-select the clicked instance.
  const [waterfallActionName, setWaterfallActionName] = useState(null)
  const [waterfallStory, setWaterfallStory] = useState(null)
  const [waterfallInitialTs, setWaterfallInitialTs] = useState(null)
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

  // Show/Hide anomalies toggle — controls both the table filter (drops flagged
  // rows when OFF) and the visibility of the AnomalySummaryPanel in the rail.
  // Seeded from and persisted to viewUi.action so it survives Back navigation.
  const [showAnomalies, setShowAnomalies] = useState(
    () => viewUi.action.showAnomalies ?? true,
  )

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

  // Tracks which offset-scatter series are currently visible (mirrors the chart
  // legend). Initialised from OFFSET_LEGEND_DEFAULT (same value the chart starts
  // with) and updated via onLegendChange whenever the user clicks a legend item.
  // Resets on tab switch because ActionOffsetPanel remounts, which re-initialises
  // the ECharts legend from its option — keeping both in sync.
  const [offsetLegendSelected, setOffsetLegendSelected] = useState(OFFSET_LEGEND_DEFAULT)

  // Which of the three top-level views is active. Seeded from (and persisted
  // to) viewUi.action.activeView so it survives drilling to Widget view + Back.
  const [activeView, setActiveView] = useState(
    () => resolveActiveView(viewUi.action.activeView),
  )

  // Persist the two rail selections into viewUi so the nav snapshot captures
  // them (setViewUi merges, so this leaves the table's own keys untouched).
  useEffect(() => {
    setViewUi('action', { anomalyTypeFilter, durationBucket, activeView, showAnomalies })
  }, [anomalyTypeFilter, durationBucket, activeView, showAnomalies, setViewUi])

  const durationBucketFilter = durationBucket
    ? bands.find((b) => b.key === durationBucket) ?? null
    : null

  // When on the timeOfDay tab, the table is not mounted so filteredActionRows
  // is stale or empty. Use aggRows (full session-scoped set) filtered to the
  // chart's visible window instead. On all other tabs, keep using filteredActionRows
  // so every table filter continues to reshape the KPIs as before.
  const timeOfDayBase = useMemo(() => {
    if (activeView !== 'timeOfDay') return filteredActionRows
    if (!timelineRange) return aggRows
    return aggRows.filter((r) => matchesTimeRange(r, ACTION_TS, timelineRange))
  }, [activeView, aggRows, filteredActionRows, timelineRange])

  // When on the offset tab, the table is not mounted so filteredActionRows is
  // stale or empty. Build KPI base from aggRows, joined to offsetDuration.points
  // (the only source of klass), filtered to the series visible in the legend.
  // aggRows rows with no scatter point (no widget offset data) are excluded —
  // they're invisible on the chart regardless of legend state.
  // On all other tabs, chain through timeOfDayBase so both fixes compose cleanly.
  const offsetBase = useMemo(() => {
    if (activeView !== 'offset') return timeOfDayBase

    // klass lookup: actionKey = "name::timestamp" matches aggRows' own key format
    const klassMap = new Map(
      offsetDuration.points.map((p) => [p.actionKey, p.klass])
    )
    const visibleKlasses = new Set(
      OFFSET_CLASS_LEGEND
        .filter((c) => offsetLegendSelected[c.name] !== false)
        .map((c) => c.klass)
    )
    return aggRows.filter((r) => {
      const key = `${r.action_name}::${r._action_timestamp ?? ''}`
      const klass = klassMap.get(key)
      return klass !== undefined && visibleKlasses.has(klass)
    })
  }, [activeView, aggRows, timeOfDayBase, offsetLegendSelected, offsetDuration])

  // The visible action set narrowed to the selected duration bucket. This feeds
  // the KPI strip, the anomaly-summary counts and the waterfall picker so they
  // recompute to the chosen range — matching the table below (which applies the
  // same predicate). The histogram itself stays on the pre-bucket
  // `filteredActionRows` so its bars keep the full distribution.
  const bucketedRows = useMemo(
    () =>
      durationBucket
        ? offsetBase.filter((r) => bucketKeyOf(r.action_duration, bands) === durationBucket)
        : offsetBase,
    [offsetBase, durationBucket, bands],
  )

  // Rail KPIs track the visible (filtered) action set, matching the old header
  // strip. The ">30s actions" tile is a pure headline count: timeframe
  // drill-down lives in the duration histogram (click a 30s–1m / 1–2m / >2m bar
  // to filter the table to that band), so the tile no longer doubles as a filter
  // — its ≥30s count and the slow_action anomaly (≥2m) are now different sets.
  const kpis = useMemo(
    () => actionKpisFromAgg(bucketedRows, mapping, thresholds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bucketedRows, mapping, thresholds.slowActionMs],
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

  const openWaterfallFor = ({ name, timestamp, story }) => {
    setWaterfallInitialKey(`${name}::${timestamp ?? ''}`)
    setWaterfallActionName(name ?? null)
    setWaterfallStory(story ?? null)
    setWaterfallInitialTs(timestamp ?? null)
    setWaterfallOpen(true)
  }

  // Instances of the clicked action name from the current filtered + bucketed
  // rows. Passed to ActionCellDetail as `cell` so the left instance list shows
  // every visible run of that action (sorted slowest-first inside the detail).
  const detailCell = useMemo(() => {
    if (!waterfallOpen || !waterfallActionName) return null
    const instances = bucketedRows.filter((r) => r.action_name === waterfallActionName)
    const nums = instances
      .map((r) => r.action_duration)
      .filter((v) => typeof v === 'number' && Number.isFinite(v))
    return {
      duration: nums.length ? Math.max(...nums) : null,
      count: instances.length,
      instances,
    }
  }, [waterfallOpen, waterfallActionName, bucketedRows])

  // Scroll the inline waterfall panel into view when it opens (or when a
  // per-row icon retargets it to a different action while already open). Keyed
  // on open + initialKey, NOT on the picker index, so stepping through actions
  // doesn't yank the page.
  //
  // The rAF lets the browser paint the panel's first frame — including its
  // initial height — before we calculate the scroll target. Without it the
  // target position can shift mid-animation as the ECharts chart renders,
  // causing a visible jump. 350 ms gives the scroll time to breathe alongside
  // the panel's entrance animation.
  const panelRef = useRef(null)
  useEffect(() => {
    if (!waterfallOpen) return
    requestAnimationFrame(() => scrollFast(panelRef.current, 350))
  }, [waterfallOpen, waterfallInitialKey])

  // Toggle the heatmap cell drill-down: clicking the open cell closes it.
  const handleSelectCell = (story, action) =>
    setSelectedCell((prev) =>
      prev && prev.story === story && prev.action === action ? null : { story, action },
    )

  // Scroll the heatmap's inline Action detail into view when a cell is picked
  // (or when clicking a different cell retargets it), mirroring the waterfall
  // panel above so the drill-down is never off-screen. Keyed on the cell key so
  // it fires on open and on retarget, but not on closing.
  const detailRef = useRef(null)
  useEffect(() => {
    if (!selectedCellKey) return
    requestAnimationFrame(() => scrollFast(detailRef.current, 350))
  }, [selectedCellKey])

  return (
    <>
      <HeaderPortal>
        <KpiStrip variant="action" kpis={kpis} columns={kpis.length} />
      </HeaderPortal>

      <div className="action-view-shell">
        <ActionViewSwitcher activeView={activeView} onChange={setActiveView} />

        {activeView === 'table' && (
          <ActionDataTablePanel
            durations={durations}
            bands={bands}
            hoveredDuration={hoveredDuration}
            durationBucket={durationBucket}
            onSelectBucket={selectDurationBucket}
            anomalyCounts={filteredSummary.counts}
            totalFlagged={filteredSummary.totalFlagged}
            totalActions={filteredSummary.totalActions}
            hoveredFlags={hoveredFlags}
            anomalyTypeFilter={anomalyTypeFilter}
            onSelectAnomalyType={selectAnomalyType}
            tierByType={tierByType}
            rows={rows}
            headers={headers}
            onOpenWaterfall={openWaterfallFor}
            onFilteredActionsChange={setFilteredActionRows}
            byActionKey={anomalies.byActionKey}
            onHoverAction={setHoveredActionKey}
            onClearAnomalyFilter={() => setAnomalyTypeFilter(null)}
            durationBucketFilter={durationBucketFilter}
            onClearDurationBucket={() => setDurationBucket(null)}
            waterfallOpen={waterfallOpen}
            waterfallActions={waterfallActions}
            waterfallInitialKey={waterfallInitialKey}
            scopedRows={scopedRows}
            onCloseWaterfall={() => setWaterfallOpen(false)}
            panelRef={panelRef}
            showAnomalies={showAnomalies}
            setShowAnomalies={setShowAnomalies}
            detailCell={detailCell}
            detailActionName={waterfallActionName}
            detailStory={waterfallStory}
            detailInitialTs={waterfallInitialTs}
            thresholds={thresholds}
          />
        )}

        {activeView === 'heatmap' && (
          <ActionHeatmapPanel
            matrix={storyActionMatrix}
            selectedKey={selectedCellKey}
            selectedCell={selectedCell}
            selectedCellData={selectedCellData}
            onSelectCell={handleSelectCell}
            scopedRows={scopedRows}
            headers={headers}
            byActionKey={anomalies.byActionKey}
            tierByType={tierByType}
            onCloseDetail={() => setSelectedCell(null)}
            detailRef={detailRef}
          />
        )}

        {activeView === 'offset' && (
          <ActionOffsetPanel
            data={offsetDuration}
            matrix={storyActionMatrix}
            rows={scopedRows}
            headers={headers}
            byActionKey={anomalies.byActionKey}
            tierByType={tierByType}
            onLegendChange={setOffsetLegendSelected}
          />
        )}

        {activeView === 'timeOfDay' && (
          <ActivityTimeline
            embedded
            matrix={storyActionMatrix}
            byActionKey={anomalies.byActionKey}
            tierByType={tierByType}
            scopedRows={scopedRows}
            actionRows={aggRows}
          />
        )}

      </div>
    </>
  )
}

export default ActionView
