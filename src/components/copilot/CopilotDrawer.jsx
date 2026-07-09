import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { MessageSquare, X, PictureInPicture2, PanelRightClose } from 'lucide-react'
import { useCsvData } from '../../context/useCsvData'
import { runAgent } from '../../lib/copilot/agent'
import { buildSchemaSummary } from '../../lib/copilot/schemaSummary'
import MessageList from './MessageList'
import ChatInput from './ChatInput'
import FileContextPanel from './FileContextPanel'
import './CopilotDrawer.css'

const MIN_WIDTH = 340
const MAX_WIDTH = 720
const DEFAULT_WIDTH = 480

// Floating window bounds. Max is the viewport minus a margin so edges stay grabbable.
const MIN_W = 340
const MIN_H = 320
const EDGE_MARGIN = 8

function clampDockWidth(w) {
  return w >= MIN_WIDTH && w <= MAX_WIDTH ? w : DEFAULT_WIDTH
}

// Pull a floating geometry into the current viewport: cap size to the viewport and
// nudge position so at least the header stays reachable (recovers offscreen saves).
function clampGeom(g) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.max(MIN_W, Math.min(g.w, vw - EDGE_MARGIN * 2))
  const h = Math.max(MIN_H, Math.min(g.h, vh - EDGE_MARGIN * 2))
  const x = Math.max(EDGE_MARGIN - w + 80, Math.min(g.x, vw - 80))
  const y = Math.max(EDGE_MARGIN, Math.min(g.y, vh - 48))
  return { x, y, w, h }
}

