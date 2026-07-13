import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import api from '../lib/api.js'

export default function MemoryPanel({
  conversationId,
  streaming,
  onClose
}) {
  const [memory, setMemory] = useState('')
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  async function loadMemory() {
    setLoading(true)
    setError('')

    try {
      const data = await api.get('/api/memory')
      const nextMemory = data?.memory || ''
      setMemory(nextMemory)

      if (!editing) {
        setDraft(nextMemory)
      }
    } catch (err) {
      setError(err?.message || 'Memory konnte nicht geladen werden.')
    } finally {
      setLoading(false)
    }
  }

  async function updateMemory() {
    if (!conversationId || streaming) return

    setUpdating(true)
    setError('')

    try {
      const data = await api.post(
        `/api/memory/update/${conversationId}`,
        {}
      )

      if (typeof data?.memory === 'string') {
        setMemory(data.memory)
        setDraft(data.memory)
      } else {
        await loadMemory()
      }
    } catch (err) {
      setError(
        err?.message || 'Memory konnte nicht aktualisiert werden.'
      )
    } finally {
      setUpdating(false)
    }
  }

  function startEditing() {
    setDraft(memory)
    setEditing(true)
    setError('')
  }

  function cancelEditing() {
    setDraft(memory)
    setEditing(false)
    setError('')
  }

  async function saveMemory() {
    setSaving(true)
    setError('')

    try {
      const data = await api.post('/api/memory/save', {
        content: draft
      })

      setMemory(
        typeof data?.memory === 'string'
          ? data.memory
          : draft
      )
      setEditing(false)
    } catch (err) {
      setError(
        err?.message || 'Memory konnte nicht gespeichert werden.'
      )
    } finally {
      setSaving(false)
    }
  }

  async function clearMemory() {
    const confirmed = window.confirm(
      'Die gesamte User Memory wirklich löschen?'
    )

    if (!confirmed) return

    setDeleting(true)
    setError('')

    try {
      await api.delete('/api/memory')
      setMemory('')
      setDraft('')
      setEditing(false)
    } catch (err) {
      setError(
        err?.message || 'Memory konnte nicht gelöscht werden.'
      )
    } finally {
      setDeleting(false)
    }
  }

  useEffect(() => {
    loadMemory()
  }, [])

  const factCount = memory
    .split('\n')
    .filter(line => /^\s*[-*]\s+/.test(line))
    .length

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        background: 'rgba(0,0,0,0.68)',
        backdropFilter: 'blur(3px)'
      }}
    >
      <section
        onClick={event => event.stopPropagation()}
        style={{
          width: 'min(680px, 100%)',
          maxHeight: '82vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          border: '1px solid var(--border)',
          borderRadius: 14,
          background: 'var(--bg2)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.55)'
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 16px',
            borderBottom: '1px solid var(--border)'
          }}
        >
          <div style={{ flex: 1 }}>
            <strong
              style={{
                color: 'var(--text1)',
                fontFamily: 'var(--font-mono)'
              }}
            >
              User Memory
            </strong>

            <div
              style={{
                marginTop: 3,
                color: 'var(--text3)',
                fontSize: 11
              }}
            >
              {factCount > 0
                ? `${factCount} gespeicherte ${factCount === 1 ? 'Information' : 'Informationen'}`
                : 'Wird in Non-Agent-Chats in den Kontext eingefügt.'}
            </div>
          </div>

          {!editing && (
            <button
              type="button"
              onClick={startEditing}
              disabled={loading || updating || saving}
              title="Memory bearbeiten"
              style={{
                height: 34,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 10px',
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--bg3)',
                color: 'var(--text2)',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                cursor:
                  loading || updating || saving
                    ? 'not-allowed'
                    : 'pointer',
                opacity:
                  loading || updating || saving
                    ? 0.55
                    : 1
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" />
              </svg>
              Bearbeiten
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            style={{
              width: 34,
              height: 34,
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--bg3)',
              color: 'var(--text2)',
              fontSize: 20,
              cursor: 'pointer'
            }}
          >
            ×
          </button>
        </header>

        <div
          style={{
            minHeight: 220,
            flex: 1,
            overflowY: 'auto',
            padding: 16
          }}
        >
          {loading ? (
            <div style={{ color: 'var(--text3)' }}>
              Memory wird geladen …
            </div>
          ) : editing ? (
            <div>
              <textarea
                autoFocus
                value={draft}
                onChange={event => setDraft(event.target.value)}
                spellCheck
                aria-label="Memory bearbeiten"
                style={{
                  width: '100%',
                  minHeight: 340,
                  boxSizing: 'border-box',
                  resize: 'vertical',
                  padding: 14,
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  outline: 'none',
                  background: 'var(--bg3)',
                  color: 'var(--text1)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  lineHeight: 1.65
                }}
              />

              <div
                style={{
                  marginTop: 7,
                  textAlign: 'right',
                  color: 'var(--text3)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10
                }}
              >
                {draft.length.toLocaleString()} Zeichen
              </div>
            </div>
          ) : memory ? (
            <div
              style={{
                color: 'var(--text1)',
                fontSize: 13,
                lineHeight: 1.6,
                overflowWrap: 'anywhere'
              }}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ children }) => (
                    <h2
                      style={{
                        margin: '18px 0 8px',
                        paddingBottom: 7,
                        borderBottom: '1px solid var(--border)',
                        color: 'var(--accent)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: '0.04em'
                      }}
                    >
                      {children}
                    </h2>
                  ),

                  h2: ({ children }) => (
                    <h2
                      style={{
                        margin: '18px 0 8px',
                        paddingBottom: 7,
                        borderBottom: '1px solid var(--border)',
                        color: 'var(--accent)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: '0.04em'
                      }}
                    >
                      {children}
                    </h2>
                  ),

                  h3: ({ children }) => (
                    <h3
                      style={{
                        margin: '14px 0 7px',
                        color: 'var(--text2)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        fontWeight: 700
                      }}
                    >
                      {children}
                    </h3>
                  ),

                  ul: ({ children }) => (
                    <ul
                      style={{
                        margin: '4px 0 14px',
                        paddingLeft: 22
                      }}
                    >
                      {children}
                    </ul>
                  ),

                  ol: ({ children }) => (
                    <ol
                      style={{
                        margin: '4px 0 14px',
                        paddingLeft: 24
                      }}
                    >
                      {children}
                    </ol>
                  ),

                  li: ({ children }) => (
                    <li
                      style={{
                        margin: '7px 0',
                        paddingLeft: 3,
                        color: 'var(--text1)'
                      }}
                    >
                      {children}
                    </li>
                  ),

                  p: ({ children }) => (
                    <p
                      style={{
                        margin: '7px 0',
                        color: 'var(--text1)'
                      }}
                    >
                      {children}
                    </p>
                  ),

                  strong: ({ children }) => (
                    <strong
                      style={{
                        color: 'var(--text1)',
                        fontWeight: 700
                      }}
                    >
                      {children}
                    </strong>
                  ),

                  code: ({ children }) => (
                    <code
                      style={{
                        padding: '2px 5px',
                        borderRadius: 5,
                        background: 'var(--bg3)',
                        color: 'var(--accent)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.92em'
                      }}
                    >
                      {children}
                    </code>
                  )
                }}
              >
                {memory}
              </ReactMarkdown>
            </div>
          ) : (
            <div
              style={{
                padding: 30,
                textAlign: 'center',
                color: 'var(--text3)'
              }}
            >
              Noch keine Memory gespeichert.
            </div>
          )}

          {error && (
            <div
              style={{
                marginTop: 14,
                padding: 10,
                border: '1px solid var(--danger)',
                borderRadius: 8,
                color: 'var(--danger)',
                fontSize: 12
              }}
            >
              {error}
            </div>
          )}
        </div>

        <footer
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '12px 16px calc(12px + env(safe-area-inset-bottom))',
            borderTop: '1px solid var(--border)'
          }}
        >
          {editing ? (
            <>
              <button
                type="button"
                onClick={cancelEditing}
                disabled={saving}
                style={{
                  padding: '9px 12px',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  background: 'var(--bg3)',
                  color: 'var(--text2)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.55 : 1
                }}
              >
                Abbrechen
              </button>

              <button
                type="button"
                onClick={saveMemory}
                disabled={saving}
                style={{
                  padding: '9px 14px',
                  border: 0,
                  borderRadius: 8,
                  background: 'var(--accent)',
                  color: 'var(--user-text, #0d0d0d)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.55 : 1
                }}
              >
                {saving ? 'Speichere …' : 'Speichern'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={clearMemory}
                disabled={loading || updating || saving || deleting}
                style={{
                  marginRight: 'auto',
                  padding: '9px 12px',
                  border: '1px solid var(--danger)',
                  borderRadius: 8,
                  background: 'transparent',
                  color: 'var(--danger)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  cursor:
                    loading || updating || saving || deleting
                      ? 'not-allowed'
                      : 'pointer',
                  opacity:
                    loading || updating || saving || deleting
                      ? 0.55
                      : 1
                }}
              >
                {deleting ? 'Lösche …' : 'Memory löschen'}
              </button>

              <button
                type="button"
                onClick={loadMemory}
                disabled={loading || updating}
                style={{
                  padding: '9px 12px',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  background: 'var(--bg3)',
                  color: 'var(--text2)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  cursor:
                    loading || updating
                      ? 'not-allowed'
                      : 'pointer',
                  opacity: loading || updating ? 0.55 : 1
                }}
              >
                Neu laden
              </button>

              <button
                type="button"
                onClick={updateMemory}
                disabled={loading || updating || streaming}
                style={{
                  padding: '9px 14px',
                  border: 0,
                  borderRadius: 8,
                  background: 'var(--accent)',
                  color: 'var(--user-text, #0d0d0d)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor:
                    loading || updating || streaming
                      ? 'not-allowed'
                      : 'pointer',
                  opacity:
                    loading || updating || streaming
                      ? 0.55
                      : 1
                }}
              >
                {updating
                  ? 'Aktualisiere …'
                  : 'Memory aktualisieren'}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  )
}
