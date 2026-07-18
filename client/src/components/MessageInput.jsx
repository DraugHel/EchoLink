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
    <line x1="22" y1="2" x2="11" y2="13"/>
    <polygon points="22 2 15 22 11 13 2 9 22 2"/>
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
  streaming,
  attachments,
  uploading,
  onSend,
  onStop,
  onRegenerate,
  onFileSelect,
  onRemoveAttachment,
  showRegenerate,
  inputRef
}) {
  const [input, setInput] = useState('')
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)

  const handleKeyDown = useCallback(event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSend()
    }
  }, [input, attachments])

  const autoResize = useCallback(event => {
    const element = event.target
    element.style.height = 'auto'
    element.style.height =
      Math.min(element.scrollHeight, 160) + 'px'
  }, [])

  function handleSend() {
    const content = input.trim()

    if (!content && attachments.length === 0) return

    setInput('')

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    onSend(content)
  }

  const canSend =
    input.trim() || attachments.length > 0

  return (
    <div
      className="echolink-composer"
      style={styles.inputWrap}
    >
      {showRegenerate && (
        <div
          className="echolink-composer-regenerate"
          style={styles.regenerateWrap}
        >
          <button
            type="button"
            style={styles.regenBtn}
            onClick={onRegenerate}
          >
            <RefreshIcon /> Neu erzeugen
          </button>
        </div>
      )}

      {attachments.length > 0 && (
        <div
          className="echolink-composer-previews"
          style={styles.imagePreviews}
        >
          {attachments.map(attachment => (
            <div
              key={attachment.filename}
              style={styles.previewItem}
            >
              {attachment.kind === 'image' ? (
                <img
                  src={`/api/uploads/${attachment.filename}`}
                  alt=""
                  style={styles.previewImg}
                />
              ) : (
                <div style={styles.previewFile}>
                  <FileIcon />
                  <span style={styles.previewFileName}>
                    {attachment.originalName.length > 14
                      ? attachment.originalName.slice(0, 12) + '…'
                      : attachment.originalName}
                  </span>
                </div>
              )}

              <button
                type="button"
                style={styles.previewRemove}
                onClick={() =>
                  onRemoveAttachment(
                    attachment.filename
                  )
                }
                title="Anhang entfernen"
                aria-label="Anhang entfernen"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className="echolink-composer-row"
        style={styles.inputRow}
      >
        <input
          type="file"
          accept="image/*,.txt,.md,.csv,.json,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.hpp,.sh,.bash,.yml,.yaml,.toml,.ini,.conf,.log,.sql,.php,.swift,.kt,.pdf,.zip,.tar,.gz,.7z,.rar,.docx,.xlsx,.xls,.pptx"
          multiple
          ref={fileInputRef}
          onChange={onFileSelect}
          style={{ display: 'none' }}
        />

        <button
          type="button"
          className="echolink-composer-attach"
          style={{
            ...styles.attachBtn,
            opacity: uploading ? 0.5 : 1
          }}
          onClick={() =>
            fileInputRef.current?.click()
          }
          disabled={uploading}
          title="Datei anhängen"
          aria-label="Datei anhängen"
        >
          <AttachIcon />
        </button>

        <textarea
          className="echolink-composer-textarea"
          ref={element => {
            textareaRef.current = element
            if (inputRef) inputRef.current = element
          }}
          style={styles.textarea}
          value={input}
          onChange={event => {
            setInput(event.target.value)
            autoResize(event)
          }}
          onKeyDown={handleKeyDown}
          placeholder={
            streaming
              ? 'Antwort unterbrechen …'
              : 'Nachricht schreiben …'
          }
          rows={1}
        />

        {streaming && !canSend ? (
          <button
            type="button"
            className="echolink-composer-stop"
            style={styles.stopBtn}
            onClick={onStop}
            title="Antwort stoppen"
            aria-label="Antwort stoppen"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            className="echolink-composer-send"
            style={{
              ...styles.sendBtn,
              opacity: canSend ? 1 : 0.4
            }}
            onClick={handleSend}
            disabled={!canSend}
            title={
              streaming
                ? 'Senden und aktuelle Antwort unterbrechen'
                : 'Senden'
            }
            aria-label="Nachricht senden"
          >
            <SendIcon />
          </button>
        )}
      </div>

      <p
        className="echolink-composer-hint"
        style={styles.hint}
      >
        {streaming
          ? 'Tippen und senden unterbricht die aktuelle Antwort · oder Stop drücken'
          : 'Enter sendet · Shift+Enter fügt eine neue Zeile ein'}
      </p>
    </div>
  )
}

const styles = {
  inputWrap: {
    width: '100%',
    maxWidth: 820,
    margin: '0 auto',
    boxSizing: 'border-box',
    padding:
      '9px 12px calc(8px + env(safe-area-inset-bottom))',
    borderTop: '1px solid var(--border)',
    background: 'var(--bg2)',
    flexShrink: 0
  },
  regenerateWrap: {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: 6
  },
  inputRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-end'
  },
  textarea: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    boxSizing: 'border-box',
    padding: '10px 12px',
    resize: 'none',
    borderRadius: 12,
    lineHeight: 1.45,
    fontSize: 16,
    maxHeight: 160,
    overflowY: 'auto',
    border: '1px solid var(--border)',
    transition: 'border-color var(--transition)'
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    flexShrink: 0,
    background: 'var(--accent)',
    color: 'var(--user-text, #0d0d0d)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    cursor: 'pointer',
    transition: 'opacity var(--transition)'
  },
  stopBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    flexShrink: 0,
    background: 'var(--danger)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    cursor: 'pointer'
  },
  regenBtn: {
    display: 'flex',
    alignItems: 'center',
    padding: '5px 12px',
    borderRadius: 999,
    fontSize: 11,
    color: 'var(--text2)',
    border: '1px solid var(--border)',
    background: 'var(--bg3)',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
    transition: 'color var(--transition)'
  },
  attachBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    flexShrink: 0,
    background: 'var(--bg3)',
    color: 'var(--text2)',
    border: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'color var(--transition)'
  },
  imagePreviews: {
    display: 'flex',
    gap: 8,
    marginBottom: 7,
    overflowX: 'auto',
    overflowY: 'visible',
    paddingTop: 6,
    paddingRight: 6
  },
  previewItem: {
    position: 'relative',
    flexShrink: 0
  },
  previewImg: {
    width: 56,
    height: 56,
    objectFit: 'cover',
    borderRadius: 8,
    border: '1px solid var(--border)'
  },
  previewFile: {
    width: 96,
    height: 56,
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg3)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text2)',
    padding: 4,
    gap: 3
  },
  previewFileName: {
    maxWidth: '100%',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    color: 'var(--text2)',
    fontFamily: 'var(--font-mono)',
    fontSize: 9,
    textAlign: 'center'
  },
  previewRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: '50%',
    background: 'var(--danger)',
    color: '#fff',
    fontSize: 13,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    padding: 0
  },
  hint: {
    margin: '5px 0 0',
    color: 'var(--text3)',
    fontSize: 10,
    textAlign: 'center'
  }
}
