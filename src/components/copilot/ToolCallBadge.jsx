import { Loader2, Check, AlertTriangle } from 'lucide-react'

function ToolCallBadge({ call }) {
  const icon =
    call.status === 'running' ? <Loader2 size={11} className="copilot-tool-spin" />
    : call.status === 'error' ? <AlertTriangle size={11} />
    : <Check size={11} />

  const inputSummary = summarize(call.input)
  return (
    <span className={`copilot-tool copilot-tool-${call.status}`} title={JSON.stringify(call.input || {})}>
      {icon}
      <span className="copilot-tool-name">{call.name}</span>
      {inputSummary && <span className="copilot-tool-args">{inputSummary}</span>}
    </span>
  )
}

function summarize(input) {
  if (!input || typeof input !== 'object') return ''
  const parts = []
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue
    const val = Array.isArray(v) ? `[${v.length}]` : typeof v === 'object' ? '{…}' : String(v)
    parts.push(`${k}=${val}`)
    if (parts.join(' ').length > 40) break
  }
  return parts.join(' ')
}

export default ToolCallBadge
