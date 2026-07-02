import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { profileColumns } from '../lib/chartData'
import { buildDefaultCharts } from '../lib/defaultCharts'

/**
 * CsvDataContext — in-memory store for the parsed CSV, per-view charts,
 * and the cross-view drill-down filters.
 *
 * Lives at the router level so navigation between `/` and `/summary/*`
 * retains the parsed rows, the user's chart selections, and any drill-down
 * the user clicked into.
 *
 * Persistence: the active file and the recent-files ring are cached to
 * localStorage under STORAGE_KEY so a hard refresh restores the last
 * upload. Charts and drill-down filters are NOT persisted — they reset
 * on file swap anyway. Cache is skipped for payloads >MAX_CACHE_BYTES to
 * avoid QuotaExceededError; `clear()` wipes the cache.
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
const STORAGE_KEY = 'csvDataCache.v1'
const EMPTY_DATA = { id: '', headers: [], rows: [], fileName: '', fileSize: 0 }

// Cache write is skipped if the serialized payload exceeds this. localStorage
// is typically capped at ~5MB per origin; going over throws QuotaExceededError
// and would take out the whole save. 4MB leaves headroom for the userName key
// and future additions.
const MAX_CACHE_BYTES = 4 * 1024 * 1024

function loadCache() {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function saveCache(payload) {
  if (typeof localStorage === 'undefined') return
  try {
    const serialized = JSON.stringify(payload)
    if (serialized.length > MAX_CACHE_BYTES) {
      // Too big to cache safely — drop any stale entry so we don't restore
      // a mismatched file next load.
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, serialized)
  } catch {
    // Quota exceeded or storage disabled — silently drop the cache.
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* noop */ }
  }
}

function clearCache() {
  if (typeof localStorage === 'undefined') return
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* noop */ }
}

let nextUid = 1

export function CsvDataProvider({ children }) {
  // Hydrate synchronously from localStorage so the first render already has
  // the cached file — avoids a flash of the empty upload screen.
  const cached = typeof window !== 'undefined' ? loadCache() : null

  const [data, setData] = useState(cached?.data ?? EMPTY_DATA)

  const [recentFiles, setRecentFiles] = useState(cached?.recentFiles ?? [])

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
  useEffect(() => {
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
