import { useState, useRef, useCallback } from 'react'

const FileIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
  </svg>
)
const AttachIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
  </svg>
)
const SendIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
  </svg>
)
const StopIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <rect x="4" y="4" width="16" height="16" rx="2"/>
  </svg>
)
const RefreshIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ marginRight: 5 }}>
    <polyline points="23 4 23 10 17 10"/>
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
  </svg>
)

export default function MessageInput({
  streaming, attachments, uploading,
  onSend, onStop, onRegenerate, onFileSelect, onRemoveAttachment,
  showRegenerate, inputRef
}) {
  // Local input state — typing only re-renders THIS component
  const [input, setInput] = useState('')
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)

  const handleKeyDown = useCallback(e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [input, attachments])

  const autoResize = useCallback(e => {
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }, [])

  function handleSend() {
    const content = input.trim()
    if ((!content && attachments.length === 0) || streaming) return
    setInput('')
    // Reset textarea height after clearing
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    onSend(content)
  }

  const canSend = input.trim() || attachments.length > 0

  return (
    <div style={styles.inputWrap}>
      {showRegenerate && (
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
          <button style={styles.regenBtn} onClick={onRegenerate}>
            <RefreshIcon /> Regenerate
          </button>
        </div>
      )}
      {attachments.length > 0 && (
        <div style={styles.imagePreviews}>
          {attachments.map(att => (
            <div key={att.filename} style={styles.previewItem}>
              {att.kind === 'image'
                ? <img src={`/api/uploads/${att.filename}`} alt="" style={styles.previewImg} />
                : <div style={styles.previewFile}>
                    <FileIcon />
                    <span style={styles.previewFileName}>{att.originalName.length > 14 ? att.originalName.slice(0, 12) + '…' : att.originalName}</span>
                  </div>
              }
              <button style={styles.previewRemove} onClick={() => onRemoveAttachment(att.filename)}>✕</button>
            </div>
          ))}
        </div>
      )}
      <div style={styles.inputRow}>
        <input type="file" accept="image/*,.txt,.md,.csv,.json,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.hpp,.sh,.bash,.yml,.yaml,.toml,.ini,.conf,.log,.sql,.php,.swift,.kt,.pdf,.zip,.tar,.gz,.7z,.rar,.docx,.xlsx,.xls,.pptx" multiple ref={fileInputRef} onChange={onFileSelect} style={{ display: 'none' }} />
        <button
          style={{ ...styles.attachBtn, opacity: uploading ? 0.5 : 1 }}
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || streaming}
          title="Attach image"
        >
          <AttachIcon />
        </button>
        <textarea
          ref={el => {
            // Beide Refs setzen: lokal + Parent (fuer Fokus nach Streaming-Ende).
            // Vorher wurde inputRef waehrend des Renders mutiert — beim ersten Render noch null.
            textareaRef.current = el
            if (inputRef) inputRef.current = el
          }}
          style={styles.textarea}
          value={input}
          onChange={e => { setInput(e.target.value); autoResize(e) }}
          onKeyDown={handleKeyDown}
          placeholder="Type your message…"
          rows={1}
          disabled={streaming}
        />
        {streaming ? (
          <button style={styles.stopBtn} onClick={onStop} title="Stop">
            <StopIcon />
          </button>
        ) : (
          <button
            style={{ ...styles.sendBtn, opacity: canSend ? 1 : 0.4 }}
            onClick={handleSend}
            disabled={!canSend}
          >
            <SendIcon />
          </button>
        )}
      </div>
      <p style={styles.hint}>Enter to send · Shift+Enter for newline</p>
    </div>
  )
}

const styles = {
  inputWrap: {
    padding: '12px 16px 10px', borderTop: '1px solid var(--border)',
    background: 'var(--bg2)', flexShrink: 0
  },
  inputRow: { display: 'flex', gap: 10, alignItems: 'flex-end' },
  textarea: {
    flex: 1, padding: '12px 14px', resize: 'none',
    borderRadius: 12, lineHeight: 1.5, fontSize: 16,
    maxHeight: 160, overflowY: 'auto',
    border: '1px solid var(--border)',
    transition: 'border-color var(--transition)'
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 12, flexShrink: 0,
    background: 'var(--accent)', color: 'var(--user-text, #0d0d0d)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', cursor: 'pointer', transition: 'opacity var(--transition)'
  },
  stopBtn: {
    width: 44, height: 44, borderRadius: 12, flexShrink: 0,
    background: 'var(--danger)', color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', cursor: 'pointer'
  },
  regenBtn: {
    display: 'flex', alignItems: 'center',
    padding: '6px 14px', borderRadius: 8, fontSize: 12,
    color: 'var(--text2)', border: '1px solid var(--border)',
    background: 'var(--bg3)', cursor: 'pointer',
    fontFamily: 'var(--font-sans)', transition: 'color var(--transition)'
  },
  attachBtn: {
    width: 44, height: 44, borderRadius: 12, flexShrink: 0,
    background: 'var(--bg3)', color: 'var(--text2)',
    border: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', transition: 'color var(--transition)'
  },
  imagePreviews: {
    display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap'
  },
  previewItem: { position: 'relative' },
  previewImg: {
    width: 60, height: 60, objectFit: 'cover',
    borderRadius: 8, border: '1px solid var(--border)'
  },
  previewFile: {
    width: 100, height: 60, borderRadius: 8,
    border: '1px solid var(--border)', background: 'var(--bg3)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    color: 'var(--text2)', padding: 4, gap: 4
  },
  previewFileName: {
    fontSize: 10, fontFamily: 'var(--font-mono)',
    color: 'var(--text2)', textAlign: 'center',
    maxWidth: '100%', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis'
  },
  previewRemove: {
    position: 'absolute', top: -6, right: -6,
    width: 20, height: 20, borderRadius: '50%',
    background: 'var(--danger)', color: '#fff',
    fontSize: 11, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', padding: 0
  },
  hint: { fontSize: 11, color: 'var(--text3)', marginTop: 6, textAlign: 'center' }
}