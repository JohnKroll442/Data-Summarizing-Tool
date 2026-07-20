import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildDefaultCharts } from '../lib/defaultCharts'
import { loadCache, saveCache, clearCache } from '../lib/csvCache'
import { emptyTimeSelections } from '../lib/timeBuckets'

/**
 * CsvDataContext — in-memory store for the parsed CSV, per-view charts,
 * and the cross-view drill-down filters.
 *
 * Lives at the router level so navigation between `/` and `/summary/*`
 * retains the parsed rows, the user's chart selections, and any drill-down
 * the user clicked into.
 *
 * Persistence: the active file and the recent-files ring are cached to
 * IndexedDB (see ../lib/csvCache) so a hard refresh restores the last
 * upload. IndexedDB is used instead of localStorage so uploads larger
 * than a few MB can also survive refresh — the browser quota is measured
 * in hundreds of MB rather than ~5 MB. Charts and drill-down filters are
 * NOT persisted — they reset on file swap anyway. `clear()` wipes the
 * cache.
 *
 * Drill-down state:
 *   sessionFilter — when set, ActionView only aggregates rows whose
 *                   session-id column equals this value
 *   actionFilter  — { name, timestamp } — when set, WidgetView only
 *                   aggregates rows from a specific action invocation
 *   sessionMultiFilter / actionMultiFilter — string[] view-scoping filters
 *                   that compose after the single filters above. Empty array
 *                   means no constraint. sessionMultiFilter scopes Action +
 *                   Widget views to a set of sessions; actionMultiFilter
 *                   scopes Widget view to a set of action names.
 *
 * Charts are stored per view as `{ [viewId]: ChartDef[] }` where ChartDef is
 *   { uid: string, typeId: string, config: Record<string, any> }
 *
 * Recent files: a small ring of recently-parsed CSVs so the user can swap
 * between files without re-uploading. Deduped by (fileName, fileSize);
 * capped at MAX_RECENT_FILES; cleared on `clear()`.
 *
 * The `useCsvData` hook is exported from a sibling file so this module only
 * exports components (keeps Vite Fast Refresh happy).
 */

// eslint-disable-next-line react-refresh/only-export-components
export const CsvDataContext = createContext(null)

const MAX_RECENT_FILES = 5
const EMPTY_DATA = { id: '', headers: [], rows: [], fileName: '', fileSize: 0 }

let nextUid = 1

