/**
 * ChartUnavailable — inline fallback shown when a `​```chart` directive in an
 * AI answer can't be turned into a chart. It never throws and leaves the
 * surrounding prose intact; the point is that a bad or unresolvable directive
 * degrades to a small note instead of crashing the chat message.
 */

const MESSAGES = {
  malformed:          () => "The assistant's chart request couldn't be read.",
  unknown_chart_type: (d) => `Unknown chart type${d ? ` "${d}"` : ''}.`,
  no_data:            () => 'No data is loaded to plot this chart.',
  bad_config:         (d) => `This chart is missing a valid setting${d ? ` (${d})` : ''}.`,
  no_action_match:    (d) => `Couldn't find an action${d ? ` named "${d}"` : ''} in the current data.`,
  no_widget_match:    (d) => `Couldn't find${d ? ` widget "${d}"` : ' that widget'} in the action.`,
  build_error:        () => "This chart couldn't be built from the data.",
  render_error:       () => "This chart couldn't be displayed.",
}

function ChartUnavailable({ reason, detail }) {
  const fn = MESSAGES[reason] || MESSAGES.build_error
  return (
    <div className="ai-chat-chart-unavailable" role="note">
      <span className="ai-chat-chart-unavailable-icon" aria-hidden="true">📊</span>
      <span>{fn(detail)}</span>
    </div>
  )
}

export default ChartUnavailable
