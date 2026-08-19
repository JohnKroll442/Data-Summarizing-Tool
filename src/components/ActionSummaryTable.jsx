import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import WaterfallIcon from './icons/WaterfallIcon'
import AnalyticalDataTable from './AnalyticalDataTable'
import { FilterPills } from './FilterPill'
import BackButton from './BackButton'
import { usePagination, PageSizeSelect, TablePager } from './Pagination'
import { Button } from '@ui5/webcomponents-react/Button'
import MultiFilterMenu from './MultiFilterMenu'
import ColumnChooserMenu from './ColumnChooserMenu'
import DurationFilterMenu from './DurationFilterMenu'
import PhaseHoverCell from './PhaseHoverCell'
import TierBadge from './TierBadge'
import { bucketKeyOf } from '../lib/durationBands'
import { aggregateByAction, RECOGNIZED_MEASURES } from '../lib/actionAggregate'
import { ANOMALY_TYPES, isAnomalyFlagged } from '../lib/anomalyDetect'
import { applySessionFilter, applySessionMultiFilter, detectSessionKey } from '../lib/drillDown'
import { formatDurationMs, formatTimeRangeLabel } from '../lib/format'
import { sortRows } from '../lib/sortRows'
import { rowsToCsv, downloadCsv, buildExportFilename } from '../lib/exportCsv'
import { countActiveMultiFilters, facetedOptionsByColumn } from '../lib/multiFilter'
import { matchesTimeFilter, matchesTimeRange, hasTimeSelection, emptyTimeSelections } from '../lib/timeBuckets'
import { matchesDurationFilter } from '../lib/durationFilter'
import { filterAggRows, ACTION_TS } from '../lib/viewFilters'
import { useCsvData } from '../context/useCsvData'
import './SessionSummaryTable.css'

/**
 * ActionSummaryTable — one row per action, columns:
 *   User · Action name · Widget count · Max frontend · Max network · Max backend
 *
 * Aggregates rows down to one-row-per-action AFTER applying the
 * `sessionFilter` from the CSV context, so clicking a Session ID over on
 * Session View scopes this whole table to that session. A pill above the
 * filter bar shows the active session filter; an × clears it.
 *
 * Clicking the Action name cell sets the `actionFilter` (name + timestamp)
 * and routes to Widget View for the next level of drill-down.
 */
// Stable per-invocation key for an action row: actions are grouped by name +
// invocation timestamp (not session), so both are needed to identify one.
const actionKey = (r) => `${r.action_name}::${r._action_timestamp ?? ''}`

