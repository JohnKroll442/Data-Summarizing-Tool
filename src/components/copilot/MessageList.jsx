import ToolCallBadge from './ToolCallBadge'
import MarkdownMessage from './MarkdownMessage'

function MessageList({ messages, hasData }) {
  if (messages.length === 0) {
    return (
      <div className="copilot-empty">
        <p className="copilot-empty-title">Ask me about your data.</p>
        {hasData ? (
          <ul className="copilot-empty-examples">
            <li>&ldquo;Which actions got slower between the two files?&rdquo;</li>
            <li>&ldquo;Break down the top regression by phase.&rdquo;</li>
            <li>&ldquo;Show me slow backend actions over 500ms.&rdquo;</li>
          </ul>
        ) : (
          <p className="copilot-empty-hint">Upload a CSV first &mdash; then I can query it.</p>
        )}
      </div>
    )
  }
  return (
    <div className="copilot-messages">
      {messages.map((m, i) => (
        <div key={i} className={`copilot-msg copilot-msg-${m.role}`}>
          {m.toolCalls?.length ? (
            <div className="copilot-toolcalls">
              {m.toolCalls.map((tc) => <ToolCallBadge key={tc.id} call={tc} />)}
            </div>
          ) : null}
          {m.content && (
            <div className="copilot-msg-content">
              {m.role === 'assistant'
                ? <MarkdownMessage content={m.content} />
                : m.content}
            </div>
          )}
          {m.pending && !m.content && <div className="copilot-thinking">Thinking...</div>}
        </div>
      ))}
    </div>
  )
}

export default MessageList
