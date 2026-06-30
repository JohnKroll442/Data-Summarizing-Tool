import { createContext, useCallback, useMemo, useState } from 'react'
import { profileColumns } from '../lib/chartData'

/**
 * CsvDataContext — in-memory store for the parsed CSV, per-view charts,
 * and the cross-view drill-down filters.
 *
 * Lives at the router level so navigation between `/` and `/summary/*`
 * retains the parsed rows, the user's chart selections, and any drill-down
 * the user clicked into. A hard reload clears everything (no backend
 * persistence).
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
 * Recent files: a small in-memory ring of recently-parsed CSVs so the user
 * can swap between files without re-uploading from disk. Deduped by
 * (fileName, fileSize); capped at MAX_RECENT_FILES; cleared on `clear()`.
 * Deliberately NOT persisted — survives navigation, lost on hard refresh.
 *
 * The `useCsvData` hook is exported from a sibling file so this module only
 * exports components (keeps Vite Fast Refresh happy).
 */

// eslint-disable-next-line react-refresh/only-export-components
export const CsvDataContext = createContext(null)

const MAX_RECENT_FILES = 5

let nextUid = 1

export function CsvDataProvider({ children }) {
  const [data, setData] = useState({
    id: '',
    headers: [],
    rows: [],
    fileName: '',
    fileSize: 0,
  })

  const [recentFiles, setRecentFiles] = useState([])

  const [chartsByView, setChartsByView] = useState({
    session: [],
    action: [],
    widget: [],
  })

  // Drill-down state — null means "no filter applied for this view"
  const [sessionFilter, setSessionFilter] = useState(null)
  const [actionFilter, setActionFilter] = useState(null)

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
    setData({ id: '', headers: [], rows: [], fileName: '', fileSize: 0 })
    setRecentFiles([])
    resetDerivedState()
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

  const value = useMemo(
    () => ({
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
    }),
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
