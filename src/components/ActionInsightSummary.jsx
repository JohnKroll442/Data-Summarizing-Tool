import { useMemo } from 'react'
import { TrendingUp, AlertTriangle, Zap, CheckCircle } from 'lucide-react'
import { generateInsights } from '../lib/generateInsights'
import './ActionInsightSummary.css'

/**
 * ActionInsightSummary — a compact card shown at the top of the Action View
 * that translates the anomaly detector's output into plain-language sentences.
 *
 * Props:
 *   anomalies       Full detectAnomalies() output
 *   filteredSummary summarizeActionFlags() for the current visible row set
 *   kpis            actionKpisFromAgg() output (for the duration line)
 *   thresholds      { slowActionMs, … }
 *   onExport        () => void — called when the Export Report button is clicked
 *   exporting       boolean — true while the report is being generated
 */
function ActionInsightSummary({ anomalies, filteredSummary, filteredAnomalyRows, kpis, thresholds, onExport, exporting }) {
  const insights = useMemo(
    () => generateInsights({ anomalies, filteredSummary, filteredAnomalyRows, kpis, thresholds }),
    [anomalies, filteredSummary, filteredAnomalyRows, kpis, thresholds],
  )

  const hasAnomalies = (filteredSummary ?? anomalies)?.totalFlagged?.actions > 0
  const HeadlineIcon = hasAnomalies ? AlertTriangle : CheckCircle

  return (
    <div className={`action-insight-summary${hasAnomalies ? ' has-anomalies' : ' all-clear'}`}>
      {/* ── Headline row ──────────────────────────────────────────────────── */}
      <div className="insight-headline-row">
        <HeadlineIcon
          size={18}
          className="insight-headline-icon"
          aria-hidden="true"
        />
        <p className="insight-headline">{insights.headline}</p>
        {insights.kpiLine && (
          <span className="insight-kpi-line">{insights.kpiLine}</span>
        )}
        {onExport && (
          <button
            type="button"
            className="insight-export-btn"
            onClick={onExport}
            disabled={exporting}
            title="Open a printable report — use the browser's Save as PDF option"
          >
            {exporting ? (
              <>
                <span className="insight-export-spinner" aria-hidden="true" />
                Generating…
              </>
            ) : (
              <>
                <TrendingUp size={14} aria-hidden="true" />
                Export Report
              </>
            )}
          </button>
        )}
      </div>

      {/* ── Body (only shown when there's something to report) ───────────── */}
      {(insights.topIssues.length > 0 || insights.worstOffender) && (
        <div className="insight-body">
          {/* Top issues */}
          {insights.topIssues.length > 0 && (
            <ul className="insight-issues" aria-label="Top anomaly types">
              {insights.topIssues.map((issue) => (
                <li key={issue.key} className="insight-issue-item">
                  <Zap size={12} className="insight-issue-icon" aria-hidden="true" />
                  <strong>{issue.label}</strong>
                  {' — '}
                  {issue.count} action{issue.count === 1 ? '' : 's'}{' '}
                  <span className="insight-issue-pct">({issue.pct}%)</span>
                </li>
              ))}
            </ul>
          )}

          {/* Worst offender */}
          {insights.worstOffender && (
            <div className="insight-worst-offender">
              <span className="insight-worst-label">Worst offender</span>
              <span className="insight-worst-action">{insights.worstOffender.actionName}</span>
              {insights.worstOffender.story && (
                <span className="insight-worst-story"> · {insights.worstOffender.story}</span>
              )}
              <span className="insight-worst-dur">{insights.worstOffender.duration}</span>
              {insights.worstOffender.flagLabels.length > 0 && (
                <span className="insight-worst-flags">
                  {insights.worstOffender.flagLabels.join(', ')}
                </span>
              )}
            </div>
          )}

          {/* Recommendation */}
          {insights.recommendation && (
            <p className="insight-recommendation">{insights.recommendation}</p>
          )}
        </div>
      )}
    </div>
  )
}

export default ActionInsightSummary
