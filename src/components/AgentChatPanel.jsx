/**
 * AgentChatPanel — HITL AI assistant chat panel.
 *
 * Every question goes through two explicit phases:
 *
 *   Phase 1 — Plan  (POST /api/session  or /api/session/<id>/continue)
 *     Classifies intent, returns a plan card. NO agents run at this stage.
 *
 *   Phase 2 — Execute  (POST /api/session/<id>/confirm)
 *     User clicks "Confirm". Agents run, results are rendered.
 *
 *   Reject  (POST /api/session/<id>/reject)
 *     User clicks "Reject". Pending turn is cleared; they can rephrase.
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
// list position — the plan → confirming → response swap replaces the last item
// in place, and index keys would let one component's state leak into the next.
let _msgSeq = 0
const stampMsg = (msg) => ({ id: `m${++_msgSeq}`, ...msg })

export default function AgentChatPanel({ buildPayload, aggRows, rows, headers, widgetRows, fileName, isOpen, onClose }) {
  // Flat message list. Each item: { type, text?, data? }
  // types: 'user' | 'plan' | 'confirming' | 'response' | 'rejected'
  const [messages,   setMessages]   = useState([])
  const [sessionId,  setSessionId]  = useState(null)
  const [question,   setQuestion]   = useState('')
  const [loading,    setLoading]    = useState(false)    // Phase 1: classifying
  const [confirming, setConfirming] = useState(false)   // Phase 2: executing
  const [error,      setError]      = useState(null)

  const inputRef  = useRef(null)
  const bottomRef = useRef(null)
  const bodyRef   = useRef(null)

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
  }, [messages.length, loading, confirming])

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

  // True when the last message is a plan card awaiting confirm/reject.
  // The input stays ENABLED while a plan is pending — typing a new question
  // is treated as an implicit rejection of that plan (see submitQuestion).
  const hasPendingPlan  = messages.at?.(-1)?.type === 'plan'
  const isInputDisabled = loading || confirming

  // ── Core API call — shared by handleSubmit and handleSuggestion ────────────
  // Extracted so suggestion chips can submit a pre-set question directly
  // without going through React state (which is async).
  const submitQuestion = useCallback(async (q) => {
    if (!q || loading || confirming) return

    // If a plan is awaiting confirmation and the user types a new question
    // instead of clicking Confirm/Reject, treat it as an implicit rejection:
    // clear the pending turn on the backend, mark the plan card rejected, then
    // submit the new question as a fresh turn.
    const rejectingPending = messages.at?.(-1)?.type === 'plan'
    if (rejectingPending && sessionId) {
      try {
        await fetchWithTimeout(`${BACKEND}/api/session/${sessionId}/reject`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
        }, 10000)
      } catch (_) { /* best-effort — plan_turn re-plans this session anyway */ }
    }

    setLoading(true)
    setError(null)
    setMessages((m) => {
      const base = m.at?.(-1)?.type === 'plan'
        ? [...m.slice(0, -1),
           stampMsg({ type: 'rejected', text: 'Plan rejected — asking a new question instead.' })]
        : m
      return [...base, stampMsg({ type: 'user', text: q })]
    })

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

      if (data.status === 'awaiting_confirmation') {
        setMessages((m) => [...m, stampMsg({ type: 'plan', data })])
      } else {
        setMessages((m) => [...m, stampMsg({ type: 'response', data })])
      }
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
  }, [loading, confirming, sessionId, buildPayload, aggRows, widgetRows, messages])

  // ── Phase 1: submit from the text input ────────────────────────────────────
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

  // ── Phase 2: execute the confirmed plan ───────────────────────────────────
  const handleConfirm = useCallback(async () => {
    if (!sessionId || confirming) return
    setConfirming(true)
    setError(null)
    // Capture the plan card before swapping it for the running indicator, so a
    // failed run can restore it — otherwise the plan is lost and the user has
    // no way to retry Confirm or Reject (FH3).
    let planMsg = null
    setMessages((m) => {
      if (m.at?.(-1)?.type === 'plan') planMsg = m.at(-1)
      return [...m.slice(0, -1), stampMsg({ type: 'confirming' })]
    })
    const restorePlan = () =>
      setMessages((m) => [...m.slice(0, -1), ...(planMsg ? [planMsg] : [])])
    try {
      const res  = await fetchWithTimeout(`${BACKEND}/api/session/${sessionId}/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || `Server error ${res.status}`)
        restorePlan()
        return
      }
      setMessages((m) => [...m.slice(0, -1), stampMsg({ type: 'response', data })])
    } catch (err) {
      setError(
        err.name === 'AbortError'
          ? 'The analysis took too long to respond (over 60s). You can try running it again.'
          : err.message,
      )
      restorePlan()
    } finally {
      setConfirming(false)
    }
  }, [sessionId, confirming])

  // ── Reject / cancel the pending plan ──────────────────────────────────────
  const handleReject = useCallback(async () => {
    if (sessionId) {
      try {
        await fetchWithTimeout(`${BACKEND}/api/session/${sessionId}/reject`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
        }, 10000)
      } catch (_) { /* best-effort */ }
    }
    setMessages((m) => [
      ...m.slice(0, -1),
      stampMsg({ type: 'rejected', text: 'Plan rejected. Ask a different question below.' }),
    ])
  }, [sessionId])

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
            <button type="button" className="ai-chat-clear-btn" onClick={handleClear} disabled={loading || confirming}>
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
                The assistant shows you a plan first — you confirm before any analysis runs.
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
          {messages.map((msg) => {
            if (msg.type === 'user') return (
              <div key={msg.id} className="ai-chat-message ai-chat-message--user">
                <div className="ai-chat-bubble">{msg.text}</div>
              </div>
            )
            if (msg.type === 'plan') return (
              <div key={msg.id} className="ai-chat-message ai-chat-message--ai">
                <PlanCard
                  data={msg.data}
                  onConfirm={handleConfirm}
                  onReject={handleReject}
                  disabled={confirming}
                />
              </div>
            )
            if (msg.type === 'confirming') return (
              <div key={msg.id} className="ai-chat-loading">
                <div className="ai-chat-loading-dots"><span/><span/><span/></div>
                Running agent pipeline…
              </div>
            )
            if (msg.type === 'response') return (
              <div key={msg.id} className="ai-chat-message ai-chat-message--ai">
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
            if (msg.type === 'rejected') return (
              <div key={msg.id} className="ai-chat-message ai-chat-message--ai">
                <div className="ai-chat-bubble ai-chat-bubble--rejected">{msg.text}</div>
              </div>
            )
            return null
          })}
          </ChartDataContext.Provider>

          {/* Phase 1 loading indicator */}
          {loading && (
            <div className="ai-chat-loading">
              <div className="ai-chat-loading-dots"><span/><span/><span/></div>
              Classifying intent…
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
        {hasPendingPlan && (
          <div className="ai-chat-awaiting-hint">
            Confirm or reject the plan above — or just type a new question to replace it.
          </div>
        )}
        <form className="ai-chat-input-form" onSubmit={handleSubmit}>
          <textarea
            ref={inputRef}
            className="ai-chat-input"
            placeholder={
              hasPendingPlan
                ? 'Type a new question to replace the plan above…'
                : 'Ask about anomalies, KPIs, users, stories… (Enter to send)'
            }
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
            {loading ? 'Thinking…' : confirming ? 'Running…' : 'Ask'}
          </button>
        </form>
      </div>
    </div>
  )
}

// ── Plan card ─────────────────────────────────────────────────────────────────

function PlanCard({ data, onConfirm, onReject, disabled }) {
  const { intent, acknowledgement, plan } = data || {}
  const badge = intent?.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  // The plan object (and its steps) can be missing or malformed if the backend
  // returns a partial payload — render what's present rather than crashing (FH1).
  const steps = Array.isArray(plan?.steps) ? plan.steps : []
  const calls = plan?.estimated_llm_calls
  return (
    <div className="ai-chat-plan-card">
      <div className="ai-chat-plan-header">
        {badge && <span className="ai-chat-intent-badge">{badge}</span>}
        {acknowledgement && <p className="ai-chat-plan-ack">{acknowledgement}</p>}
      </div>
      <div className="ai-chat-plan-body">
        {plan?.description && <p className="ai-chat-plan-desc">{plan.description}</p>}
        {steps.length > 0 && (
          <ol className="ai-chat-plan-steps">
            {steps.map((s, i) => (
              <li key={s.step ?? i} className="ai-chat-plan-step">
                <span className="ai-chat-plan-step-agents">{(s.agents || []).join(', ')}</span>
                <span className="ai-chat-plan-step-sep"> — </span>
                <span className="ai-chat-plan-step-desc">{s.description}</span>
              </li>
            ))}
          </ol>
        )}
        {typeof calls === 'number' && (
          <p className="ai-chat-plan-cost">
            Estimated: <strong>{calls} LLM {calls === 1 ? 'call' : 'calls'}</strong>
          </p>
        )}
      </div>
      <div className="ai-chat-plan-actions">
        <button type="button" className="ai-chat-confirm-btn" onClick={onConfirm} disabled={disabled}>
          {disabled ? 'Running…' : 'Confirm — Run analysis'}
        </button>
        <button type="button" className="ai-chat-reject-btn" onClick={onReject} disabled={disabled}>
          Reject — Rephrase
        </button>
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





