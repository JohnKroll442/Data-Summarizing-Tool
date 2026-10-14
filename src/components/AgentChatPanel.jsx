/**
 * AgentChatPanel — AI assistant chat panel.
 *
 * Each question runs the full pipeline in one round-trip:
 *   POST /api/session                 — first question (uploads the dataset)
 *   POST /api/session/<id>/continue   — follow-up questions
 * The backend classifies intent, runs the agents, and returns the answer.
 *
 * Props
 * -----
 *   buildPayload  () => object    called on submit to get the current agent payload
 *   aggRows       object[]        full aggregated rows (sent as agg_rows to backend)
 *   widgetRows    object[]        widget-aggregate rows (sent as widget_rows for trace agent)
 *   isOpen        bool
 *   onClose       () => void
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { ChartDataContext } from './chartChat/ChartDataContext'
import ChartBlock from './chartChat/ChartBlock'
import './AgentChatPanel.css'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000'

// Hard ceiling on any backend round-trip. Without it a hung or unreachable
// server leaves the panel spinning forever (FH2). AbortController fires the
// signal; callers surface it as a friendly timeout error.
const FETCH_TIMEOUT_MS = 60000

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

const EXAMPLE_PROMPTS = [
  'What anomalies were detected in this dataset?',
  'Show me the slowest actions and their root causes.',
  'Which users have the most flagged actions?',
  'Give me a full performance summary.',
]

// Stable, unique key for each message so React reconciles by identity, not by
// list position.
let _msgSeq = 0
const stampMsg = (msg) => ({ id: `m${++_msgSeq}`, ...msg })

export default function AgentChatPanel({ buildPayload, aggRows, rows, headers, widgetRows, fileName, isOpen, onClose }) {
  // Flat message list. Each item: { type, text?, data? }
  // types: 'user' | 'response'
  const [messages,   setMessages]   = useState([])
  const [sessionId,  setSessionId]  = useState(null)
  const [question,   setQuestion]   = useState('')
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState(null)

  const inputRef       = useRef(null)
  const bottomRef      = useRef(null)
  const bodyRef        = useRef(null)
  const lastResponseRef = useRef(null)

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 300)
  }, [isOpen])

  // Auto-scroll to the newest message ONLY when the user is already near the
  // bottom. If they've scrolled up to re-read earlier output, a new message
  // (or a loading indicator) must not yank the viewport back down (FM3).
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, loading])

  // When a response arrives (loading flips true → false), jump to the TOP of
  // the new response so the user reads from the beginning, not the end.
  const prevLoadingRef = useRef(false)
  useEffect(() => {
    if (prevLoadingRef.current && !loading) {
      lastResponseRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
    prevLoadingRef.current = loading
  }, [loading])

  // Escape closes the panel while it's open.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  // When the underlying dataset changes (new file loaded), the existing session
  // still points at the old — now stale or evicted — dataset. Drop it so the
  // next question opens a fresh session against the new data (FM4).
  const prevFileRef = useRef(fileName)
  useEffect(() => {
    if (prevFileRef.current === fileName) return
    prevFileRef.current = fileName
    if (sessionId) {
      fetchWithTimeout(`${BACKEND}/api/session/${sessionId}`, { method: 'DELETE' }, 10000)
        .catch(() => { /* best-effort — backend evicts stale sessions on TTL anyway */ })
    }
    setSessionId(null); setMessages([]); setQuestion(''); setError(null)
  }, [fileName, sessionId])

  const isInputDisabled = loading

  // ── Core API call — shared by handleSubmit and handleSuggestion ────────────
  // Extracted so suggestion chips can submit a pre-set question directly
  // without going through React state (which is async).
  const submitQuestion = useCallback(async (q) => {
    if (!q || loading) return

    setLoading(true)
    setError(null)
    setMessages((m) => [...m, stampMsg({ type: 'user', text: q })])

    try {
      let res, data

      if (!sessionId) {
        // First question — create a session and upload the dataset
        const payload = buildPayload()
        res = await fetchWithTimeout(`${BACKEND}/api/session`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question: q, payload,
            agg_rows:    aggRows    || [],
            widget_rows: widgetRows || [],
            agent: 'auto',
          }),
        })
        data = await res.json()
        if (res.ok && data.session_id) setSessionId(data.session_id)
      } else {
        // Follow-up — no re-upload needed, session holds the dataset
        res = await fetchWithTimeout(`${BACKEND}/api/session/${sessionId}/continue`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q, agent: 'auto' }),
        })
        data = await res.json()
      }

      if (!res.ok) {
        setError(data.error || data.message || `Server error ${res.status}`)
        setMessages((m) => m.slice(0, -1))
        return
      }

      setMessages((m) => [...m, stampMsg({ type: 'response', data })])
    } catch (err) {
      setError(
        err.name === 'AbortError'
          ? 'The backend took too long to respond (over 60s). It may be overloaded — try again.'
          : err.message.includes('fetch')
            ? 'Cannot reach backend — is the server running on port 5000?'
            : err.message,
      )
      setMessages((m) => m.slice(0, -1))
    } finally {
      setLoading(false)
    }
  }, [loading, sessionId, buildPayload, aggRows, widgetRows])

  // ── Submit from the text input ─────────────────────────────────────────────
  const handleSubmit = useCallback(async (e) => {
    e?.preventDefault()
    const q = question.trim()
    if (!q) return
    setQuestion('')
    submitQuestion(q)
  }, [question, submitQuestion])

  // ── Suggestion chip clicked — submit the pre-set question ─────────────────
  const handleSuggestion = useCallback((suggestedQuestion) => {
    submitQuestion(suggestedQuestion)
  }, [submitQuestion])

  const handleKeyDown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit() } }

  const handleClear = async () => {
    if (sessionId) {
      try { await fetchWithTimeout(`${BACKEND}/api/session/${sessionId}`, { method: 'DELETE' }, 10000) }
      catch (_) { /* best-effort */ }
    }
    setMessages([]); setSessionId(null); setQuestion(''); setError(null)
  }

  const isEmpty = messages.length === 0 && !loading && !error

  // Data sources a ```chart directive in an answer can resolve against.
  const chartData = useMemo(
    () => ({ aggRows, rows, headers, widgetRows }),
    [aggRows, rows, headers, widgetRows],
  )

  return (
    <div
      className={`ai-chat-page${isOpen ? ' ai-chat-page--open' : ''}`}
      role="dialog"
      aria-label="AI Assistant"
      aria-modal="true"
    >
      {/* ── Header ── */}
      <div className="ai-chat-header">
        <div className="ai-chat-header-title">
          {/* Chat bubble icon */}
          <svg className="ai-chat-header-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            <circle cx="9"  cy="10" r="0.4" fill="currentColor" stroke="none"/>
            <circle cx="12" cy="10" r="0.4" fill="currentColor" stroke="none"/>
            <circle cx="15" cy="10" r="0.4" fill="currentColor" stroke="none"/>
          </svg>
          AI Assistant
        </div>

        <div className="ai-chat-header-actions">
          {messages.length > 0 && (
            <button type="button" className="ai-chat-clear-btn" onClick={handleClear} disabled={loading}>
              Clear history
            </button>
          )}
          <button type="button" className="ai-chat-close-btn" onClick={onClose}>
            <svg className="ai-chat-close-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
            Close
          </button>
        </div>
      </div>

      {/* ── Messages body ── */}
      <div className="ai-chat-body" ref={bodyRef}>
        <div className="ai-chat-messages">

          {/* Empty / welcome state */}
          {isEmpty && (
            <div className="ai-chat-empty">
              <div className="ai-chat-empty-icon">💬</div>
              <h3>Ask anything about your data</h3>
              <p className="ai-chat-empty-sub">
                Ask a question and the assistant analyzes your data and answers directly.
              </p>
              <div className="ai-chat-empty-prompts">
                {EXAMPLE_PROMPTS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="ai-chat-empty-prompt"
                    onClick={() => handleSuggestion(p)}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Flat message list */}
          <ChartDataContext.Provider value={chartData}>
          {messages.map((msg, idx) => {
            const isLastResponse = msg.type === 'response' && idx === messages.length - 1
            if (msg.type === 'user') return (
              <div key={msg.id} className="ai-chat-message ai-chat-message--user">
                <div className="ai-chat-bubble">{msg.text}</div>
              </div>
            )
            if (msg.type === 'response') return (
              <div key={msg.id} ref={isLastResponse ? lastResponseRef : null} className="ai-chat-message ai-chat-message--ai">
                <AiResponseBody response={msg.data} />
                {msg.data.next_steps?.length > 0 && (
                  <NextSteps
                    steps={msg.data.next_steps}
                    onSelect={handleSuggestion}
                    disabled={isInputDisabled}
                  />
                )}
              </div>
            )
            return null
          })}
          </ChartDataContext.Provider>

          {/* Loading indicator */}
          {loading && (
            <div className="ai-chat-loading">
              <div className="ai-chat-loading-dots"><span/><span/><span/></div>
              Analyzing your data…
            </div>
          )}

          {/* Error banner */}
          {error && (
            <div className="ai-chat-message ai-chat-message--error">
              <div className="ai-chat-bubble"><strong>Error:</strong> {error}</div>
            </div>
          )}

          {/* Scroll anchor */}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* ── Input footer ── */}
      <div className="ai-chat-footer">
        <form className="ai-chat-input-form" onSubmit={handleSubmit}>
          <textarea
            ref={inputRef}
            className="ai-chat-input"
            placeholder="Ask about anomalies, KPIs, users, stories… (Enter to send)"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            disabled={isInputDisabled}
            aria-label="Question"
          />
          <button
            type="submit"
            className="ai-chat-send-btn"
            disabled={isInputDisabled || !question.trim()}
          >
            {loading ? 'Thinking…' : 'Ask'}
          </button>
        </form>
      </div>
    </div>
  )
}