function ActionSummaryTable({
  rows,
  headers,
  onOpenWaterfall,
  onFilteredActionsChange,
  byActionKey,
  anomalyTypeFilter = null,
  onHoverAction,
  onClearAnomalyFilter,
  durationBucketFilter = null,
  onClearDurationBucket,
  bands = null,
  tierByType = null,
  showAnomalies = true,
  setShowAnomalies,
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const {
    sessionFilter,
    setSessionFilter,
    setActionFilter,
    actionMultiFilter,
    setActionMultiFilter,
    sessionMultiFilter,
    setSessionMultiFilter,
    timelineRange,
    resetTimeline,
    fileName,
    timeSelections: timeFilter,
    setTimeSelections: setTimeFilter,
    actionInvocationFilter,
    setActionInvocationFilter,
    actionFilterWindow,
    setActionFilterWindow,
    pushNavSnapshot,
    viewUi,
    setViewUi,
    viewedItems,
    markViewed,
  } = useCsvData()



  // Scope the input rows BEFORE aggregating. The multiselect Sessions filter,
  // when active, takes over the row scope (letting the user pick any set of
  // sessions from the whole file); otherwise the single-session drill-down
  // from Session View applies.
  const scopedRows = useMemo(() => {
    if (sessionMultiFilter.length > 0) {
      return applySessionMultiFilter(rows, headers, sessionMultiFilter)
    }
    return applySessionFilter(rows, headers, sessionFilter)
  }, [rows, headers, sessionFilter, sessionMultiFilter])

  // Session ids for the dropdown — ALL sessions in the file, so the user can
  // pick any session regardless of how they drilled in.
  const sessionOptions = useMemo(() => {
    const key = detectSessionKey(headers, rows)
    if (!key) return []
    const set = new Set()
    for (const r of rows) {
      const v = r?.[key]
      if (v === undefined || v === null || v === '') continue
      set.add(String(v))
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [rows, headers])

  const { rows: summaryRows, columns, mapping } = useMemo(
    () => aggregateByAction(scopedRows, headers),
    [scopedRows, headers]
  )



  const [search, setSearch] = useState(() => viewUi.action.search)
  // Seed the local UI filters from the persisted per-view state so they stay
  // constant across navigation (tab switches, drill + Back). When nothing's
  // persisted yet, fall back to the shared actionMultiFilter for the Action
  // column. A one-shot `summaryFilters` router state (from the Summary tab's
  // top-10 rows) always layers on top, pre-selecting the clicked action + story.
  const [filters, setFilters] = useState(() => {
    const nav = location.state?.summaryFilters
    const persisted = viewUi.action.filters
    const base = (persisted && Object.keys(persisted).length > 0)
      ? persisted
      : (actionMultiFilter.length > 0 ? { action_name: actionMultiFilter } : {})
    return nav ? { ...base, ...nav } : base
  })
  const [sort, setSort] = useState(() => viewUi.action.sort)
  const [durationFilter, setDurationFilter] = useState(() => viewUi.action.durationFilter)
  // Which columns are hidden (display-only preference). The first column is
  // always shown and isn't offered as a toggle (see visibleColumns / toolbar).
  const [hiddenColumns, setHiddenColumns] = useState(() => viewUi.action.hiddenColumns ?? [])


  // Action name is always shown and never offered as a toggle (see
  // ACTION_LOCKED_COLUMNS). `chooserColumns` is the toggleable set the dropdown
  // lists; `visibleColumns` is what the table renders — locked columns plus any
  // the user hasn't hidden. The full `columns` list stays intact for CSV
  // export, sorting, and faceted filters — only the rendered set shrinks.
  const chooserColumns = useMemo(
    () => columns.filter((c) => !ACTION_LOCKED_COLUMNS.includes(c.key)),
    [columns],
  )
  const visibleColumns = useMemo(() => {
    const shown = columns.filter(
      (c) => ACTION_LOCKED_COLUMNS.includes(c.key) || !hiddenColumns.includes(c.key),
    )
    // Surface the locked label column(s) on the far left so the clickable
    // action name leads every row — matching the Session view.
    const locked = shown.filter((c) => ACTION_LOCKED_COLUMNS.includes(c.key))
    const rest = shown.filter((c) => !ACTION_LOCKED_COLUMNS.includes(c.key))
    return [...locked, ...rest]
  }, [columns, hiddenColumns])

  // Persist UI-filter changes so they survive this view unmounting (see the
  // matching effect in SessionSummaryTable). Can't loop: setViewUi is stable
  // and writing back doesn't change these local values.
  useEffect(() => {
    setViewUi('action', { search, filters, sort, durationFilter, hiddenColumns })
  }, [search, filters, sort, durationFilter, hiddenColumns, setViewUi])

  // Faceted options: each dropdown lists only values that still apply given the
  // OTHER active column filters, the time filter, the timeline range, and any
  // Actions-bar drill (a set of invocation timestamps). The session scope is
  // already baked into summaryRows (rows are filtered before aggregation).
  const optionsByColumn = useMemo(
    () => facetedOptionsByColumn(summaryRows, FILTERABLE_COLUMNS, filters,
      (row) => matchesTimeFilter(row, ACTION_TS, timeFilter)
        && matchesTimeRange(row, ACTION_TS, timelineRange)
        && matchesDurationFilter(row, 'action_duration', durationFilter)
        && (actionInvocationFilter.length === 0 || actionInvocationFilter.includes(String(row._action_timestamp)))),
    [summaryRows, filters, timeFilter, timelineRange, actionInvocationFilter, durationFilter],
  )

  // Rows the Time filter derives its buckets from — narrowed by the column
  // filters, the timeline range, and the invocation drill (but not by time
  // itself) so the time options track the other menus.
  const visibleRows = useMemo(
    () => filterAggRows(summaryRows, columns, {
      tsAccessor: ACTION_TS,
      timeFilter,
      timelineRange,
      filters,
      durationKey: 'action_duration',
      durationFilter,
      invocationFilter: actionInvocationFilter,
      search,
    }),
    [summaryRows, search, filters, columns, timeFilter, timelineRange, actionInvocationFilter, durationFilter],
  )

  // Overlay the click-to-filter anomaly selection (from the left-rail panel or
  // the >30s KPI tile) on top of every other filter. Detection is global and
  // lives in ActionView (passed down as `byActionKey`); here we just intersect
  // the already-filtered rows with the flagged action keys for the chosen type.
  // '__total__' keeps any-flag rows; a specific type keeps rows carrying it.
  const anomalyFilteredRows = useMemo(() => {
    if (!byActionKey) return visibleRows
    let base = visibleRows
    // Hide-anomalies toggle: drop the any-anomaly set — actions with a HEADLINE
    // flag — so the number hidden equals the panel's "Any anomaly" total. A
    // phase-attribution-only action isn't an anomaly, so it stays visible.
    if (!showAnomalies) {
      base = base.filter((row) => !isAnomalyFlagged(byActionKey.get(actionKey(row))))
    }
    if (!anomalyTypeFilter) return base
    return base.filter((row) => {
      const flags = byActionKey.get(actionKey(row))
      if (!flags || flags.length === 0) return false
      // '__total__' is the any-anomaly union — actions carrying a HEADLINE flag,
      // matching the panel's "Any anomaly" total (a phase-attribution-only action
      // isn't in the union, see isAnomalyFlagged).
      if (anomalyTypeFilter === '__total__') return isAnomalyFlagged(flags)
      return flags.some((f) => f.type === anomalyTypeFilter)
    })
  }, [visibleRows, anomalyTypeFilter, byActionKey, showAnomalies])

  const sortedRows = useMemo(() => {
    if (!sort) return anomalyFilteredRows
    const col = columns.find((c) => c.key === sort.key)
    return sortRows(anomalyFilteredRows, sort.key, sort.dir, col?.sortType)
  }, [anomalyFilteredRows, sort, columns])

  // Overlay the duration-histogram bucket selection (from the left-rail
  // DurationDistribution) as the LAST layer, shown in the table body / pager /
  // export. We publish the pre-bucket `sortedRows` up (below) so the rail's
  // histogram keeps the full distribution; ActionView re-applies this same
  // bucket predicate to reshape the KPIs + anomaly panel. `bucketKeyOf` is the
  // same helper that draws the bars, so the rows shown equal the bar's height.
  const displayRows = useMemo(() => {
    if (!durationBucketFilter) return sortedRows
    return sortedRows.filter(
      (r) => bucketKeyOf(r.action_duration, bands) === durationBucketFilter.key,
    )
  }, [sortedRows, durationBucketFilter, bands])

  const { pageRows, page, setPage, pageSize, setPageSize, pageCount } =
    usePagination(displayRows)

  // Publish the fully filtered + sorted action rows up so the Action Waterfall
  // modal navigates exactly the actions shown in this table (respecting every
  // column, search, time, and timeline filter) instead of the whole session
  // scope. `sortedRows` is memoized, so this only fires when the visible set
  // actually changes; the parent's setter is stable, so there's no loop.
  useEffect(() => {
    onFilteredActionsChange?.(sortedRows)
  }, [sortedRows, onFilteredActionsChange])

  const activeFilterCount =
    countActiveMultiFilters(filters, search) +
    (sessionMultiFilter.length > 0 ? 1 : 0) +
    (hasTimeSelection(timeFilter) ? 1 : 0) +
    (timelineRange ? 1 : 0) +
    (actionInvocationFilter.length > 0 ? 1 : 0) +
    (durationFilter ? 1 : 0) +
    (anomalyTypeFilter ? 1 : 0) +
    (durationBucketFilter ? 1 : 0) +
    (!showAnomalies ? 1 : 0) +
    (hiddenColumns.length > 0 ? 1 : 0)

  // Sanity-check the WIDGET_MEASURE values themselves. If the column exists
  // but contains none of render/frontend/network/backend/offset, every phase
  // max will be '' — surface that as a distinct warning so the user doesn't
  // think the durations are wrong.
  const unrecognizedMeasure = useMemo(() => {
    if (!mapping.measure) return null
    const seen = new Set()
    for (const r of scopedRows) {
      const v = r?.[mapping.measure]
      if (v === undefined || v === null || v === '') continue
      seen.add(String(v).toLowerCase())
    }
    if (seen.size === 0) return null
    const wanted = new Set(RECOGNIZED_MEASURES)
    for (const v of seen) if (wanted.has(v)) return null
    return Array.from(seen).slice(0, 8).join(', ')
  }, [scopedRows, mapping.measure])

  // Drill-down pill — render BEFORE the data-shape error gates so the user
  // can always escape an "0 actions for this session" empty state.

  // Update a local column filter, mirroring the Action column into the shared
  // multi-filter that Widget View reads (matches the drill-down flow).
  const updateFilter = (colKey, next) => {
    setFilters((prev) => ({ ...prev, [colKey]: next }))
    if (colKey === 'action_name') setActionMultiFilter(next)
  }

  // The active session scope: the multiselect Sessions filter when set,
  // otherwise the single-session drill-down from Session View.
  const sessionPillValues = sessionMultiFilter.length > 0
    ? sessionMultiFilter
    : (sessionFilter ? [sessionFilter] : [])

  const removeSession = (val) => {
    const next = sessionPillValues.filter((v) => v !== val)
    setSessionMultiFilter(next)
    // Clear the single drill-down too so scope and pills stay in sync.
    if (sessionFilter === val) setSessionFilter(null)
  }

  // Clear the whole Session scope at once (from the collapsed summary chip).
  const clearAllSessions = () => {
    setSessionMultiFilter([])
    setSessionFilter(null)
  }

  // One removable pill per active session, then one per selected value in the
  // local column filters (User / Action / Story / Page).
  const pillItems = [
    ...sessionPillValues.map((val) => ({
      key: `session:${val}`,
      label: 'Session',
      value: val,
      onClear: () => removeSession(val),
      onClearAll: clearAllSessions,
    })),
    ...FILTERABLE_COLUMNS.flatMap((col) => {
      const selected = Array.isArray(filters[col.key]) ? filters[col.key] : []
      return selected.map((val) => ({
        key: `${col.key}:${val}`,
        label: col.label,
        value: val,
        onClear: () => updateFilter(col.key, selected.filter((v) => v !== val)),
        onClearAll: () => updateFilter(col.key, []),
      }))
    }),
  ]
  const pill = (
    <>
      <BackButton />
      <FilterPills items={pillItems} />
    </>
  )

  // The rank badge (T1/T2/T3) for an action row: the MOST severe tier — the
  // lowest number — among its anomaly flags. Tiers are computed in ActionView
  // from the visible anomaly-type percentages (rankAnomalyTiers) and passed
  // down, so a row's badge tracks the same ranking the summary panel shows.
  // null → the row has no flagged (ranked) anomaly, so no badge.
  const rowTier = (row) => {
    if (!tierByType || tierByType.size === 0 || !byActionKey) return null
    const flags = byActionKey.get(actionKey(row))
    if (!flags || !flags.length) return null
    let best = null
    for (const f of flags) {
      const t = tierByType.get(f.type)
      if (t != null && (best === null || t < best)) best = t
    }
    return best
  }

  if (!mapping.actionName) {
    return (
      <>
        {pill}
        <div className="summary-note">
          Couldn't find an action column in your CSV (looked for{' '}
          <code>USER_ACTION</code> / <code>ACTION_NAME</code>). Detected headers:{' '}
          <code>{headers.length === 0 ? '(none)' : headers.join(', ')}</code>
        </div>
      </>
    )
  }

  if (summaryRows.length === 0) {
    return (
      <>
        {pill}
        <div className="summary-note">
          {sessionMultiFilter.length > 0 ? (
            <>
              <strong>No actions match the selected sessions.</strong>{' '}
              <button
                type="button"
                className="summary-filter-clear"
                onClick={() => setSessionMultiFilter([])}
              >
                Clear session filter
              </button>
            </>
          ) : sessionFilter ? (
            <>
              <strong>No actions found for this session.</strong> Clear the
              filter above to see actions across every session.
            </>
          ) : (
            <>
              <strong>No actions could be built.</strong> Detected{' '}
              {scopedRows.length.toLocaleString()} CSV row{scopedRows.length === 1 ? '' : 's'},
              grouping by <code>{mapping.actionName}</code>{mapping.actionTimestamp ? <> + <code>{mapping.actionTimestamp}</code></> : null}.
              Every row had an empty value in {mapping.actionName}.
            </>
          )}
        </div>
      </>
    )
  }

  const missing = []
  if (!mapping.user)            missing.push('User')
  if (!mapping.actionTimestamp) missing.push('Action timestamp (without it, two invocations of the same action collapse into one row)')
  if (!mapping.widgetId)        missing.push('Widget count (needs a WIDGET_ID column)')
  if (!mapping.measure)         missing.push('Frontend / Network / Backend (needs a WIDGET_MEASURE column)')
  if (!mapping.duration)        missing.push('Frontend / Network / Backend durations (needs a DURATION column)')

  return (
    <>
      {pill}
      {missing.length > 0 && (
        <div className="summary-note">
          Some columns couldn't be auto-matched and show as <code>—</code>:{' '}
          <strong>{missing.join(', ')}</strong>.
        </div>
      )}
      {unrecognizedMeasure && (
        <div className="summary-note">
          <strong>Unrecognized phase tags in <code>{mapping.measure}</code>.</strong>{' '}
          Expected values like <code>render</code> / <code>network</code> /{' '}
          <code>backend</code> / <code>offset</code> but saw:{' '}
          <code>{unrecognizedMeasure}</code>. Frontend / Network / Backend columns
          will be empty until the values match.
        </div>
      )}

      {timelineRange && (
        <div className="summary-active-window is-centered" role="status">
          Showing rows within the timeline range{' '}
          <strong>{formatTimeRangeLabel(timelineRange.min, timelineRange.max)}</strong>
          <button
            type="button"
            className="summary-active-window-clear"
            onClick={resetTimeline}
            title="Reset the Activity Timeline to its full range"
          >
            Clear
          </button>
        </div>
      )}

      {actionFilterWindow && actionInvocationFilter.length > 0 && (
        <div className="summary-active-window" role="status">
          <span className="summary-active-window-dot" aria-hidden="true" />
          Showing actions active <strong>{actionFilterWindow}</strong>
          <span className="summary-active-window-count">
            · {actionInvocationFilter.length} action{actionInvocationFilter.length === 1 ? '' : 's'}
          </span>
        </div>
      )}

      {anomalyTypeFilter && (
        <div className="summary-active-window" role="status">
          <span className="summary-active-window-dot" aria-hidden="true" />
          Filtered to <strong>{anomalyFilterLabel(anomalyTypeFilter)}</strong>
          <span className="summary-active-window-count">
            · {sortedRows.length} action{sortedRows.length === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            className="summary-active-window-clear"
            onClick={() => onClearAnomalyFilter?.()}
            title="Clear the anomaly filter"
          >
            Clear
          </button>
        </div>
      )}

      {durationBucketFilter && (
        <div className="summary-active-window" role="status">
          <span className="summary-active-window-dot" aria-hidden="true" />
          Filtered to durations <strong>{durationBucketFilter.label}</strong>
          <span className="summary-active-window-count">
            · {displayRows.length} action{displayRows.length === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            className="summary-active-window-clear"
            onClick={() => onClearDurationBucket?.()}
            title="Clear the duration filter"
          >
            Clear
          </button>
        </div>
      )}

      <div className="summary-filters">
        <input
          type="search"
          className="summary-filter-search"
          placeholder="Search all actions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {sessionOptions.length > 0 && (
          <MultiFilterMenu
            label="Sessions"
            options={sessionOptions}
            selected={sessionMultiFilter}
            onChange={setSessionMultiFilter}
          />
        )}
        {FILTERABLE_COLUMNS.map((col) => {
          const opts = optionsByColumn[col.key] ?? []
          if (opts.length === 0) return null
          const selected = Array.isArray(filters[col.key]) ? filters[col.key] : []
          return (
            <MultiFilterMenu
              key={col.key}
              label={col.label}
              options={opts}
              selected={selected}
              onChange={(next) => updateFilter(col.key, next)}
            />
          )
        })}
        <DurationFilterMenu
          label="Action duration"
          value={durationFilter}
          onChange={setDurationFilter}
        />
        <ColumnChooserMenu
          columns={chooserColumns}
          hidden={hiddenColumns}
          onChange={setHiddenColumns}
        />
        <span className="summary-filter-count">
          {visibleRows.length} of {summaryRows.length}
        </span>
        <PageSizeSelect value={pageSize} onChange={setPageSize} />
        <button
          type="button"
          className="summary-filter-export"
          disabled={displayRows.length === 0}
          title={displayRows.length === 0 ? 'No rows to export' : 'Download visible rows as CSV'}
          onClick={() => {
            const csv = rowsToCsv(displayRows, columns)
            downloadCsv(buildExportFilename(fileName, 'action'), csv)
          }}
        >
          Export CSV
        </button>
        {activeFilterCount > 0 && (
          <button
            type="button"
            className="summary-filter-clear"
            onClick={() => {
              setSearch('')
              setFilters({})
              setSessionMultiFilter([])
              setActionMultiFilter([])
              setActionInvocationFilter([])
              setActionFilterWindow(null)
              setTimeFilter(emptyTimeSelections())
              setDurationFilter(null)
              setHiddenColumns([])
              setShowAnomalies(true)
              onClearAnomalyFilter?.()
              onClearDurationBucket?.()
              resetTimeline()
            }}
          >
            Clear
          </button>
        )}
        <Button
          className="summary-filter-anomaly-toggle"
          design="Emphasized"
          onClick={() => setShowAnomalies((v) => !v)}
          title={showAnomalies ? 'Hide flagged actions from the table' : 'Show flagged actions in the table'}
        >
          {showAnomalies ? 'Hide anomalies' : 'Show anomalies'}
        </Button>
      </div>

      <AnalyticalDataTable
        rows={pageRows}
        sort={sort}
        onSortChange={setSort}
        isRowViewed={(row) => Boolean(viewedItems.action[actionKey(row)])}
        columns={visibleColumns.map((c) => ({
          ...c,
          // The Action name cell carries the name link plus the always-on
          // Waterfall Chart icon button. Give it extra room so the icon isn't
          // clipped on narrow (laptop) screens where "Smart" scaling would
          // otherwise shrink this column to fit just the header text.
          ...(c.key === 'action_name' ? { minWidth: 300 } : {}),
          render: (v, row) => {
            if (v === '' || v === undefined || v === null) return '—'
            // Action duration reveals the action's start + end times on hover,
            // matching the Widget view's phase cells (see PhaseHoverCell).
            if (c.key === 'action_duration') {
              return (
                <PhaseHoverCell
                  label="Action"
                  start={row._action_timestamp}
                  end={row._action_end}
                >
                  {formatDurationMs(v)}
                </PhaseHoverCell>
              )
            }
            if (DURATION_COLUMNS.has(c.key)) return formatDurationMs(v)
            if (c.key === 'action_name') {
              return (
                <div
                  className="cell-link-row"
                  // Hover the action NAME only (not the whole row) to drive the
                  // rail's "this action" mode — hovering anywhere in the row made
                  // the left panel flicker while you were trying to read it.
                  onMouseEnter={onHoverAction ? () => onHoverAction(actionKey(row)) : undefined}
                  onMouseLeave={onHoverAction ? () => onHoverAction(null) : undefined}
                >
                  <TierBadge tier={rowTier(row)} />
                  <button
                    type="button"
                    className="cell-link"
                    title={`Show widgets for "${row.action_name}"`}
                    onClick={() => {
                      // Record this Action View (route + filters) so Back can
                      // return to it exactly as it is now, before we drill.
                      pushNavSnapshot(location.pathname)
                      // Mark this action as viewed so its row stays tinted.
                      markViewed('action', actionKey(row))
                      // Pin the SAME session as this action row so Widget View
                      // shows only that session's widgets. Actions are grouped
                      // by name + timestamp (not session), so an action name
                      // that recurs across sessions would otherwise pull in
                      // widgets from every session and the session id would
                      // appear to "change" on drill-down. Mirror into the
                      // multiselect too so the Sessions dropdown/pill reflects
                      // the scope — matching the Session → Action drill-down.
                      if (row.session_id) {
                        setSessionFilter(String(row.session_id))
                        setSessionMultiFilter([String(row.session_id)])
                      }
                      setActionFilter({
                        name: row.action_name,
                        timestamp: row._action_timestamp ?? '',
                      })
                      // Preselect this action in Widget View's Actions filter
                      // so the dropdown reflects the drill-down ("1 selected").
                      setActionMultiFilter([String(row.action_name)])
                      navigate('/summary/widget')
                    }}
                  >
                    {String(v)}
                  </button>
                  {onOpenWaterfall && (
                    <button
                      type="button"
                      className="cell-icon-btn"
                      title="Open Action Waterfall Chart for this action"
                      aria-label={`Open Action Waterfall Chart for ${row.action_name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        // Opening the waterfall also counts as viewing.
                        markViewed('action', actionKey(row))
                        onOpenWaterfall({
                          name: row.action_name,
                          timestamp: row._action_timestamp ?? '',
                          story: row.story_name ?? '',
                        })
                      }}
                    >
                      <WaterfallIcon size={24} />
                    </button>
                  )}
                </div>
              )
            }
            return String(v)
          },
        }))}
        emptyMessage="No actions match your filters."
      />

      <TablePager page={page} pageCount={pageCount} onPage={setPage} />
    </>
  )
}

const FILTERABLE_COLUMNS = [
  { key: 'user',        label: 'User' },
  { key: 'action_name', label: 'Action' },
  { key: 'story_name',  label: 'Story' },
]
const DURATION_COLUMNS = new Set(['action_duration', 'max_frontend', 'max_network', 'max_backend'])

// Action name always shows and can't be hidden, so it's excluded from the
// column-chooser dropdown (a row must always keep its label).
const ACTION_LOCKED_COLUMNS = ['action_name']

// Human label for the active click-to-filter anomaly selection (panel row or
// >30s tile). '__total__' is the any-flag union.
function anomalyFilterLabel(type) {
  if (type === '__total__') return 'flagged actions (any anomaly)'
  return ANOMALY_TYPES.find((t) => t.key === type)?.label ?? 'flagged actions'
}

export default ActionSummaryTable
