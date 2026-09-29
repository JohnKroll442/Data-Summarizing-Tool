import { createContext, useContext } from 'react'

/**
 * ChartDataContext — carries the data sources a `​```chart` directive in an AI
 * answer can resolve against, so ChartBlock (nested deep inside the markdown
 * renderer) can reach them without prop-drilling through every intermediate
 * component.
 *
 * Value shape: { aggRows, rows, headers, widgetRows }
 *   aggRows    — one row per action (aggregateByAction output); canonical
 *                fields action_name, action_duration, max_frontend/network/backend,
 *                _action_timestamp, …
 *   rows       — raw session-scoped CSV rows (for the waterfall builders + the
 *                'raw' generic data source)
 *   headers    — CSV headers matching `rows`
 *   widgetRows — per-action widget-aggregate rows ('widgets' generic source)
 */
export const ChartDataContext = createContext(null)

export function useChartData() {
  return useContext(ChartDataContext)
}