function loadFloatGeom() {
  try {
    const raw = JSON.parse(localStorage.getItem('copilot-float'))
    if (raw && ['x', 'y', 'w', 'h'].every((k) => typeof raw[k] === 'number')) {
      return clampGeom(raw)
    }
  } catch { /* ignore malformed */ }
  return null
}

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

  // Docked width (right-anchored drawer).
  const [width, setWidth] = useState(() => clampDockWidth(Number(localStorage.getItem('copilot-width'))))
  // 'docked' | 'floating'
  const [mode, setMode] = useState(() => (localStorage.getItem('copilot-mode') === 'floating' ? 'floating' : 'docked'))
  // Floating geometry {x,y,w,h}; lazily seeded when first popped out.
  const [geom, setGeom] = useState(() => loadFloatGeom() || { x: 0, y: 0, w: DEFAULT_WIDTH, h: 560 })

  const floating = mode === 'floating'

  // Mirror latest values for the global pointer handlers (avoids stale closures —
  // same reason the original edge-resize kept a widthRef).
  const widthRef = useRef(width)
  const geomRef = useRef(geom)
  useEffect(() => { widthRef.current = width }, [width])
  useEffect(() => { geomRef.current = geom }, [geom])

  useEffect(() => { localStorage.setItem('copilot-mode', mode) }, [mode])

  // A single ref describes the in-progress drag: dock-resize, float-move, or float-resize.
  //   { kind: 'dock' } | { kind: 'move', startX, startY, startGeom }
  //   { kind: 'resize', dir, startX, startY, startGeom }
  const dragRef = useRef(null)

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current
      if (!d) return

      if (d.kind === 'dock') {
        const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - e.clientX))
        setWidth(next)
        return
      }

      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      const vw = window.innerWidth
      const vh = window.innerHeight

      if (d.kind === 'move') {
        const w = d.startGeom.w
        // Keep the header reachable: never fully off any edge.
        const x = Math.max(EDGE_MARGIN - w + 80, Math.min(d.startGeom.x + dx, vw - 80))
        const y = Math.max(EDGE_MARGIN, Math.min(d.startGeom.y + dy, vh - 48))
        setGeom({ ...d.startGeom, x, y })
        return
      }

      // kind === 'resize'
      let { x, y, w, h } = d.startGeom
      const { dir } = d
      const maxW = vw - EDGE_MARGIN * 2
      const maxH = vh - EDGE_MARGIN * 2

      if (dir.includes('e')) {
        w = Math.max(MIN_W, Math.min(d.startGeom.w + dx, maxW - x))
      }
      if (dir.includes('s')) {
        h = Math.max(MIN_H, Math.min(d.startGeom.h + dy, maxH - y))
      }
      if (dir.includes('w')) {
        const right = d.startGeom.x + d.startGeom.w
        const nx = Math.min(Math.max(EDGE_MARGIN, d.startGeom.x + dx), right - MIN_W)
        w = right - nx
        x = nx
      }
      if (dir.includes('n')) {
        const bottom = d.startGeom.y + d.startGeom.h
        const ny = Math.min(Math.max(EDGE_MARGIN, d.startGeom.y + dy), bottom - MIN_H)
        h = bottom - ny
        y = ny
      }
      setGeom({ x, y, w, h })
    }

    const onUp = () => {
      const d = dragRef.current
      if (!d) return
      dragRef.current = null
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      if (d.kind === 'dock') {
        localStorage.setItem('copilot-width', String(widthRef.current))
      } else {
        localStorage.setItem('copilot-float', JSON.stringify(geomRef.current))
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  // Re-clamp a floating window if the viewport shrinks below it.
  useEffect(() => {
    if (!floating) return
    const onResize = () => setGeom((g) => clampGeom(g))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [floating])

  const startDockResize = useCallback((e) => {
    e.preventDefault()
    dragRef.current = { kind: 'dock' }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }, [])

  const startMove = useCallback((e) => {
    // Ignore drags that start on header buttons.
    if (e.target.closest('button')) return
    e.preventDefault()
    dragRef.current = { kind: 'move', startX: e.clientX, startY: e.clientY, startGeom: geomRef.current }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'move'
  }, [])

  const startResize = useCallback((dir) => (e) => {
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { kind: 'resize', dir, startX: e.clientX, startY: e.clientY, startGeom: geomRef.current }
    document.body.style.userSelect = 'none'
  }, [])

  const toggleFloat = useCallback(() => {
    setMode((m) => {
      if (m === 'docked') {
        // Pop out roughly where the docked drawer sits so it detaches in place.
        const w = widthRef.current
        const h = Math.min(window.innerHeight - EDGE_MARGIN * 2, 560)
        const seeded = clampGeom({ x: window.innerWidth - w - EDGE_MARGIN, y: EDGE_MARGIN * 4, w, h })
        setGeom(seeded)
        localStorage.setItem('copilot-float', JSON.stringify(seeded))
        return 'floating'
      }
      return 'docked'
    })
  }, [])

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
      <aside
        className={`copilot-drawer${open ? ' is-open' : ''}${floating ? ' is-floating' : ''}`}
        aria-hidden={!open}
        style={floating
          ? { left: `${geom.x}px`, top: `${geom.y}px`, width: `${geom.w}px`, height: `${geom.h}px` }
          : { width: `${width}px` }}
      >
        {!floating && (
          <div
            className="copilot-resize-handle"
            onPointerDown={startDockResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize copilot panel"
          />
        )}
        {floating && (
          <>
            <div className="copilot-rz copilot-rz-n" onPointerDown={startResize('n')} />
            <div className="copilot-rz copilot-rz-s" onPointerDown={startResize('s')} />
            <div className="copilot-rz copilot-rz-e" onPointerDown={startResize('e')} />
            <div className="copilot-rz copilot-rz-w" onPointerDown={startResize('w')} />
            <div className="copilot-rz copilot-rz-ne" onPointerDown={startResize('ne')} />
            <div className="copilot-rz copilot-rz-nw" onPointerDown={startResize('nw')} />
            <div className="copilot-rz copilot-rz-se" onPointerDown={startResize('se')} />
            <div className="copilot-rz copilot-rz-sw" onPointerDown={startResize('sw')} />
          </>
        )}
        <header className="copilot-header" onPointerDown={floating ? startMove : undefined}>
          <div className="copilot-title">
            <MessageSquare size={16} />
            <span>John's Brain</span>
          </div>
          <div className="copilot-header-actions">
            <button
              type="button"
              className="copilot-icon-btn"
              onClick={toggleFloat}
              aria-label={floating ? 'Dock copilot to side' : 'Pop out copilot'}
              title={floating ? 'Dock to side' : 'Pop out'}
            >
              {floating ? <PanelRightClose size={16} /> : <PictureInPicture2 size={16} />}
            </button>
            <button
              type="button"
              className="copilot-icon-btn"
              onClick={() => setOpen(false)}
              aria-label="Close copilot"
            >
              <X size={16} />
            </button>
          </div>
        </header>
        <FileContextPanel />
        <MessageList messages={messages} hasData={Boolean(rows?.length)} />
        {error && <div className="copilot-error">{error}</div>}
        <ChatInput onSend={send} busy={busy} onCancel={cancel} />
      </aside>
    </>
  )
}

export default CopilotDrawer
