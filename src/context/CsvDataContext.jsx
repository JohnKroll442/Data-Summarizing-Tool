import { createContext, useCallback, useMemo, useState } from 'react'
import { profileColumns } from '../lib/chartData'

/**
 * CsvDataContext — in-memory store for the parsed CSV and per-view charts.
 *
 * Lives at the router level so navigation between `/` and `/summary/*` retains
 * the parsed rows AND the charts the user has added on each view. A hard
 * reload clears it (no backend persistence).
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

  // chartsByView: { session: [], action: [], widget: [] }
  const [chartsByView, setChartsByView] = useState({
    session: [],
    action: [],
    widget: [],
  })

  const setCsvData = useCallback(({ headers, rows, fileName, fileSize }) => {
    setData({
      headers: headers ?? [],
      rows: rows ?? [],
      fileName: fileName ?? '',
      fileSize: fileSize ?? 0,
    })
    // Reset chart selections when a new file is loaded
    setChartsByView({ session: [], action: [], widget: [] })
  }, [])

  const clear = useCallback(() => {
    setData({ headers: [], rows: [], fileName: '', fileSize: 0 })
    setChartsByView({ session: [], action: [], widget: [] })
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
      // Per-column type profile, built once when rows change. Used by the
      // chart picker to filter dropdowns to columns that fit each field.
      columnProfile: profileColumns(data.rows, data.headers),
      setCsvData,
      clear,
      chartsByView,
      addChart,
      removeChart,
    }),
    [data, setCsvData, clear, chartsByView, addChart, removeChart]
  )

  return <CsvDataContext.Provider value={value}>{children}</CsvDataContext.Provider>
}
