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
 * The `useCsvData` hook is exported from a sibling file so this module only
 * exports components (keeps Vite Fast Refresh happy).
 */

// eslint-disable-next-line react-refresh/only-export-components
export const CsvDataContext = createContext(null)

let nextUid = 1

export function CsvDataProvider({ children }) {
  const [data, setData] = useState({
    headers: [],
    rows: [],
    fileName: '',
    fileSize: 0,
  })

  const [chartsByView, setChartsByView] = useState({
    session: [],
    action: [],
    widget: [],
  })

  // Drill-down state — null means "no filter applied for this view"
  const [sessionFilter, setSessionFilter] = useState(null)
  const [actionFilter, setActionFilter] = useState(null)

  const setCsvData = useCallback(({ headers, rows, fileName, fileSize }) => {
    setData({
      headers: headers ?? [],
      rows: rows ?? [],
      fileName: fileName ?? '',
      fileSize: fileSize ?? 0,
    })
    setChartsByView({ session: [], action: [], widget: [] })
    setSessionFilter(null)
    setActionFilter(null)
  }, [])

  const clear = useCallback(() => {
    setData({ headers: [], rows: [], fileName: '', fileSize: 0 })
    setChartsByView({ session: [], action: [], widget: [] })
    setSessionFilter(null)
    setActionFilter(null)
  }, [])

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
      chartsByView,
      addChart,
      removeChart,
      sessionFilter,
      actionFilter,
    ]
  )

  return <CsvDataContext.Provider value={value}>{children}</CsvDataContext.Provider>
}
