import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { profileColumns } from '../lib/chartData'
import { buildDefaultCharts } from '../lib/defaultCharts'
import { loadCache, saveCache, clearCache } from '../lib/csvCache'

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
        columnProfile: profileColumns(data.rows, data.headers),
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
