import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { MessageSquare, X } from 'lucide-react'
import { useCsvData } from '../../context/useCsvData'
import { runAgent } from '../../lib/copilot/agent'
import { buildSchemaSummary } from '../../lib/copilot/schemaSummary'
import MessageList from './MessageList'
import ChatInput from './ChatInput'
import './CopilotDrawer.css'

function CopilotDrawer() {
  const {
    rows, headers, fileName, fileSize,
    activeFileId,
    baselinePayload, currentPayload, baselineId, currentId,
  } = useCsvData()
  const location = useLocation()

  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const abortRef = useRef(null)

  const activePayload = useMemo(
    () => (rows?.length ? { rows, headers, fileName, fileSize } : null),
    [rows, headers, fileName, fileSize],
  )

  const ctx = useMemo(
    () => ({ activePayload, baselinePayload, currentPayload }),
    [activePayload, baselinePayload, currentPayload],
  )

  const schemaSummary = useMemo(
    () => buildSchemaSummary(ctx),
    // ctx is already memoized — it only changes when a file is loaded/swapped,
    // so this stays stable across a conversation while always being fresh.
    [ctx],
  )

  const contextBlock = useMemo(() => {
    const parts = [`route=${location.pathname}`]
    if (activeFileId) parts.push(`activeFileId=${activeFileId}`)
    if (baselineId) parts.push(`baselineId=${baselineId}`)
    if (currentId) parts.push(`currentId=${currentId}`)
    return parts.join(' ')
  }, [location.pathname, activeFileId, baselineId, currentId])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
  }, [])

  useEffect(() => {
    if (!open) cancel()
  }, [open, cancel])

  const send = useCallback(async (text) => {
    if (!text.trim() || busy) return
    setError(null)
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)

    const userMsg = { role: 'user', content: text }
    setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '', pending: true, toolCalls: [] }])

    const history = messages.map((m) => ({ role: m.role, content: m.content }))
                            .filter((m) => typeof m.content === 'string' && m.content.length > 0)

    try {
      await runAgent({
        userText: text,
        contextBlock,
        schemaSummary,
        history,
        ctx,
        signal: controller.signal,
        onEvent: (evt) => {
          setMessages((prev) => {
            const next = prev.slice()
            const last = next[next.length - 1]
            if (!last || last.role !== 'assistant') return prev
            if (evt.type === 'text') {
              last.content = (last.content || '') + evt.text
            } else if (evt.type === 'tool_use') {
              last.toolCalls = [...(last.toolCalls || []), { id: evt.id, name: evt.name, input: evt.input, status: 'running' }]
            } else if (evt.type === 'tool_result') {
              last.toolCalls = (last.toolCalls || []).map((tc) =>
                tc.id === evt.id ? { ...tc, status: evt.isError ? 'error' : 'done' } : tc,
              )
            } else if (evt.type === 'done') {
              last.pending = false
            }
            return next
          })
        },
      })
    } catch (err) {
      if (err?.name === 'AbortError') {
        setMessages((prev) => prev.slice(0, -1))
      } else {
        setError(err?.message || String(err))
        setMessages((prev) => {
          const next = prev.slice()
          const last = next[next.length - 1]
          if (last && last.role === 'assistant') last.pending = false
          return next
        })
      }
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }, [busy, messages, contextBlock, schemaSummary, ctx])

  return (
    <>
      {!open && (
        <button
          type="button"
          className="copilot-fab"
          onClick={() => setOpen(true)}
          aria-label="Open copilot"
        >
          <MessageSquare size={20} />
        </button>
      )}
      <aside className={`copilot-drawer${open ? ' is-open' : ''}`} aria-hidden={!open}>
        <header className="copilot-header">
          <div className="copilot-title">
            <MessageSquare size={16} />
            <span>Copilot</span>
          </div>
          <button
            type="button"
            className="copilot-close"
            onClick={() => setOpen(false)}
            aria-label="Close copilot"
          >
            <X size={16} />
          </button>
        </header>
        <MessageList messages={messages} hasData={Boolean(rows?.length)} />
        {error && <div className="copilot-error">{error}</div>}
        <ChatInput onSend={send} busy={busy} onCancel={cancel} />
      </aside>
    </>
  )
}

export default CopilotDrawer