export function CsvDataProvider({ children }) {
  // Hydration is async — see the mount-only useEffect below. First render
  // shows the empty state; the cached file (if any) appears one tick later
  // once IndexedDB resolves. Every consumer already checks rows.length so
  // this brief empty state is safe.
  const [data, setData] = useState(EMPTY_DATA)

  const [recentFiles, setRecentFiles] = useState([])

  // Skip the first persist effect so we don't overwrite the IndexedDB cache
  // with an empty payload before hydration has a chance to run.
  const hydratedRef = useRef(false)

  const [chartsByView, setChartsByView] = useState({
    session: [],
    action: [],
    widget: [],
  })

  // Drill-down state — null means "no filter applied for this view"
  const [sessionFilter, setSessionFilter] = useState(null)
  const [actionFilter, setActionFilter] = useState(null)

  // Multiselect scoping filters — string[] where an empty array means "no
  // constraint". Compose AFTER the single drill-down filters above:
  //   sessionMultiFilter scopes Action View and Widget View to a chosen set
  //   of sessions; actionMultiFilter scopes Widget View to a chosen set of
  //   action names. Reset on file swap like the single filters.
  const [sessionMultiFilter, setSessionMultiFilter] = useState([])
  const [actionMultiFilter, setActionMultiFilter] = useState([])

  // When the session filter was seeded by clicking a Sessions bar in the
  // Activity Timeline, this holds a human label for that bucket's time window
  // (e.g. "Jun 15, 10:00 → Jun 15, 11:00") so the Session view can show which
  // period the current filter came from. null when the filter wasn't set that
  // way (or was cleared / manually edited).
  const [sessionFilterWindow, setSessionFilterWindow] = useState(null)

  // Timeline bar-drill state for the Widget and Action views, parallel to
  // sessionMultiFilter / sessionFilterWindow above. Clicking a Widgets or
  // Actions bar scopes that view to exactly the entities the bar counted:
  //   widgetMultiFilter      — widget_id[] active in the clicked bucket
  //   actionInvocationFilter — _action_timestamp[] of actions in the bucket
  // and the *FilterWindow labels hold the bucket's time-range label for the
  // "Showing … active {window}" banner. Reset on file swap like the others.
  const [widgetMultiFilter, setWidgetMultiFilter] = useState([])
  const [actionInvocationFilter, setActionInvocationFilter] = useState([])
  const [widgetFilterWindow, setWidgetFilterWindow] = useState(null)
  const [actionFilterWindow, setActionFilterWindow] = useState(null)

  // A request to focus the Activity Timeline on a time window (epoch ms), set
  // by clicking a "busiest day / 7 days / month" card on the Summary view. A
  // fresh object each call so the timeline's effect re-fires even for the same
  // window. null = no pending request.
  const [timelineFocus, setTimelineFocus] = useState(null)
  const focusTimeline = useCallback((min, max) => setTimelineFocus({ min, max }), [])

  // The continuous window (epoch ms) currently focused in the Activity Timeline,
  // published by the timeline whenever the user zooms/drags. The summary tables
  // AND this into their row filtering so what's selected in the timeline is what
  // the tables show. null = full range (no constraint).
  const [timelineRange, setTimelineRange] = useState(null)

  // The hierarchical Time-filter selection (Month/Week/Day/Hour/Minute bucket
  // picks) shared by every summary table, so the choice stays constant as the
  // user navigates between the Session / Action / Widget views instead of
  // resetting to empty on each mount. Like the other filters it lives here (not
  // in the tables' local state) and resets only on file swap or an explicit
  // Clear. See emptyTimeSelections() for the shape.
  const [timeSelections, setTimeSelections] = useState(emptyTimeSelections)

  // A request to reset the Activity Timeline back to its full range, bumped by a
  // table's Clear (or the range banner's clear) so clearing the table filters
  // also drops the timeline zoom. The timeline observes the nonce and resets its
  // local window, which in turn clears timelineRange. Mirrors timelineFocus.
  const [timelineResetNonce, setTimelineResetNonce] = useState(0)
  const resetTimeline = useCallback(() => setTimelineResetNonce((n) => n + 1), [])

  // Compare selection — ephemeral, not persisted to localStorage.
  const [baselineId, setBaselineIdState] = useState(null)
  const [currentId, setCurrentIdState] = useState(null)

  // Tracks the last data.id we auto-seeded default charts for. Prevents
  // re-seeding if the user has deleted the defaults, and prevents seeding
  // twice for the same file across re-mounts.
  const seededForIdRef = useRef(null)

  const resetDerivedState = useCallback(() => {
    setChartsByView({ session: [], action: [], widget: [] })
    setSessionFilter(null)
    setActionFilter(null)
    setSessionMultiFilter([])
    setActionMultiFilter([])
    setSessionFilterWindow(null)
    setWidgetMultiFilter([])
    setActionInvocationFilter([])
    setWidgetFilterWindow(null)
    setActionFilterWindow(null)
    setTimelineFocus(null)
    setTimelineRange(null)
    setTimeSelections(emptyTimeSelections())
  }, [])

  const setCsvData = useCallback(({ headers, rows, fileName, fileSize }) => {
    const entry = {
      id: generateFileId(),
      headers: headers ?? [],
      rows: rows ?? [],
      fileName: fileName ?? '',
      fileSize: fileSize ?? 0,
      uploadedAt: Date.now(),
    }
    // A user upload supersedes anything the async hydration might restore,
    // so mark hydrated to unblock the persist effect immediately.
    hydratedRef.current = true
    setData(entry)
    setRecentFiles((prev) => {
      const dedupKey = `${entry.fileName}|${entry.fileSize}`
      const filtered = prev.filter(
        (f) => `${f.fileName}|${f.fileSize}` !== dedupKey
      )
      return [entry, ...filtered].slice(0, MAX_RECENT_FILES)
    })
    resetDerivedState()
  }, [resetDerivedState])

  const selectRecentFile = useCallback((id) => {
    let target
    setRecentFiles((prev) => {
      target = prev.find((f) => f.id === id)
      if (!target) return prev
      // Move the selected file to the head so the recent list reflects
      // the most-recently-used order.
      const rest = prev.filter((f) => f.id !== id)
      return [{ ...target, uploadedAt: Date.now() }, ...rest]
    })
    if (target) {
      setData(target)
      resetDerivedState()
    }
  }, [resetDerivedState])

  const removeRecentFile = useCallback((id) => {
    setRecentFiles((prev) => prev.filter((f) => f.id !== id))
  }, [])

  const clear = useCallback(() => {
    setData(EMPTY_DATA)
    setRecentFiles([])
    resetDerivedState()
    clearCache()
  }, [resetDerivedState])

  const addChart = useCallback((viewId, typeId, config) => {
    const uid = `c${nextUid++}`
    setChartsByView((prev) => ({
      ...prev,
      [viewId]: [...(prev[viewId] ?? []), { uid, typeId, config }],
    }))
  }, [])

  const removeChart = useCallback((viewId, uid) => {
    setChartsByView((prev) => ({
      ...prev,
      [viewId]: (prev[viewId] ?? []).filter((c) => c.uid !== uid),
    }))
  }, [])

  // Compare selection setters — only accept ids that reference an actual
  // file (either the active `data` or one of the recent-files entries).
  const idExists = useCallback(
    (id) => Boolean(id) && (data.id === id || recentFiles.some((f) => f.id === id)),
    [data.id, recentFiles]
  )

  const setBaselineId = useCallback((id) => {
    if (idExists(id)) setBaselineIdState(id)
  }, [idExists])

  const setCurrentId = useCallback((id) => {
    if (idExists(id)) setCurrentIdState(id)
  }, [idExists])

  const clearComparison = useCallback(() => {
    setBaselineIdState(null)
    setCurrentIdState(null)
  }, [])

  // Persist the active file + recent-files ring to localStorage whenever
  // they change. Charts/filters intentionally stay in-memory — they reset
  // on file swap anyway.
  // One-shot async hydration from IndexedDB on mount. StrictMode double-
  // invokes effects in dev — the mounted flag guards against setting state
  // after the first invocation has already been torn down.
  useEffect(() => {
    let mounted = true
    loadCache().then((cached) => {
      if (!mounted) return
      if (cached?.data) setData(cached.data)
      if (cached?.recentFiles) setRecentFiles(cached.recentFiles)
      hydratedRef.current = true
    })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    // Don't clobber a not-yet-hydrated cache with the initial empty state.
    if (!hydratedRef.current) return
    if (!data.id && recentFiles.length === 0) {
      clearCache()
      return
    }
    saveCache({ data, recentFiles })
  }, [data, recentFiles])

  // Seed default charts once per file so users see visualizations
  // immediately on first load. Only fires when the id changes, so if the
  // user deletes the defaults they stay deleted.
  useEffect(() => {
    if (!data.id) {
      seededForIdRef.current = null
      return
    }
    if (seededForIdRef.current === data.id) return
    if (!data.rows || data.rows.length === 0) return
    seededForIdRef.current = data.id
    let uid = nextUid
    const seed = (viewId) => {
      const defs = buildDefaultCharts(viewId, data.rows, data.headers)
      return defs.map((d) => ({ uid: `c${uid++}`, typeId: d.typeId, config: d.config }))
    }
    const seeded = {
      session: seed('session'),
      action: seed('action'),
      widget: seed('widget'),
    }
    nextUid = uid
    setChartsByView(seeded)
  }, [data.id, data.rows, data.headers])

  const value = useMemo(
    () => {
      // Resolve compare selections against recent-files first, then the
      // active data. Returns null when the id doesn't match any known file.
      const resolvePayload = (id) => {
        if (!id) return null
        const fromRecent = recentFiles.find((f) => f.id === id)
        if (fromRecent) return fromRecent
        if (data.id === id) return data
        return null
      }
      return {
        ...data,
        hasData: data.rows.length > 0,
        setCsvData,
        clear,
        recentFiles,
        selectRecentFile,
        removeRecentFile,
        activeFileId: data.id,
        chartsByView,
        addChart,
        removeChart,
        sessionFilter,
        setSessionFilter,
        actionFilter,
        setActionFilter,
        sessionMultiFilter,
        setSessionMultiFilter,
        actionMultiFilter,
        setActionMultiFilter,
        sessionFilterWindow,
        setSessionFilterWindow,
        widgetMultiFilter,
        setWidgetMultiFilter,
        actionInvocationFilter,
        setActionInvocationFilter,
        widgetFilterWindow,
        setWidgetFilterWindow,
        actionFilterWindow,
        setActionFilterWindow,
        timelineFocus,
        focusTimeline,
        timelineRange,
        setTimelineRange,
        timeSelections,
        setTimeSelections,
        resetTimeline,
        timelineResetNonce,
        baselineId,
        currentId,
        setBaselineId,
        setCurrentId,
        clearComparison,
        baselinePayload: resolvePayload(baselineId),
        currentPayload: resolvePayload(currentId),
      }
    },
    [
      data,
      setCsvData,
      clear,
      recentFiles,
      selectRecentFile,
      removeRecentFile,
      chartsByView,
      addChart,
      removeChart,
      sessionFilter,
      actionFilter,
      sessionMultiFilter,
      actionMultiFilter,
      sessionFilterWindow,
      widgetMultiFilter,
      actionInvocationFilter,
      widgetFilterWindow,
      actionFilterWindow,
      timelineFocus,
      focusTimeline,
      timelineRange,
      timeSelections,
      resetTimeline,
      timelineResetNonce,
      baselineId,
      currentId,
      setBaselineId,
      setCurrentId,
      clearComparison,
    ]
  )

  return <CsvDataContext.Provider value={value}>{children}</CsvDataContext.Provider>
}

function generateFileId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