// ── Next-step suggestions ─────────────────────────────────────────────────────

function NextSteps({ steps, onSelect, disabled }) {
  return (
    <div className="ai-chat-next-steps">
      <p className="ai-chat-next-steps-label">What would you like to explore next?</p>
      <div className="ai-chat-next-steps-chips">
        {steps.map((s, i) => (
          <button
            key={i}
            type="button"
            className="ai-chat-next-step-chip"
            onClick={() => onSelect(s.question)}
            disabled={disabled}
            title={s.question}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="ai-chat-next-steps-hint">or type your own question below</p>
    </div>
  )
}


// ── AI response body ──────────────────────────────────────────────────────────

function AiResponseBody({ response }) {
  const badge = response.intent
    ? response.intent.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : null
  // Coerce to an array before .length / .map — session_notes may arrive as a
  // truthy non-array (string/object) from a malformed agent output (FM6).
  const notes = Array.isArray(response.session_notes)
    ? response.session_notes
    : Array.isArray(response.notes)
      ? response.notes
      : []
  return (
    <div className="ai-chat-bubble">
      {badge && <div className="ai-chat-intent-badge">{badge}</div>}
      {response.status === 'not_configured'
        ? (
          <div className="ai-chat-not-configured">
            <strong>Backend not connected.</strong>
            <p>Paste the <code>call_llm()</code> implementation from <code>backend/README.md</code> into <code>backend/llm.py</code>, then set <code>AI_CORE_URL</code> and <code>AI_CORE_TOKEN</code> in <code>backend/.env</code>.</p>
          </div>
        )
        : <MarkdownResponse text={response.response_text || response.text || ''} />
      }
      {notes.length > 0 && (
        <details className="ai-chat-notes">
          <summary>Agent observations ({notes.length})</summary>
          {notes.map((n, i) => (
            <div key={i} className={`ai-chat-note ai-chat-note--${n.significance || 'medium'}`}>
              <span className="ai-chat-note-agent">{n.agent}</span>
              {n.observation}
            </div>
          ))}
        </details>
      )}
    </div>
  )
}

function MarkdownResponse({ text }) {
  if (!text) return null
  const lines = text.split('\n'); const blocks = []; let tableLines = []; let inCode = false; let codeLines = []; let fenceTag = ''
  const flushTable = () => { if (tableLines.length) { blocks.push({ type: 'table', lines: [...tableLines] }); tableLines = [] } }
  // A fenced block tagged `chart` becomes a chart directive; every other fence
  // (tagged or not) stays a plain code block, so existing output is unchanged.
  const flushCode  = () => {
    if (fenceTag === 'chart') blocks.push({ type: 'chart', raw: codeLines.join('\n') })
    else if (codeLines.length) blocks.push({ type: 'code', lines: [...codeLines] })
    codeLines = []; inCode = false; fenceTag = ''
  }
  for (const line of lines) {
    if (line.startsWith('```')) { if (inCode) { flushCode(); continue } flushTable(); inCode = true; fenceTag = line.slice(3).trim().toLowerCase(); continue }
    if (inCode) { codeLines.push(line); continue }
    if (line.trim().startsWith('|')) { tableLines.push(line); continue }
    flushTable()
    if      (line.startsWith('### ')) blocks.push({ type: 'h3', text: line.slice(4) })
    else if (line.startsWith('## '))  blocks.push({ type: 'h2', text: line.slice(3) })
    else if (line.startsWith('# '))   blocks.push({ type: 'h1', text: line.slice(2) })
    else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) blocks.push({ type: 'hr' })
    else if (line.startsWith('> '))   blocks.push({ type: 'quote', text: line.slice(2) })
    else if (/^\s*\d+\.\s+/.test(line)) blocks.push({ type: 'oli', text: line.replace(/^\s*\d+\.\s+/, '') })
    else if (line.startsWith('- ') || line.startsWith('* ')) blocks.push({ type: 'uli', text: line.slice(2) })
    else if (line.trim() === '')      blocks.push({ type: 'br' })
    else                              blocks.push({ type: 'p',  text: line })
  }
  flushTable(); if (inCode) flushCode()

  // Group consecutive list / quote lines into their wrapping element: a bare
  // <li> outside a <ul>/<ol> is invalid HTML (FM2), and ordered lists,
  // blockquotes and horizontal rules now render at all (FM7).
  const out = []
  for (let i = 0; i < blocks.length; ) {
    const b = blocks[i]
    if (b.type === 'uli' || b.type === 'oli' || b.type === 'quote') {
      const kind = b.type
      const items = []
      while (i < blocks.length && blocks[i].type === kind) { items.push(blocks[i]); i++ }
      out.push({ type: kind === 'uli' ? 'ul' : kind === 'oli' ? 'ol' : 'quote', items })
    } else {
      out.push(b); i++
    }
  }

  return (
    <div className="ai-chat-markdown">
      {out.map((b, i) => {
        if (b.type === 'h1')    return <h1 key={i}>{ri(b.text)}</h1>
        if (b.type === 'h2')    return <h2 key={i}>{ri(b.text)}</h2>
        if (b.type === 'h3')    return <h3 key={i}>{ri(b.text)}</h3>
        if (b.type === 'hr')    return <hr key={i} />
        if (b.type === 'br')    return <br key={i} />
        if (b.type === 'code')  return <pre key={i} className="ai-chat-code"><code>{b.lines.join('\n')}</code></pre>
        if (b.type === 'chart') return <ChartBlock key={i} raw={b.raw} />
        if (b.type === 'table') return <MdTable key={i} lines={b.lines} />
        if (b.type === 'ul')    return <ul key={i} className="ai-chat-md-list">{b.items.map((it, j) => <li key={j}>{ri(it.text)}</li>)}</ul>
        if (b.type === 'ol')    return <ol key={i} className="ai-chat-md-list">{b.items.map((it, j) => <li key={j}>{ri(it.text)}</li>)}</ol>
        if (b.type === 'quote') return <blockquote key={i} className="ai-chat-md-quote">{b.items.map((it, j) => <p key={j}>{ri(it.text)}</p>)}</blockquote>
        return <p key={i}>{ri(b.text)}</p>
      })}
    </div>
  )
}

function ri(text) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2,-2)}</strong>
    if (p.startsWith('`')  && p.endsWith('`'))  return <code   key={i}>{p.slice(1,-1)}</code>
    return p
  })
}

function MdTable({ lines }) {
  const rows = lines.filter((l) => !l.match(/^\s*\|[-:| ]+\|\s*$/)).map((l) => l.replace(/^\||\|$/g,'').split('|').map((c) => c.trim()))
  if (!rows.length) return null
  const [head, ...body] = rows
  const cols = head.length
  // Normalise ragged rows to the header column count — pad short rows, drop
  // overflow — so an uneven agent-emitted row can't collapse or spill the grid (FH4).
  const fit = (row) => {
    const r = row.slice(0, cols)
    while (r.length < cols) r.push('')
    return r
  }
  return (
    <div className="ai-chat-table-wrap">
      <table className="ai-chat-md-table">
        <thead><tr>{head.map((c,i) => <th key={i}>{ri(c)}</th>)}</tr></thead>
        <tbody>{body.map((row,ri_) => <tr key={ri_}>{fit(row).map((c,ci) => <td key={ci}>{ri(c)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}





