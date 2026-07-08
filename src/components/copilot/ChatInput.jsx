import { useState } from 'react'
import { Send, Square } from 'lucide-react'

function ChatInput({ onSend, busy, onCancel }) {
  const [text, setText] = useState('')

  const submit = (e) => {
    e.preventDefault()
    if (busy || !text.trim()) return
    onSend(text)
    setText('')
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      submit(e)
    }
  }

  return (
    <form className="copilot-input" onSubmit={submit}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask about the loaded data…"
        rows={2}
        disabled={busy}
      />
      {busy ? (
        <button type="button" className="copilot-send is-cancel" onClick={onCancel} aria-label="Stop">
          <Square size={14} />
        </button>
      ) : (
        <button type="submit" className="copilot-send" disabled={!text.trim()} aria-label="Send">
          <Send size={14} />
        </button>
      )}
    </form>
  )
}

export default ChatInput
